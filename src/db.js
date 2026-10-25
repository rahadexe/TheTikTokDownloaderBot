import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

let db = null;
let isNodeSqlite = false;

// Initialize SQLite for Node.js environments (long polling / local testing)
try {
  const { DatabaseSync } = await import('node:sqlite');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dbPath = path.join(__dirname, '..', 'tiktok.sqlite');
  db = new DatabaseSync(dbPath);
  isNodeSqlite = true;

  // Initialize schema
  db.exec(`
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
  `);
} catch (e) {
  // Graceful fallback for non-node environments (Cloudflare Workers / In-Memory)
  isNodeSqlite = false;
}

// In-Memory fallback store for environments without native node:sqlite or D1
const memoryStore = {
  users: new Map(),
  cache: new Map()
};

/**
 * Register or update user
 */
export async function upsertUser(user, env) {
  if (!user || !user.id) return;

  const id = Number(user.id);
  const username = user.username || '';
  const firstName = user.first_name || '';
  const now = new Date().toISOString();

  // 1. Cloudflare D1 priority (when running on Cloudflare Workers)
  if (env && env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO users (id, username, first_name, downloads_count, created_at, last_active_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_active_at = excluded.last_active_at;
      `).bind(id, username, firstName, now, now).run();
      return;
    } catch (e) {
      console.warn('upsertUser D1 error:', e.message);
    }
  }

  // 2. Node.js SQLite priority (when running via run-polling.js)
  if (isNodeSqlite && db) {
    try {
      const stmt = db.prepare(`
        INSERT INTO users (id, username, first_name, downloads_count, created_at, last_active_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_active_at = excluded.last_active_at;
      `);
      stmt.run(id, username, firstName, now, now);
      return;
    } catch (e) {
      console.warn('upsertUser sqlite error:', e.message);
    }
  }

  // 3. Fallback in-memory
  const existing = memoryStore.users.get(id) || { id, downloads_count: 0, created_at: now };
  existing.username = username;
  existing.first_name = firstName;
  existing.last_active_at = now;
  memoryStore.users.set(id, existing);
}

/**
 * Increment user's download count
 */
export async function incrementUserDownloads(userId, env) {
  if (!userId) return;
  const id = Number(userId);

  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      await env.DB.prepare(`UPDATE users SET downloads_count = downloads_count + 1 WHERE id = ?`).bind(id).run();
      return;
    } catch {}
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      db.prepare(`UPDATE users SET downloads_count = downloads_count + 1 WHERE id = ?`).run(id);
      return;
    } catch {}
  }

  // 3. In-memory fallback
  const u = memoryStore.users.get(id);
  if (u) u.downloads_count = (u.downloads_count || 0) + 1;
}

/**
 * Get cached video by TikTok ID
 */
export async function getCachedVideo(videoId, env) {
  if (!videoId) return null;
  const vid = String(videoId);

  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare(`SELECT * FROM video_cache WHERE video_id = ?`).bind(vid).first();
      return row || null;
    } catch {}
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      const row = db.prepare(`SELECT * FROM video_cache WHERE video_id = ?`).get(vid);
      return row || null;
    } catch {}
  }

  // 3. In-memory fallback
  return memoryStore.cache.get(vid) || null;
}

/**
 * Cache video file_id
 */
export async function setCachedVideo(videoId, title, fileId, env) {
  if (!videoId || !fileId) return;
  const vid = String(videoId);
  const t = title || 'TikTok Video';
  const fid = String(fileId);
  const now = new Date().toISOString();

  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          file_id = excluded.file_id;
      `).bind(vid, t, fid, now).run();
      return;
    } catch (e) {
      console.warn('setCachedVideo D1 error:', e.message);
    }
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          file_id = excluded.file_id;
      `).run(vid, t, fid, now);
      return;
    } catch (e) {
      console.warn('setCachedVideo sqlite error:', e.message);
    }
  }

  // 3. In-memory fallback
  const existing = memoryStore.cache.get(vid) || { video_id: vid };
  existing.title = t;
  existing.file_id = fid;
  memoryStore.cache.set(vid, existing);
}

/**
 * Cache extracted audio file_id
 */
export async function setCachedAudio(videoId, audioFileId, env) {
  if (!videoId || !audioFileId) return;
  const vid = String(videoId);
  const afid = String(audioFileId);

  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      await env.DB.prepare(`UPDATE video_cache SET audio_file_id = ? WHERE video_id = ?`).bind(afid, vid).run();
      return;
    } catch {}
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      db.prepare(`UPDATE video_cache SET audio_file_id = ? WHERE video_id = ?`).run(afid, vid);
      return;
    } catch {}
  }

  // 3. In-memory fallback
  const item = memoryStore.cache.get(vid);
  if (item) item.audio_file_id = afid;
}

/**
 * Get aggregate statistics (Admin only)
 */
export async function getStats(env) {
  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      const uRow = await env.DB.prepare(`SELECT COUNT(*) as users, COALESCE(SUM(downloads_count), 0) as downloads FROM users`).first();
      const cRow = await env.DB.prepare(`SELECT COUNT(*) as cached FROM video_cache`).first();
      return {
        users: Number(uRow?.users || 0),
        downloads: Number(uRow?.downloads || 0),
        cachedVideos: Number(cRow?.cached || 0)
      };
    } catch {}
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      const uRow = db.prepare(`SELECT COUNT(*) as users, COALESCE(SUM(downloads_count), 0) as downloads FROM users`).get();
      const cRow = db.prepare(`SELECT COUNT(*) as cached FROM video_cache`).get();
      return {
        users: Number(uRow?.users || 0),
        downloads: Number(uRow?.downloads || 0),
        cachedVideos: Number(cRow?.cached || 0)
      };
    } catch (e) {
      console.warn('getStats sqlite error:', e.message);
    }
  }

  // 3. In-memory fallback
  let totalDownloads = 0;
  for (const u of memoryStore.users.values()) {
    totalDownloads += (u.downloads_count || 0);
  }

  return {
    users: memoryStore.users.size,
    downloads: totalDownloads,
    cachedVideos: memoryStore.cache.size
  };
}
