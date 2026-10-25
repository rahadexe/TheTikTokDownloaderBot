import worker from './src/worker.js';
import * as db from './src/db.js';

console.log('=== 🧪 Testing Serverless TikTok Downloader Worker ===\n');

async function runTests() {
  // 1. Health check endpoint test
  const req = new Request('https://worker.test/health');
  const res = await worker.fetch(req, {}, {});
  const data = await res.json();
  console.log('1. GET /health Endpoint:', data.status === 'online' ? 'PASSED' : 'FAILED');

  // 2. TikTok Extraction Live Test
  console.log('2. Testing Dual-Engine TikTok Extractor Live...');
  const testUrl = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
  
  // Call internal handler via simulated webhook
  let capturedTelegramCalls = [];
  const mockToken = 'mock_token_123';
  
  // Test mock fetch for Telegram
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('api.telegram.org')) {
      const parsed = JSON.parse(opts.body);
      capturedTelegramCalls.push({ url, payload: parsed });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1234 } }));
    }
    return origFetch(url, opts);
  };

  try {
    const fakeUpdate = {
      update_id: 100,
      message: {
        message_id: 50,
        chat: { id: 12345678, type: 'private' },
        from: { id: 12345678, first_name: 'Test' },
        text: `Check this video: ${testUrl}`
      }
    };

    const webhookReq = new Request('https://worker.test/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fakeUpdate)
    });

    const waitUntilPromises = [];
    const mockCtx = {
      waitUntil: (p) => waitUntilPromises.push(p)
    };

    const postRes = await worker.fetch(webhookReq, { BOT_TOKEN: mockToken }, mockCtx);
    console.log('   POST / Webhook Acknowledgement:', postRes.status === 200 ? 'PASSED' : 'FAILED');

    // Wait for async handlers
    await Promise.all(waitUntilPromises);

    const sentVideo = capturedTelegramCalls.find(c => c.url.includes('sendVideo'));
    const hasWatermarkFreeUrl = sentVideo && sentVideo.payload.video && sentVideo.payload.video.startsWith('https://');
    const hasAudioButton = sentVideo && sentVideo.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('audio_');

    console.log('3. Telegram sendVideo Delivery & CDN Hotlink:', hasWatermarkFreeUrl ? 'PASSED' : 'FAILED');
    console.log('4. Interactive Audio (MP3) Button Attached:', hasAudioButton ? 'PASSED' : 'FAILED');

    // 5. Database & Cache Verification
    const stats = await db.getStats();
    const dbOk = stats.users >= 1;
    console.log('5. Backend SQLite User Tracking & Analytics:', dbOk ? 'PASSED' : 'FAILED');

    if (data.status === 'online' && hasWatermarkFreeUrl && hasAudioButton && dbOk) {
      console.log('\n🎉 ALL CLOUDFLARE WORKER TIKTOK DOWNLOADER TESTS PASSED WITH 100% SUCCESS!\n');
    } else {
      throw new Error('Some unit tests failed.');
    }
  } finally {
    globalThis.fetch = origFetch;
  }
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
