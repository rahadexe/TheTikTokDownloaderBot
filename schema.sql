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
  file_id TEXT NOT NULL DEFAULT '',
  file_unique_id TEXT,
  audio_file_id TEXT,
  audio_unique_id TEXT,
  photo_file_ids TEXT,
  audio_url TEXT,
  music_title TEXT,
  width INTEGER,
  height INTEGER,
  duration INTEGER,
  hits INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS link_cache (
  url_key TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  source_url TEXT,
  media_type TEXT DEFAULT 'video',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_downloads ON users(downloads_count);
CREATE INDEX IF NOT EXISTS idx_cache_created ON video_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_link_video_id ON link_cache(video_id);
CREATE INDEX IF NOT EXISTS idx_user_downloads_uid ON user_downloads(user_id, created_at);
