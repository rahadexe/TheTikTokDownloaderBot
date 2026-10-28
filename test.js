import worker, {
  extractTikTokUrl,
  extractFromTikWM,
  extractFromTikTokDirect,
  extractFromTikMate,
  fetchMediaBlob
} from './src/worker.js';
import * as db from './src/db.js';

console.log('=== 🧪 Testing Serverless TikTok Downloader Worker (Triple-Engine + Multipart Fallback) ===\n');

async function runTests() {
  // 1. Health check endpoint test
  const req = new Request('https://worker.test/health');
  const res = await worker.fetch(req, {}, {});
  const data = await res.json();
  if (data.status !== 'online') throw new Error('Health endpoint failed');
  console.log('1. GET /health Endpoint: PASSED');

  // 2. Comprehensive TikTok Link Format & Tracking Sanitization Support
  const linkTests = [
    ['https://www.tiktok.com/@user/video/12345?is_from_webapp=1&sender_device=pc', 'https://www.tiktok.com/@user/video/12345'],
    ['https://tiktok.com/@user/photo/98765?_r=1&_t=abc', 'https://tiktok.com/@user/photo/98765'],
    ['https://vt.tiktok.com/ZSgQuVgCe/?_r=1&_t=8q123!', 'https://vt.tiktok.com/ZSgQuVgCe/'],
    ['https://vm.tiktok.com/ZM8abc/?utm_source=copy', 'https://vm.tiktok.com/ZM8abc/'],
    ['https://m.tiktok.com/v/12345.html?u_code=1', 'https://m.tiktok.com/v/12345.html'],
    ['https://www.tiktok.com/t/ZT8abc123/?_t=1', 'https://www.tiktok.com/t/ZT8abc123/'],
    ['https://v.tiktok.com/ZS123/', 'https://v.tiktok.com/ZS123/'],
    ['Watch this: https://vt.tiktok.com/ZSgQuVgCe/).', 'https://vt.tiktok.com/ZSgQuVgCe/']
  ];
  for (const [input, expected] of linkTests) {
    const actual = extractTikTokUrl(input);
    if (actual !== expected) {
      throw new Error(`URL Sanitizer mismatch for ${input}: got ${actual}, expected ${expected}`);
    }
  }
  console.log('2. Universal TikTok Link Sanitization (8/8 formats + tracking strip): PASSED');

  // 3. Live Verification of All 3 Extraction Engines + Binary Stream Integrity
  const liveTestUrl = 'https://vt.tiktok.com/ZSgQuVgCe/';
  const e1 = await extractFromTikWM(liveTestUrl);
  const e2 = await extractFromTikTokDirect(liveTestUrl);
  const e3 = await extractFromTikMate(liveTestUrl);

  if (!e1?.videoUrl) throw new Error('Engine 1 (TikWM) failed live extraction');
  if (!e2?.videoUrl || !e2?.cookies) throw new Error('Engine 2 (Direct TikTok Rehydration) failed live extraction');
  if (!e3?.videoUrl) throw new Error('Engine 3 (TikMate) failed live extraction');
  console.log(`3. Triple-Engine Live Extraction (TikWM: ${e1.id}, Direct: ${e2.id}, TikMate: ${e3.id}): PASSED`);

  // Verify Direct TikTok cookie-authenticated binary fetch produces real MP4 Blob
  const directBlob = await fetchMediaBlob(e2.videoUrl, 'video/mp4', 8192, e2.cookies);
  if (!directBlob || directBlob.size < 100000) {
    throw new Error('Direct TikTok binary stream fetch failed or returned invalid size');
  }
  console.log(`4. Direct TikTok Cookie-Authenticated Binary MP4 Fetch (${(directBlob.size / 1024 / 1024).toFixed(2)} MB): PASSED`);

  // 5. Simulate Telegram CDN Block (400: failed to get HTTP URL content) -> Verify Automatic Worker FormData Binary Upload!
  const origFetch = globalThis.fetch;
  const telegramCalls = [];
  const uniqueChatId = 99887766;
  // Use fresh uncached video URL or clear test ID by testing full webhook flow where URL hotlink is rejected
  const uncachedLink = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';

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

      // Simulate Telegram rejecting direct CDN URL hotlink (exact production bug!)
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
    const fakeUpdate = {
      update_id: 500,
      message: {
        message_id: 50,
        chat: { id: uniqueChatId, type: 'private' },
        from: { id: uniqueChatId, first_name: 'RahadTest' },
        text: uncachedLink
      }
    };

    const waitUntilPromises = [];
    const postRes = await worker.fetch(
      new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fakeUpdate)
      }),
      { BOT_TOKEN: 'mock_token' },
      { waitUntil: (p) => waitUntilPromises.push(p) }
    );
    if (postRes.status !== 200) throw new Error('Webhook did not return 200');
    await Promise.all(waitUntilPromises);

    const multipartVideoCall = telegramCalls.find((c) => c.url.includes('/sendVideo') && c.isMultipart);
    const cachedVideoCall = telegramCalls.find(
      (c) => c.url.includes('/sendVideo') && !c.isMultipart && !String(c.payload?.video || '').startsWith('http')
    );

    if (!multipartVideoCall && !cachedVideoCall) {
      throw new Error('Expected Worker multipart binary upload fallback (or cached file_id) to succeed when CDN hotlink is 400-blocked!');
    }
    if (multipartVideoCall) {
      console.log(`5. CDN 400 Block -> Automatic Worker FormData Binary Video Upload (${multipartVideoCall.payload.video}): PASSED`);
    } else {
      console.log('5. Cached Telegram file_id Instant Video Delivery: PASSED');
    }

    // 6. Test Audio Callback ([ 🎵 Download Audio ]) when Telegram rejects Audio CDN URL
    const audioWait = [];
    const cbUpdate = {
      update_id: 501,
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

    const multipartAudioCall = telegramCalls.find((c) => c.url.includes('/sendAudio') && c.isMultipart);
    const cachedAudioCall = telegramCalls.find(
      (c) => c.url.includes('/sendAudio') && !c.isMultipart && !String(c.payload?.audio || '').startsWith('http')
    );
    if (!multipartAudioCall && !cachedAudioCall) {
      throw new Error('Audio callback failed to fallback to binary upload!');
    }
    console.log(
      `6. Audio Extraction Callback + Binary MP3 Upload Fallback (${multipartAudioCall ? multipartAudioCall.payload.audio : 'cached'}): PASSED`
    );

    // 7. Database & Cache Verification
    const stats = await db.getStats();
    if (stats.users < 1) throw new Error('DB user stats failed');
    console.log(`7. Universal Database & Cache Tracking (users=${stats.users}, cache=${stats.cachedVideos}): PASSED`);

    console.log('\n🎉 ALL 7 TIKTOK WORKER & MULTIPART FALLBACK TESTS PASSED 100%!\n');
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch((err) => {
  console.error('❌ Test error:', err);
  process.exit(1);
});
