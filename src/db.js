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

  // Non-breaking optional columns for extended metadata caching
  try { db.exec(`ALTER TABLE video_cache ADD COLUMN audio_url TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE video_cache ADD COLUMN music_title TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE video_cache ADD COLUMN width INTEGER;`); } catch {}
  try { db.exec(`ALTER TABLE video_cache ADD COLUMN height INTEGER;`); } catch {}
  try { db.exec(`ALTER TABLE video_cache ADD COLUMN duration INTEGER;`); } catch {}
} catch {
  // Graceful fallback for non-node environments (Cloudflare Workers / In-Memory)
  isNodeSqlite = false;
}

// Bounded L1 In-Memory LRU Store (prevents Worker memory growth under heavy traffic)
const MAX_MEM_USERS = 2000;
const MAX_MEM_CACHE = 1000;

const memoryStore = {
  users: new Map(),
  cache: new Map()
};

function setBoundedMap(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

const EDGE_CACHE_ORIGIN = 'https://cache.tiktokdownloader.internal';

function getEdgeCache() {
  try {
    if (typeof caches !== 'undefined' && caches && caches.default) {
      return caches.default;
    }
  } catch {}
  return null;
}

async function readEdgeCacheJson(keyPath) {
  const edgeCache = getEdgeCache();
  if (!edgeCache || !keyPath) return null;
  try {
    const req = new Request(`${EDGE_CACHE_ORIGIN}${keyPath}`);
    const res = await edgeCache.match(req);
    if (!res) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeEdgeCacheJson(keyPath, payload, maxAge = 604800) {
  const edgeCache = getEdgeCache();
  if (!edgeCache || !keyPath || !payload) return;
  try {
    const req = new Request(`${EDGE_CACHE_ORIGIN}${keyPath}`);
    const res = new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${maxAge}`
      }
    });
    await edgeCache.put(req, res);
  } catch {}
}

/**
 * Edge Metrics Aggregator (keeps /admin and /health stats accurate across Worker restarts even without D1)
 */
async function updateEdgeMetrics(env, { userId = null, addDownload = false, addCacheId = null } = {}) {
  if ((env && env.DB) || (isNodeSqlite && db)) return;
  const edgeCache = getEdgeCache();
  if (!edgeCache) return;

  try {
    let isNewUser = false;
    if (userId) {
      const uid = String(userId);
      const seenUser = await readEdgeCacheJson(`/user_seen/${encodeURIComponent(uid)}`);
      if (!seenUser) {
        isNewUser = true;
        await writeEdgeCacheJson(`/user_seen/${encodeURIComponent(uid)}`, { id: uid, t: Date.now() }, 2592000);
      }
    }

    let isNewCache = false;
    if (addCacheId) {
      const cid = String(addCacheId);
      const seenCache = await readEdgeCacheJson(`/cache_seen/${encodeURIComponent(cid)}`);
      if (!seenCache) {
        isNewCache = true;
        await writeEdgeCacheJson(`/cache_seen/${encodeURIComponent(cid)}`, { id: cid, t: Date.now() }, 2592000);
      }
    }

    if (!isNewUser && !addDownload && !isNewCache) return;

    const current = (await readEdgeCacheJson('/metrics/global')) || {
      users: 0,
      downloads: 0,
      cachedVideos: 0
    };

    const next = {
      users: Math.max(Number(current.users || 0) + (isNewUser ? 1 : 0), memoryStore.users.size),
      downloads: Number(current.downloads || 0) + (addDownload ? 1 : 0),
      cachedVideos: Math.max(Number(current.cachedVideos || 0) + (isNewCache ? 1 : 0), memoryStore.cache.size)
    };

    await writeEdgeCacheJson('/metrics/global', next, 2592000);
  } catch {}
}

/**
 * Deduplicate Telegram Webhook retries (prevents double video delivery if upload takes >5s)
 */
const processedUpdatesMem = new Map();

export async function claimUpdateId(updateId) {
  if (updateId === undefined || updateId === null) return true;
  const key = String(updateId);

  if (processedUpdatesMem.has(key)) return false;
  setBoundedMap(processedUpdatesMem, key, Date.now(), 1000);

  const edgeCache = getEdgeCache();
  if (edgeCache) {
    try {
      const hit = await readEdgeCacheJson(`/dedup/update_${encodeURIComponent(key)}`);
      if (hit) return false;
      await writeEdgeCacheJson(`/dedup/update_${encodeURIComponent(key)}`, { ok: 1 }, 600);
    } catch {}
  }

  return true;
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

  const existing = memoryStore.users.get(id) || { id, downloads_count: 0, created_at: now };
  existing.username = username;
  existing.first_name = firstName;
  existing.last_active_at = now;
  setBoundedMap(memoryStore.users, id, existing, MAX_MEM_USERS);

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
      return;
    } catch (e) {
      console.warn('upsertUser sqlite error:', e.message);
    }
  }

  // 3. Edge Cache metrics
  await updateEdgeMetrics(env, { userId: id });
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
      return;
    } catch {}
  }

  await updateEdgeMetrics(env, { userId: id, addDownload: true });
}

/**
 * Get cached video/audio entry by TikTok ID
 */
export async function getCachedVideo(videoId, env) {
  if (!videoId) return null;
  const vid = String(videoId);

  const mem = memoryStore.cache.get(vid);

  let baseRow = null;
  if (env && env.DB) {
    try {
      baseRow = await env.DB.prepare(`SELECT * FROM video_cache WHERE video_id = ?`).bind(vid).first();
    } catch {}
  } else if (isNodeSqlite && db) {
    try {
      baseRow = db.prepare(`SELECT * FROM video_cache WHERE video_id = ?`).get(vid);
    } catch {}
  }

  const edge = await readEdgeCacheJson(`/video/${encodeURIComponent(vid)}`);

  if (baseRow || edge || mem) {
    const merged = {
      ...(edge || {}),
      ...(mem || {}),
      ...(baseRow || {})
    };
    merged.file_id = baseRow?.file_id || edge?.file_id || mem?.file_id || '';
    merged.audio_file_id = baseRow?.audio_file_id || edge?.audio_file_id || mem?.audio_file_id || null;
    merged.audio_url = baseRow?.audio_url || edge?.audio_url || mem?.audio_url || null;
    merged.music_title = baseRow?.music_title || edge?.music_title || mem?.music_title || null;
    merged.width = baseRow?.width || edge?.width || mem?.width || undefined;
    merged.height = baseRow?.height || edge?.height || mem?.height || undefined;
    merged.duration = baseRow?.duration || edge?.duration || mem?.duration || undefined;

    setBoundedMap(memoryStore.cache, vid, merged, MAX_MEM_CACHE);
    return merged;
  }

  return null;
}

/**
 * Cache video file_id and extended stream metadata
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
    music_title: extra.musicTitle || prev.music_title || null,
    width: extra.width || prev.width || undefined,
    height: extra.height || prev.height || undefined,
    duration: extra.duration || prev.duration || undefined
  };

  setBoundedMap(memoryStore.cache, vid, merged, MAX_MEM_CACHE);
  await writeEdgeCacheJson(`/video/${encodeURIComponent(vid)}`, merged, 604800);

  if (!merged.file_id) return;

  await updateEdgeMetrics(env, { addCacheId: vid });

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
        INSERT INTO video_cache (video_id, title, file_id, audio_url, music_title, width, height, duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          file_id = excluded.file_id,
          audio_url = COALESCE(excluded.audio_url, video_cache.audio_url),
          music_title = COALESCE(excluded.music_title, video_cache.music_title),
          width = COALESCE(excluded.width, video_cache.width),
          height = COALESCE(excluded.height, video_cache.height),
          duration = COALESCE(excluded.duration, video_cache.duration);
      `).run(
        vid,
        merged.title,
        merged.file_id,
        merged.audio_url,
        merged.music_title,
        merged.width || null,
        merged.height || null,
        merged.duration || null,
        now
      );
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
 * Cache extracted audio file_id (works for both video posts AND photo carousels!)
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
    title: prev.title || title,
    audio_file_id: afid
  };

  setBoundedMap(memoryStore.cache, vid, merged, MAX_MEM_CACHE);
  await writeEdgeCacheJson(`/video/${encodeURIComponent(vid)}`, merged, 604800);

  // 1. Cloudflare D1 priority — UPSERT so photo carousels (which have no video row yet) also persist audio_file_id!
  if (env && env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, audio_file_id, created_at)
        VALUES (?, ?, '', ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          audio_file_id = excluded.audio_file_id;
      `).bind(vid, merged.title, afid, now).run();
      return;
    } catch {}
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, audio_file_id, created_at)
        VALUES (?, ?, '', ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          audio_file_id = excluded.audio_file_id;
      `).run(vid, merged.title, afid, now);
    } catch {}
  }
}

