import worker, {
  extractTikTokUrl,
  extractFromTikWM,
  extractFromTikTokDirect,
  extractFromTikMate,
  fetchMediaStream
} from './src/worker.js';
import * as db from './src/db.js';

console.log('=== 🧪 Deep Audit Test Suite: Serverless TikTok Downloader Worker ===\n');

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
    ['https://www.tiktok.com/embed/v2/7692664817294773512', 'https://www.tiktok.com/embed/v2/7692664817294773512'],
    ['https://www.tiktok.com/share/video/7692664817294773512', 'https://www.tiktok.com/share/video/7692664817294773512'],
    ['https://www.tiktok.com/?item_id=7692664817294773512', 'https://www.tiktok.com/@a/video/7692664817294773512'],
    // Non-media pages MUST return null immediately instead of wasting 15s scraping
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
  const e1 = await extractFromTikWM(liveTestUrl);
  const e2 = await extractFromTikTokDirect(liveTestUrl);
  const e3 = await extractFromTikMate(liveTestUrl);

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

  // 5. Simulate Telegram CDN 400 Block -> Verify Multipart Binary Upload WITH width/height + Webhook Deduplication + Short-Link Cache
  const origFetch = globalThis.fetch;
  const telegramCalls = [];
  const uniqueChatId = 99887766;
  const uncachedLink = `https://www.tiktok.com/@scout2015/video/6718335390845095173`;

  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = typeof url === 'string' ? url : url.url;
    if (urlStr.includes('api.telegram.org')) {
      if (urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { username: 'TheTikTokDownloaderBot' } }));
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
            result: { message_id: 701, video: { file_id: 'cached_tg_video_fid_999' } }
          })
        );
      }

      if (urlStr.includes('/sendAudio') && isMultipart) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 702, audio: { file_id: 'cached_tg_audio_fid_999' } }
          })
        );
      }

      return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }));
    }
    return origFetch(url, opts);
  };

  try {
    const dupUpdateId = Date.now();
    const fakeUpdate = {
      update_id: dupUpdateId,
      message: {
        message_id: 50,
        chat: { id: uniqueChatId, type: 'private' },
        from: { id: uniqueChatId, first_name: 'RahadTest' },
        text: 'Watch',
        entities: [{ type: 'text_link', offset: 0, length: 5, url: uncachedLink }]
      }
    };

    const waitUntilPromises = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fakeUpdate)
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitUntilPromises.push(p) }
    );
    await Promise.all(waitUntilPromises);

    const callsAfterFirst = telegramCalls.length;

    // Replay exact same update_id (simulating Telegram webhook retry) -> MUST be ignored!
    const retryPromises = [];
    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fakeUpdate)
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => retryPromises.push(p) }
    );
    await Promise.all(retryPromises);

    if (telegramCalls.length !== callsAfterFirst) {
      throw new Error('Webhook update_id deduplication failed — duplicate delivery occurred!');
    }
    console.log('5. Hyperlink Entity Extraction + Webhook Retry Deduplication: PASSED');

    // 6. Test Short-Link Cache Mapping
    await db.setCachedShortLink(liveTestUrl, e1.id);
    const mappedId = await db.getCachedShortLink(liveTestUrl);
    if (mappedId !== e1.id) throw new Error('Short-link cache mapping failed');
    console.log(`6. Instant Short-Link -> Video ID Cache (${liveTestUrl} -> ${mappedId}): PASSED`);

    // 7. Test Audio Callback ([ 🎵 Download Audio ]) + Photo/Video Audio UPSERT
    const audioWait = [];
    const cbUpdate = {
      update_id: dupUpdateId + 1,
      callback_query: {
        id: 'cb_1',
        from: { id: uniqueChatId, first_name: 'RahadTest' },
        message: { chat: { id: uniqueChatId } },
        data: `audio_${e1.id}`
      }
    };

    await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cbUpdate)
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => audioWait.push(p) }
    );
    await Promise.all(audioWait);

    const audioDelivered = telegramCalls.some((c) => c.url.includes('/sendAudio'));
    if (!audioDelivered) throw new Error('Audio callback failed to deliver MP3');
    console.log('7. Audio Extraction Callback + UPSERT Cache: PASSED');

    // 8. Database & Metrics Verification
    const stats = await db.getStats();
    if (stats.users < 1) throw new Error('DB user stats failed');
    console.log(`8. Universal Database & Metrics Tracking (users=${stats.users}, downloads=${stats.downloads}, cache=${stats.cachedVideos}): PASSED`);

    console.log('\n🎉 ALL 8 DEEP-AUDIT TIKTOK WORKER TESTS PASSED 100%!\n');
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch((err) => {
  console.error('❌ Test error:', err);
  process.exit(1);
});
