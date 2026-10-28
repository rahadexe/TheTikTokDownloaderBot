import path from 'path';
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

  // Non-breaking optional columns for audio metadata caching
  try { db.exec(`ALTER TABLE video_cache ADD COLUMN audio_url TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE video_cache ADD COLUMN music_title TEXT;`); } catch {}
} catch {
  // Graceful fallback for non-node environments (Cloudflare Workers / In-Memory)
  isNodeSqlite = false;
}

// In-Memory store (fast L1 cache in Workers & local fallback)
const memoryStore = {
  users: new Map(),
  cache: new Map()
};

const EDGE_CACHE_ORIGIN = 'https://cache.tiktokdownloader.internal';

function getEdgeCache() {
  try {
    if (typeof caches !== 'undefined' && caches && caches.default) {
      return caches.default;
    }
  } catch {}
  return null;
}

async function readEdgeCache(videoId) {
  const edgeCache = getEdgeCache();
  if (!edgeCache || !videoId) return null;
  try {
    const req = new Request(`${EDGE_CACHE_ORIGIN}/video/${encodeURIComponent(String(videoId))}`);
    const res = await edgeCache.match(req);
    if (!res) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeEdgeCache(videoId, payload) {
  const edgeCache = getEdgeCache();
  if (!edgeCache || !videoId || !payload) return;
  try {
    const req = new Request(`${EDGE_CACHE_ORIGIN}/video/${encodeURIComponent(String(videoId))}`);
    const res = new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=604800'
      }
    });
    await edgeCache.put(req, res);
  } catch {}
}

/**
 * Register or update user
 */
export async function upsertUser(user, env) {
  if (!user || !user.id) return;

  const id = Number(user.id);
  const username = user.username || '';
  const firstName = user.first_name || '';
  const now = new Date().toISOString();

  // Always update in-memory L1
  const existing = memoryStore.users.get(id) || { id, downloads_count: 0, created_at: now };
  existing.username = username;
  existing.first_name = firstName;
  existing.last_active_at = now;
  memoryStore.users.set(id, existing);

  // 1. Cloudflare D1 priority
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

  // 2. Node.js SQLite priority
  if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO users (id, username, first_name, downloads_count, created_at, last_active_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_active_at = excluded.last_active_at;
      `).run(id, username, firstName, now, now);
    } catch (e) {
      console.warn('upsertUser sqlite error:', e.message);
    }
  }
}

/**
 * Increment user's download count
 */
export async function incrementUserDownloads(userId, env) {
  if (!userId) return;
  const id = Number(userId);

  const u = memoryStore.users.get(id);
  if (u) u.downloads_count = (u.downloads_count || 0) + 1;

  if (env && env.DB) {
    try {
      await env.DB.prepare(`UPDATE users SET downloads_count = downloads_count + 1 WHERE id = ?`).bind(id).run();
      return;
    } catch {}
  }

  if (isNodeSqlite && db) {
    try {
      db.prepare(`UPDATE users SET downloads_count = downloads_count + 1 WHERE id = ?`).run(id);
    } catch {}
  }
}

/**
 * Get cached video/audio entry by TikTok ID
 */
export async function getCachedVideo(videoId, env) {
  if (!videoId) return null;
  const vid = String(videoId);

  const mem = memoryStore.cache.get(vid);

  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare(`SELECT * FROM video_cache WHERE video_id = ?`).bind(vid).first();
      if (row) return { ...mem, ...row };
    } catch {}
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      const row = db.prepare(`SELECT * FROM video_cache WHERE video_id = ?`).get(vid);
      if (row) return { ...mem, ...row };
    } catch {}
  }

  // 3. Cloudflare Edge Cache API (survives Worker isolate restarts without D1!)
  const edge = await readEdgeCache(vid);
  if (edge) {
    const merged = { ...edge, ...mem };
    memoryStore.cache.set(vid, merged);
    return merged;
  }

  // 4. In-memory fallback
  return mem || null;
}

/**
 * Cache video file_id and optional audio stream metadata
 */
export async function setCachedVideo(videoId, title, fileId, env, extra = {}) {
  if (!videoId) return;
  const vid = String(videoId);
  const t = title || 'TikTok Video';
  const fid = fileId ? String(fileId) : '';
  const now = new Date().toISOString();

  const prev = (await getCachedVideo(vid, env)) || { video_id: vid, created_at: now };
  const merged = {
    ...prev,
    video_id: vid,
    title: t || prev.title || 'TikTok Video',
    file_id: fid || prev.file_id || '',
    audio_url: extra.audioUrl || prev.audio_url || null,
    music_title: extra.musicTitle || prev.music_title || null
  };

  memoryStore.cache.set(vid, merged);
  await writeEdgeCache(vid, merged);

  if (!merged.file_id) return;

  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          file_id = excluded.file_id;
      `).bind(vid, merged.title, merged.file_id, now).run();
      return;
    } catch (e) {
      console.warn('setCachedVideo D1 error:', e.message);
    }
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, audio_url, music_title, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          file_id = excluded.file_id,
          audio_url = COALESCE(excluded.audio_url, video_cache.audio_url),
          music_title = COALESCE(excluded.music_title, video_cache.music_title);
      `).run(vid, merged.title, merged.file_id, merged.audio_url, merged.music_title, now);
    } catch {
      try {
        db.prepare(`
          INSERT INTO video_cache (video_id, title, file_id, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(video_id) DO UPDATE SET
            title = excluded.title,
            file_id = excluded.file_id;
        `).run(vid, merged.title, merged.file_id, now);
      } catch (e) {
        console.warn('setCachedVideo sqlite error:', e.message);
      }
    }
  }
}

/**
 * Cache extracted audio file_id
 */
export async function setCachedAudio(videoId, audioFileId, env, title = 'TikTok Audio') {
  if (!videoId || !audioFileId) return;
  const vid = String(videoId);
  const afid = String(audioFileId);
  const now = new Date().toISOString();

  const prev = (await getCachedVideo(vid, env)) || { video_id: vid, title, file_id: '', created_at: now };
  const merged = {
    ...prev,
    video_id: vid,
    audio_file_id: afid
  };

  memoryStore.cache.set(vid, merged);
  await writeEdgeCache(vid, merged);

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
      const info = db.prepare(`UPDATE video_cache SET audio_file_id = ? WHERE video_id = ?`).run(afid, vid);
      if (!info || info.changes === 0) {
        db.prepare(`
          INSERT INTO video_cache (video_id, title, file_id, audio_file_id, created_at)
          VALUES (?, ?, '', ?, ?)
          ON CONFLICT(video_id) DO UPDATE SET audio_file_id = excluded.audio_file_id;
        `).run(vid, merged.title || title, afid, now);
      }
    } catch {}
  }
}

/**
 * Get aggregate statistics (Admin only)
 */
export async function getStats(env) {
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
