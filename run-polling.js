import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleUpdate } from './src/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve BOT_TOKEN from env, .dev.vars, or wrangler.toml
let token = process.env.BOT_TOKEN;

if (!token && fs.existsSync(path.join(__dirname, '.dev.vars'))) {
  const content = fs.readFileSync(path.join(__dirname, '.dev.vars'), 'utf8');
  const match = content.match(/BOT_TOKEN=["']?([^"'\r\n]+)["']?/);
  if (match) token = match[1];
}

if (!token && fs.existsSync(path.join(__dirname, 'wrangler.toml'))) {
  const content = fs.readFileSync(path.join(__dirname, 'wrangler.toml'), 'utf8');
  const match = content.match(/BOT_TOKEN\s*=\s*["']([^"']+)["']/);
  if (match) token = match[1];
}

if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
  console.error('❌ Error: BOT_TOKEN is missing. Provide it via BOT_TOKEN env or .dev.vars');
  process.exit(1);
}

console.log('🚀 Starting Long Polling Engine for TikTok Downloader Bot...');

let offset = 0;
let isRunning = true;

async function startPolling() {
  // Ensure webhook is removed for polling mode
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  } catch {}

  const botInfoRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const botInfo = await botInfoRes.json();
  if (!botInfo.ok) {
    console.error('❌ Invalid Bot Token:', botInfo);
    process.exit(1);
  }

  console.log(`✅ Bot @${botInfo.result.username} is connected and listening via Long Polling!`);

  while (isRunning) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25`, {
        signal: AbortSignal.timeout(35000)
      });
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          // Handle update asynchronously without blocking polling loop
          handleUpdate(update, token).catch(err => {
            console.error('Error handling update:', err);
          });
        }
      } else if (!data.ok) {
        console.warn('getUpdates warning:', data);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      if (err.name !== 'TimeoutError') {
        // Suppress timeout errors (normal for long polling)
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

process.on('SIGINT', () => { isRunning = false; process.exit(0); });
process.on('SIGTERM', () => { isRunning = false; process.exit(0); });

startPolling().catch(err => {
  console.error('Fatal polling error:', err);
  process.exit(1);
});
