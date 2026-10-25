# ⚡ TheTikTokDownloaderBot

> **Ultra-fast, 100% serverless Telegram Bot to download TikTok videos without watermark in HD & extract MP3 audio — powered by Cloudflare Workers & Cloudflare D1.**

[![Telegram Bot](https://img.shields.io/badge/Telegram-@TheTikTokDownloaderBot-2CA5E0?logo=telegram&logoColor=white)](https://t.me/TheTikTokDownloaderBot)
[![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Database](https://img.shields.io/badge/Database-Cloudflare%20D1%20SQL-yellow?logo=sqlite&logoColor=white)](https://developers.cloudflare.com/d1/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 🌟 Key Features

- **⚡ 100% Serverless:** 0ms cold starts, infinite free-tier scalability on Cloudflare Workers edge network.
- **🚀 Zero Server Bandwidth & RAM Load:** Videos stream directly from high-speed TikTok CDNs to Telegram via Telegram Bot API URL streaming.
- **⚡ Instant Telegram Cache:** Once any video is downloaded, its Telegram `file_id` is cached. Repeated requests are delivered instantly in 0.2s with zero CDN calls.
- **📊 User Tracking & Analytics:** Persistent storage for user engagement and download counts via Cloudflare D1 (or local SQLite).
- **🔒 Admin Analytics:** Secret `/stats` command restricted strictly to the configured `ADMIN_ID`.
- **✨ Pure No-Watermark HD:** Downloads crystal-clear MP4 videos without TikTok logos or end screens.
- **🎵 Instant MP3 Audio Extraction:** Interactive `🎵 Download Audio` button under every video.
- **🔗 Universal Link Compatibility:** Supports desktop URLs, mobile app share links (`vt.tiktok.com`, `vm.tiktok.com`), and query-tagged links.
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

Set your Telegram Bot Token securely in Cloudflare Secrets:
```bash
npx wrangler secret put BOT_TOKEN
```

*(Optional)* You can customize `ADMIN_ID`, `CHANNEL_USERNAME`, and `BOT_USERNAME` in your `wrangler.toml` under `[vars]`.

### 3. Setup Free Cloudflare D1 Database (Optional but Recommended)
```bash
# 1. Create your serverless D1 database
npx wrangler d1 create tiktok_db

# 2. Execute schema migration
npx wrangler d1 execute tiktok_db --file=./schema.sql

# 3. Add the generated database_id to your wrangler.toml
```

### 4. Deploy to Cloudflare Workers
```bash
npx wrangler deploy
```

### 5. Activate Telegram Webhook
Open the auto-configurator endpoint in your browser:
```
https://<your-worker-subdomain>.workers.dev/setWebhook
```
Your bot is now live and will respond to TikTok links in real time!

---

## 🧪 Local Testing & Verification

Run the built-in test suite to verify extraction engines, database tracking, and Telegram webhook compatibility:
```bash
npm test
```

---

## 📄 License
This project is open-source under the [MIT License](LICENSE).