/**
 * Short-Link -> Video ID Cache (makes repeated vt.tiktok.com / vm.tiktok.com links resolve in <0.2s with 0 scraper calls!)
 */
const shortLinkMem = new Map();

export async function getCachedShortLink(shortUrl) {
  if (!shortUrl) return null;
  const key = String(shortUrl).trim();
  if (shortLinkMem.has(key)) return shortLinkMem.get(key);

  const edgeHit = await readEdgeCacheJson(`/shortlink/${encodeURIComponent(key)}`);
  if (edgeHit?.videoId) {
    setBoundedMap(shortLinkMem, key, edgeHit.videoId, MAX_MEM_CACHE);
    return edgeHit.videoId;
  }
  return null;
}

export async function setCachedShortLink(shortUrl, videoId) {
  if (!shortUrl || !videoId) return;
  const key = String(shortUrl).trim();
  const vid = String(videoId).trim();
  setBoundedMap(shortLinkMem, key, vid, MAX_MEM_CACHE);
  await writeEdgeCacheJson(`/shortlink/${encodeURIComponent(key)}`, { videoId: vid }, 604800);
}

/**
 * Get aggregate statistics (Admin only & /health)
 */
export async function getStats(env) {
  if (env && env.DB) {
    try {
      const uRow = await env.DB.prepare(`SELECT COUNT(*) as users, COALESCE(SUM(downloads_count), 0) as downloads FROM users`).first();
      const cRow = await env.DB.prepare(`SELECT COUNT(*) as cached FROM video_cache WHERE file_id != ''`).first();
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
      const cRow = db.prepare(`SELECT COUNT(*) as cached FROM video_cache WHERE file_id != ''`).get();
      return {
        users: Number(uRow?.users || 0),
        downloads: Number(uRow?.downloads || 0),
        cachedVideos: Number(cRow?.cached || 0)
      };
    } catch (e) {
      console.warn('getStats sqlite error:', e.message);
    }
  }

  let memDownloads = 0;
  for (const u of memoryStore.users.values()) {
    memDownloads += u.downloads_count || 0;
  }

  const edgeMetrics = await readEdgeCacheJson('/metrics/global');
  if (edgeMetrics) {
    return {
      users: Math.max(Number(edgeMetrics.users || 0), memoryStore.users.size),
      downloads: Math.max(Number(edgeMetrics.downloads || 0), memDownloads),
      cachedVideos: Math.max(Number(edgeMetrics.cachedVideos || 0), memoryStore.cache.size)
    };
  }

  return {
    users: memoryStore.users.size,
    downloads: memDownloads,
    cachedVideos: memoryStore.cache.size
  };
}
