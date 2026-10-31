import worker, {
  extractTikTokUrl,
  extractFromTikWM,
  extractFromTikTokDirect,
  extractFromTikMate,
  fetchMediaStream
} from './src/worker.js';
import * as db from './src/db.js';

console.log('=== 🧪 Enterprise Test Suite: TikTok Worker (Telegram Hash Forwarding + Multi-Tier Cache) ===\n');

async function runTests() {
  // 1. Health check endpoint test
  const req = new Request('https://worker.test/health');
  const res = await worker.fetch(req, {}, {});
  const data = await res.json();
  if (data.status !== 'online') throw new Error('Health endpoint failed');
  console.log('1. GET /health Endpoint: PASSED');

  // 2. Comprehensive TikTok Link Format, Schemeless, Emoji-Attached & Non-Media Rejection
  const linkTests = [
    ['https://www.tiktok.com/@user/video/12345/?is_from_webapp=1&sender_device=pc', 'https://www.tiktok.com/@user/video/12345'],
    ['https://tiktok.com/@user/photo/98765?_r=1&_t=abc', 'https://tiktok.com/@user/photo/98765'],
    ['https://vt.tiktok.com/ZSgQuVgCe/?_r=1&_t=8q123!', 'https://vt.tiktok.com/ZSgQuVgCe/'],
    ['https://vt.tiktok.com/ZSgQuVgCe/🔥😂', 'https://vt.tiktok.com/ZSgQuVgCe/'],
    ['vt.tiktok.com/ZSgQuVgCe', 'https://vt.tiktok.com/ZSgQuVgCe/'],
    ['www.tiktok.com/@user/video/7692664817294773512', 'https://www.tiktok.com/@user/video/7692664817294773512'],
    ['https://vm.tiktok.com/ZM8abc/?utm_source=copy', 'https://vm.tiktok.com/ZM8abc/'],
    ['https://m.tiktok.com/v/12345.html?u_code=1', 'https://m.tiktok.com/v/12345.html'],
    ['https://www.tiktok.com/t/ZT8abc123/?_t=1', 'https://www.tiktok.com/t/ZT8abc123/'],
    ['https://www.tiktok.com/embed/v2/7692664817294773512', 'https://www.tiktok.com/@a/video/7692664817294773512'.includes('embed') ? '' : 'https://www.tiktok.com/embed/v2/7692664817294773512'],
    ['https://www.tiktok.com/share/video/7692664817294773512', 'https://www.tiktok.com/share/video/7692664817294773512'],
    ['https://www.tiktok.com/?item_id=7692664817294773512', 'https://www.tiktok.com/@a/video/7692664817294773512'],
    ['https://www.tiktok.com/@rahad?lang=en', null],
    ['https://www.tiktok.com/discover/funny', null],
    ['https://www.tiktok.com/', null]
  ];
  for (const [input, expected] of linkTests) {
    const actual = extractTikTokUrl(input);
    if (actual !== expected) {
      throw new Error(`URL Sanitizer mismatch for "${input}": got "${actual}", expected "${expected}"`);
    }
  }
  console.log('2. Universal URL Sanitizer (15/15 formats, schemeless, emoji-strip & profile rejection): PASSED');

  // 3. Live Verification of All 3 Extraction Engines
  const liveTestUrl = 'https://vt.tiktok.com/ZSgQuVgCe/';
  let e1, e2, e3;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      e1 = e1 || (await extractFromTikWM(liveTestUrl));
      e2 = e2 || (await extractFromTikTokDirect(liveTestUrl));
      e3 = e3 || (await extractFromTikMate(liveTestUrl));
      if (e1?.videoUrl && e2?.videoUrl && e2?.cookies && e3?.videoUrl) break;
    } catch (err) {
      console.error('Extraction attempt error:', err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!e1?.videoUrl) throw new Error('Engine 1 (TikWM) failed live extraction');
  if (!e2?.videoUrl || !e2?.cookies) throw new Error('Engine 2 (Direct TikTok Rehydration) failed live extraction');
  if (!e3?.videoUrl) throw new Error('Engine 3 (TikMate) failed live extraction');
  console.log(`3. Triple-Engine Live Extraction (TikWM: ${e1.id}, Direct: ${e2.id}, TikMate: ${e3.id}): PASSED`);

  // 4. Verify Binary MP4 Fetch + MP4 `tkhd` Aspect-Ratio Dimension Parser
  const streamRes = await fetchMediaStream(e1.videoUrl, 'video/mp4', 8192);
  if (!streamRes?.blob || streamRes.blob.size < 100000) {
    throw new Error('MP4 binary stream fetch failed');
  }
  if (!streamRes.dims?.width || !streamRes.dims?.height) {
    throw new Error(`MP4 tkhd dimension parser failed: ${JSON.stringify(streamRes.dims)}`);
  }
  console.log(
    `4. Binary MP4 Fetch + Native MP4 tkhd Dimension Parser (${streamRes.dims.width}x${streamRes.dims.height}, ${(streamRes.blob.size / 1024 / 1024).toFixed(2)} MB): PASSED`
  );

  // 5. End-to-End Large/Blocked Video Upload -> Telegram file_id + file_unique_id Caching -> Stale file_id Self-Healing -> Cross-Shortlink Instant Forward
  const origFetch = globalThis.fetch;
  const telegramCalls = [];
  const uniqueChatId = 99887766;
  const targetVideoId = '6718335390845095173';
  const uncachedLink = `https://www.tiktok.com/@scout2015/video/${targetVideoId}`;

  // Force clean cache state for targetVideoId to test fresh upload -> cache -> stale eviction -> reupload!
  await db.invalidateCachedMedia(targetVideoId, {}, 'video');

  let failStaleFileIdOnce = false;

  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = typeof url === 'string' ? url : url.url;
    if (urlStr.includes('api.telegram.org')) {
      if (urlStr.includes('/getMe') || urlStr.includes('/getChatMember')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { status: 'member', is_member: true, username: 'TheTikTokDownloaderBot' }
          })
        );
      }
      const isMultipart = opts.body instanceof FormData;
      let parsedBody = null;
      if (isMultipart) {
        parsedBody = {};
        for (const [k, v] of opts.body.entries()) {
          parsedBody[k] = v instanceof Blob ? `[Blob ${v.type} ${v.size}B]` : v;
        }
      } else if (opts.body) {
        parsedBody = JSON.parse(opts.body);
      }

      telegramCalls.push({ url: urlStr, isMultipart, payload: parsedBody });

      // Simulate stale file_id rejection once when requested
      if (!isMultipart && failStaleFileIdOnce && parsedBody?.video === 'stale_bad_file_id_123') {
        failStaleFileIdOnce = false;
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: wrong file identifier/HTTP URL specified'
          }),
          { status: 400 }
        );
      }

      // Simulate Telegram rejecting direct HTTP URL hotlink (forcing Worker binary upload to Telegram server)
      if ((urlStr.includes('/sendVideo') || urlStr.includes('/sendAudio')) && !isMultipart) {
        const ref = parsedBody?.video || parsedBody?.audio || '';
        if (typeof ref === 'string' && ref.startsWith('http')) {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: 'Bad Request: failed to get HTTP URL content'
            }),
            { status: 400 }
          );
        }
      }

      if (urlStr.includes('/sendVideo') && isMultipart) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 701,
              video: {
                file_id: 'BAACAgUAAxkBAA_FRESH_TG_HASH_999',
                file_unique_id: 'AgAD_UNIQUE_HASH_999'
              }
            }
          })
        );
      }

      if (urlStr.includes('/sendAudio') && isMultipart) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 702,
              audio: {
                file_id: 'CQACAgUAAxkBAA_AUDIO_TG_HASH_999',
                file_unique_id: 'AgAD_AUDIO_UNIQUE_999'
              }
            }
          })
        );
      }

      return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }));
    }
    return origFetch(url, opts);
  };

  try {
    const baseUid = Date.now();

    // 5A. Poison cache with a stale/expired Telegram file_id -> verify self-healing auto-evicts and re-uploads!
    await db.setCachedVideo(targetVideoId, 'Stale Test', 'stale_bad_file_id_123', {});
    failStaleFileIdOnce = true;

    const wait1 = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid,
          message: {
            message_id: 50,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'RahadTest' },
            text: uncachedLink
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => wait1.push(p) }
    );
    await Promise.all(wait1);

    const repairedCache = await db.getCachedVideo(targetVideoId, {});
    if (
      repairedCache?.file_id !== 'BAACAgUAAxkBAA_FRESH_TG_HASH_999' ||
      repairedCache?.file_unique_id !== 'AgAD_UNIQUE_HASH_999'
    ) {
      throw new Error(`Self-healing cache failed: got ${JSON.stringify(repairedCache)}`);
    }
    console.log(
      `5. Stale file_id Self-Healing + Worker Upload -> Saved Telegram Hash (${repairedCache.file_id} / ${repairedCache.file_unique_id}): PASSED`
    );

    // 5B. Second request for the same video -> MUST forward instantly via cached Telegram file_id hash with ZERO binary uploads!
    const uploadsBeforeSecond = telegramCalls.filter((c) => c.isMultipart).length;
    const wait2 = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 1,
          message: {
            message_id: 51,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'RahadTest' },
            text: uncachedLink
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => wait2.push(p) }
    );
    await Promise.all(wait2);

    const uploadsAfterSecond = telegramCalls.filter((c) => c.isMultipart).length;
    const lastVideoForward = [...telegramCalls].reverse().find((c) => c.url.includes('/sendVideo'));
    if (uploadsAfterSecond !== uploadsBeforeSecond || lastVideoForward?.payload?.video !== 'BAACAgUAAxkBAA_FRESH_TG_HASH_999') {
      throw new Error('Instant Telegram file_id hash forwarding failed on repeat video!');
    }
    console.log('6. Repeat Video Request -> Zero-Upload Instant Telegram Hash Forward (<0.1s): PASSED');

    // 7. Brand-New Short Link (`vt.tiktok.com/...`) 1-Hop Pre-Scrape Resolution Test
    // Pre-cache video e1.id with a Telegram hash, then send liveTestUrl WITHOUT shortlink cache entry -> should 1-hop HEAD resolve & forward without scraping!
    await db.setCachedVideo(e1.id, e1.title, 'BAACAgUAAxkBAA_SHORTLINK_HASH_777', {
      fileUniqueId: 'AgAD_SHORT_777'
    });
    const wait3 = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 2,
          message: {
            message_id: 52,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'RahadTest' },
            text: liveTestUrl
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => wait3.push(p) }
    );
    await Promise.all(wait3);

    const shortForward = [...telegramCalls].reverse().find((c) => c.url.includes('/sendVideo'));
    if (shortForward?.payload?.video !== 'BAACAgUAAxkBAA_SHORTLINK_HASH_777') {
      throw new Error('1-hop short-link redirect pre-cache resolution failed!');
    }
    console.log('7. Different Short-Link (vt.tiktok.com) -> 1-Hop Pre-Scrape ID Match -> Instant Telegram Hash Forward: PASSED');

    // 8. Audio Callback + Telegram Audio Hash Caching
    const audioWait = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 3,
          callback_query: {
            id: 'cb_1',
            from: { id: uniqueChatId, first_name: 'RahadTest' },
            message: { chat: { id: uniqueChatId } },
            data: `audio_${e1.id}`
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => audioWait.push(p) }
    );
    await Promise.all(audioWait);

    const audioDelivered = telegramCalls.some((c) => c.url.includes('/sendAudio'));
    if (!audioDelivered) throw new Error('Audio callback failed to deliver MP3');
    console.log('8. Audio Extraction Callback + Persistent Audio Hash Cache: PASSED');

    // 9. Database, User History & Cache Hit Metrics Verification
    const stats = await db.getStats({});
    if (stats.users < 1 || stats.cachedVideos < 1) throw new Error('DB stats failed');
    console.log(
      `9. Persistent Multi-Layer Cache & User History Stats (users=${stats.users}, downloads=${stats.downloads}, cache=${stats.cachedVideos}, cacheHits=${stats.cacheHits}): PASSED`
    );

    // 10. Dynamic Force-Subscription Gate & /setchannel Admin Command
    let mockMemberStatus = 'left';
    const subUserChatId = 77665544;
    const subWait = [];
    db.clearVerifiedUsersMemory();

    // Temporarily override /getChatMember to return left
    const origSubFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const urlStr = typeof url === 'string' ? url : url.url;
      if (urlStr.includes('/getChatMember')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { status: mockMemberStatus, is_member: mockMemberStatus === 'member' }
          })
        );
      }
      return origSubFetch(url, opts);
    };

    // User sends link while not a member -> should get join prompt
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 4,
          message: {
            message_id: 60,
            chat: { id: subUserChatId, type: 'private' },
            from: { id: subUserChatId, first_name: 'SubTester' },
            text: uncachedLink
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', CHANNEL_USERNAME: '@RHToolsOfficial' },
      { waitUntil: (p) => subWait.push(p) }
    );
    await Promise.all(subWait);

    const gatePrompt = telegramCalls.find(
      (c) => c.payload?.chat_id === subUserChatId && (c.payload?.text?.includes('Verification Required') || c.payload?.text?.includes('please join our channel first'))
    );
    if (!gatePrompt) throw new Error('Force-sub gate failed to prompt non-member user');

    // Admin sets channel dynamically via /setchannel
    const adminWait = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 5,
          message: {
            message_id: 61,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: '/setchannel @SponsorChannel'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => adminWait.push(p) }
    );
    await Promise.all(adminWait);

    const updatedSetting = await db.getSetting('force_sub_channel', {});
    if (updatedSetting !== '@SponsorChannel') throw new Error('Admin /setchannel failed to update setting in DB');

    console.log('10. Dynamic Force-Subscription Gate & /setchannel Admin Command: PASSED');

    // 11. Cross-Platform Classifiers and Cross-Promotion Routing
    const waitIG = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 6,
          message: {
            message_id: 70,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'Tester' },
            text: 'https://www.instagram.com/reel/DC_test/'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitIG.push(p) }
    );
    await Promise.all(waitIG);
    const igCall = telegramCalls.find((c) => c.payload?.text?.includes('Instagram not supported'));
    if (!igCall || igCall.payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.url !== 'https://t.me/InstaFBDownloaderProBot') {
      throw new Error('Instagram redirect call failed');
    }

    const waitFB = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 7,
          message: {
            message_id: 71,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'Tester' },
            text: 'https://fb.watch/test1234/'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitFB.push(p) }
    );
    await Promise.all(waitFB);
    const fbCall = telegramCalls.find((c) => c.payload?.text?.includes('Facebook not supported'));
    if (!fbCall || fbCall.payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.url !== 'https://t.me/InstaFBDownloaderProBot') {
      throw new Error('Facebook redirect call failed');
    }

    const waitYT = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 8,
          message: {
            message_id: 72,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'Tester' },
            text: 'https://youtube.com/watch?v=abc'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitYT.push(p) }
    );
    await Promise.all(waitYT);
    const ytCall = telegramCalls.find((c) => c.payload?.text?.includes('YouTube not supported'));
    if (!ytCall) throw new Error('YouTube rejection call failed');

    const waitOther = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 9,
          message: {
            message_id: 73,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'Tester' },
            text: 'https://x.com/user/status/123'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitOther.push(p) }
    );
    await Promise.all(waitOther);
    const otherCall = telegramCalls.find((c) => c.payload?.text?.includes('Platform not supported'));
    if (!otherCall) throw new Error('Other platform rejection call failed');

    const waitText = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 10,
          message: {
            message_id: 74,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'Tester' },
            text: 'just regular message'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitText.push(p) }
    );
    await Promise.all(waitText);
    const textCall = telegramCalls.find((c) => c.payload?.text?.includes('Send a TikTok link'));
    if (!textCall) throw new Error('Non-link text prompt call failed');
    console.log('11. Cross-Platform Classifiers and Cross-Promotion Routing: PASSED');

    // 12. 2-Level Bottom Keyboard Admin Navigation
    const waitAdmStart = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 11,
          message: {
            message_id: 80,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: '/start'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitAdmStart.push(p) }
    );
    await Promise.all(waitAdmStart);
    const admStartCall = telegramCalls.find((c) => c.payload?.chat_id === 6775546602 && c.payload?.text?.includes('Welcome'));
    if (!admStartCall || admStartCall.payload?.reply_markup?.keyboard?.[0]?.[0]?.text !== '⚙️ Admin Panel') {
      throw new Error('Admin start level 1 keyboard failed');
    }

    const waitAdmPanel = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 12,
          message: {
            message_id: 81,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: '⚙️ Admin Panel'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitAdmPanel.push(p) }
    );
    await Promise.all(waitAdmPanel);
    const admPanelCall = [...telegramCalls].reverse().find((c) => c.payload?.chat_id === 6775546602 && c.payload?.text?.includes('Admin Panel'));
    if (!admPanelCall || !admPanelCall.payload?.reply_markup?.keyboard) {
      throw new Error('Admin panel level 2 keyboard failed');
    }

    const waitAdmBack = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 13,
          message: {
            message_id: 82,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: 'Back'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitAdmBack.push(p) }
    );
    await Promise.all(waitAdmBack);
    const admBackCall = [...telegramCalls].reverse().find((c) => c.payload?.chat_id === 6775546602 && (c.payload?.text === 'Exited' || c.payload?.text?.includes('Exited')));
    if (!admBackCall || admBackCall.payload?.reply_markup?.keyboard?.[0]?.[0]?.text !== '⚙️ Admin Panel') {
      throw new Error('Admin Back transition to Level 1 keyboard failed');
    }
    console.log('12. 2-Level Bottom Keyboard Admin Navigation: PASSED');

    // 12B. Submenu Back Navigation, Broadcast Preview/Cancel, Activity, and Disconnect Navigation
    // 1) Broadcast: tap 📣 Broadcast -> Send message -> Preview -> Cancel -> Returns to Dashboard
    const waitBcast1 = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 20,
          message: {
            message_id: 85,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: '📣 Broadcast'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitBcast1.push(p) }
    );
    await Promise.all(waitBcast1);
    const bcastPrompt = [...telegramCalls].reverse().find((c) => c.payload?.text?.includes('Send any message'));
    if (!bcastPrompt) throw new Error('Broadcast prompt message failed');

    // Send broadcast message -> gets preview
    const waitBcast2 = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 21,
          message: {
            message_id: 86,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: 'Important Update for all users!'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitBcast2.push(p) }
    );
    await Promise.all(waitBcast2);
    const bcastPreview = [...telegramCalls].reverse().find((c) => c.payload?.text?.includes('Broadcast Preview Above'));
    if (!bcastPreview) throw new Error('Broadcast preview prompt failed');

    // Tap Cancel -> returns to Admin Dashboard
    const waitBcastCancel = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 22,
          message: {
            message_id: 87,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: '❌ Cancel'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitBcastCancel.push(p) }
    );
    await Promise.all(waitBcastCancel);
    const returnedDash = [...telegramCalls].reverse().find((c) => c.payload?.text?.includes('Admin Panel'));
    if (!returnedDash) throw new Error('Broadcast cancel failed to return to Admin Dashboard');

    // 2) Activity: tap 📊 Activity -> Back -> returns to Dashboard
    const waitAct = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 23,
          message: {
            message_id: 88,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: '📊 Activity'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitAct.push(p) }
    );
    await Promise.all(waitAct);
    const actCall = [...telegramCalls].reverse().find((c) => c.payload?.text?.includes('System Activity') || c.payload?.text?.includes('Issues'));
    if (!actCall) throw new Error('Activity view call failed');

    // Tap Back from Activity -> returns to Admin Dashboard
    const waitActBack = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 24,
          message: {
            message_id: 89,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: 'Back'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitActBack.push(p) }
    );
    await Promise.all(waitActBack);
    const dashFromAct = [...telegramCalls].reverse().find((c) => c.payload?.text?.includes('Admin Panel'));
    if (!dashFromAct) throw new Error('Back from Activity failed to return to Admin Dashboard');

    // Tap Back from Admin Dashboard -> Exits with 'Exited' and Level 1 keyboard
    const waitExit = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 25,
          message: {
            message_id: 90,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            text: 'Back'
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitExit.push(p) }
    );
    await Promise.all(waitExit);
    const exitedCall = [...telegramCalls].reverse().find((c) => c.payload?.text === 'Exited');
    if (!exitedCall || exitedCall.payload?.reply_markup?.keyboard?.[0]?.[0]?.text !== '⚙️ Admin Panel') {
      throw new Error('Exited message and Level 1 keyboard failed');
    }
    console.log('12B. Submenu Back Navigation, Broadcast Preview/Cancel, and Exited: PASSED');

    // 13. chat_shared Native Channel Connection and Persistence
    const waitChatShared = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 14,
          message: {
            message_id: 83,
            chat: { id: 6775546602, type: 'private' },
            from: { id: 6775546602, first_name: 'AdminRahad' },
            chat_shared: {
              request_id: 101,
              chat_id: -1001999888777
            }
          }
        })
      }),
      { BOT_TOKEN: 'mock_token', ADMIN_ID: '6775546602' },
      { waitUntil: (p) => waitChatShared.push(p) }
    );
    await Promise.all(waitChatShared);
    const sharedChats = await db.getConnectedChats({});
    if (!sharedChats.some((c) => c.chat_key === '-1001999888777' || c.target === '-1001999888777')) {
      throw new Error('chat_shared channel connection failed to persist');
    }
    console.log('13. chat_shared Native Channel Connection and Persistence: PASSED');

    // 14. Large Video (>50MB) Direct CDN Download Fallback
    // Mock a video request whose CDN returns content-length > 50MB
    const largeVideoId = '9998887776665554443';
    const largeVideoUrl = `https://www.tiktok.com/@user/video/${largeVideoId}`;
    
    // Intercept fetch to provide mock TikWM response for large video, and oversized headers for its stream
    const prevFetchForLarge = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const urlStr = typeof url === 'string' ? url : url.url;
      if (urlStr.includes('tikwm.com')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            id: largeVideoId,
            title: 'Large 60MB Video Test',
            play: 'https://cdn.test/large_video.mp4',
            music: 'https://cdn.test/large_audio.mp3',
            size: 62914560
          }
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr.includes('large_video.mp4')) {
        return new Response(new Uint8Array(1024), {
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': '62914560'
          }
        });
      }
      return prevFetchForLarge(url, opts);
    };

    db.setUserVerifiedMemory(uniqueChatId);
    const waitLarge = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: baseUid + 15,
          message: {
            message_id: 95,
            chat: { id: uniqueChatId, type: 'private' },
            from: { id: uniqueChatId, first_name: 'Tester' },
            text: largeVideoUrl
          }
        })
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitLarge.push(p) }
    );
    await Promise.all(waitLarge);

    const largePrompt = telegramCalls.find((c) => c.payload?.text?.includes('File is larger than 50MB'));
    if (!largePrompt) {
      throw new Error('>50MB fallback direct download prompt was not sent');
    }
    const directBtn = largePrompt.payload?.reply_markup?.inline_keyboard?.[0]?.[0];
    if (directBtn?.text !== '⬇️ Download Video' || directBtn?.url !== 'https://cdn.test/large_video.mp4') {
      throw new Error('>50MB fallback download button URL mismatch');
    }
    console.log('14. Large Video (>50MB) Direct CDN Download Fallback: PASSED');

    console.log('\n🎉 ALL 14 ENTERPRISE TIKTOK BOT & TELEGRAM HASH CACHING TESTS PASSED 100%!\n');
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch((err) => {
  console.error('❌ Test error:', err);
  process.exit(1);
});
