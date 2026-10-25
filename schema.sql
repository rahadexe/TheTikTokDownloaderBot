-- Schema for Cloudflare D1 / SQLite database
-- Execute locally or in Cloudflare via:
-- npx wrangler d1 execute <db-name> --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  downloads_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_active_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS video_cache (
  video_id TEXT PRIMARY KEY,
  title TEXT,
  file_id TEXT NOT NULL,
  audio_file_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_downloads ON users(downloads_count);
CREATE INDEX IF NOT EXISTS idx_cache_created ON video_cache(created_at);
