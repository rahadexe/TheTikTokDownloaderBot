# ⚡ TheTikTokDownloaderBot

> **Ultra-fast, 100% serverless Telegram Bot to download TikTok videos without watermark in HD & extract MP3 audio — powered by Cloudflare Workers.**

[![Telegram Bot](https://img.shields.io/badge/Telegram-@TheTikTokDownloaderBot-2CA5E0?logo=telegram&logoColor=white)](https://t.me/TheTikTokDownloaderBot)
[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 🌟 Key Features

- **⚡ 100% Serverless:** 0ms cold starts, infinite free-tier scalability on Cloudflare Workers edge network.
- **🚀 Zero Server Bandwidth & RAM Load:** Videos are streamed directly from TikTok's global CDNs to Telegram via Telegram Bot API URL streaming.
- **✨ Pure No-Watermark HD:** Downloads crystal-clear MP4 videos without TikTok logos or end screens.
- **🎵 Instant MP3 Audio Extraction:** Interactive `🎵 Audio (MP3)` button under every video to download background audio/music.
- **🔗 Universal Link Compatibility:** Supports desktop URLs, mobile app share links (`vt.tiktok.com`, `vm.tiktok.com`), and query-tagged links.
- **💬 Inline Mode:** Type `@TheTikTokDownloaderBot <link>` in any chat or group to share videos immediately.
- **🛡️ 100% Native Telegram Experience:** Zero external ads, zero pop-ups, zero third-party redirects.

---

## 🚀 Quick Setup & Deployment

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/rahadexe/TheTikTokDownloaderBot.git
cd TheTikTokDownloaderBot
npm install
```

### 2. Configure Environment
Copy the example configuration:
```bash
cp wrangler.toml.example wrangler.toml
```

Set your Telegram Bot Token (obtained from [@BotFather](https://t.me/BotFather)):
```bash
npx wrangler secret put BOT_TOKEN
```

### 3. Deploy to Cloudflare Workers
```bash
npx wrangler deploy
```

### 4. Activate Telegram Webhook
Open the auto-configurator endpoint in your browser:
```
https://<your-worker-subdomain>.workers.dev/setWebhook
```
Your bot is now live and will respond to TikTok links in real time!

---

## 🧪 Local Testing & Verification

Run the built-in test suite to verify extraction engines and Telegram webhook compatibility:
```bash
npm test
```

---

## 📄 License
This project is open-source under the [MIT License](LICENSE).
