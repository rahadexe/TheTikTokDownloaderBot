import path from 'path';
import { fileURLToPath } from 'url';

let db = null;
let isNodeSqlite = false;
let d1Initialized = false;

const CORE_SCHEMA_SQL = `
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

  CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS server_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER DEFAULT 0,
    username TEXT,
    url TEXT,
    error_type TEXT,
    error_message TEXT,
    platform TEXT DEFAULT 'TikTok',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

const MIGRATION_COLUMNS = [
  `ALTER TABLE video_cache ADD COLUMN file_unique_id TEXT;`,
  `ALTER TABLE video_cache ADD COLUMN audio_unique_id TEXT;`,
  `ALTER TABLE video_cache ADD COLUMN photo_file_ids TEXT;`,
  `ALTER TABLE video_cache ADD COLUMN audio_url TEXT;`,
  `ALTER TABLE video_cache ADD COLUMN music_title TEXT;`,
  `ALTER TABLE video_cache ADD COLUMN width INTEGER;`,
  `ALTER TABLE video_cache ADD COLUMN height INTEGER;`,
  `ALTER TABLE video_cache ADD COLUMN duration INTEGER;`,
  `ALTER TABLE video_cache ADD COLUMN hits INTEGER DEFAULT 1;`
];

// Initialize SQLite for Node.js environments (long polling / local testing)
try {
  const { DatabaseSync } = await import('node:sqlite');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dbPath = path.join(__dirname, '..', 'tiktok.sqlite');
  db = new DatabaseSync(dbPath);
  isNodeSqlite = true;

  db.exec(CORE_SCHEMA_SQL);
  for (const sql of MIGRATION_COLUMNS) {
    try { db.exec(sql); } catch {}
  }
} catch {
  isNodeSqlite = false;
}

let d1InitPromise = null;

/**
 * Auto-migrate Cloudflare D1 tables when env.DB binding is attached (Single Batch Roundtrip + Shared Promise)
 */
export async function ensureD1Schema(env) {
  if (!env?.DB || d1Initialized) return;
  if (!d1InitPromise) {
    d1InitPromise = (async () => {
      try {
        if (typeof env.DB.exec === 'function') {
          await env.DB.exec(CORE_SCHEMA_SQL);
        } else {
          const statements = CORE_SCHEMA_SQL
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean);
          const batch = statements.map((stmt) => env.DB.prepare(stmt));
          await env.DB.batch(batch);
        }
      } catch {
        try {
          const statements = CORE_SCHEMA_SQL
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean);
          for (const stmt of statements) {
            await env.DB.prepare(stmt).run().catch(() => {});
          }
        } catch {}
      }
      d1Initialized = true;
    })();
  }
  return d1InitPromise;
}

// Bounded L1 In-Memory LRU Store (prevents Worker memory growth under heavy traffic)
const MAX_MEM_USERS = 2500;
const MAX_MEM_CACHE = 1500;
const EDGE_MEDIA_TTL = 2592000; // 30 days persistent Cloudflare Edge Cache

const memoryStore = {
  users: new Map(),
  cache: new Map(),
  links: new Map(),
  history: new Map()
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

async function writeEdgeCacheJson(keyPath, payload, maxAge = EDGE_MEDIA_TTL) {
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

async function deleteEdgeCacheKey(keyPath) {
  const edgeCache = getEdgeCache();
  if (!edgeCache || !keyPath) return;
  try {
    const req = new Request(`${EDGE_CACHE_ORIGIN}${keyPath}`);
    await edgeCache.delete(req);
  } catch {}
}

/**
 * Optional Cloudflare KV Helpers (if operator binds env.CACHE_KV later   zero config required)
 */
async function readKvJson(env, key) {
  if (!env?.CACHE_KV || !key) return null;
  try {
    return await env.CACHE_KV.get(key, { type: 'json' });
  } catch {
    return null;
  }
}

async function writeKvJson(env, key, value, expirationTtl = EDGE_MEDIA_TTL) {
  if (!env?.CACHE_KV || !key || !value) return;
  try {
    await env.CACHE_KV.put(key, JSON.stringify(value), { expirationTtl });
  } catch {}
}

async function deleteKvKey(env, key) {
  if (!env?.CACHE_KV || !key) return;
  try {
    await env.CACHE_KV.delete(key);
  } catch {}
}

/**
 * Edge Metrics Aggregator (keeps /admin and /health stats accurate across Worker restarts even without D1)
 */
async function updateEdgeMetrics(env, { userId = null, addDownload = false, addCacheId = null, addCacheHit = false } = {}) {
  const edgeCache = getEdgeCache();
  if (!edgeCache && !env?.CACHE_KV) return;

  try {
    let isNewUser = false;
    if (userId) {
      const uid = String(userId);
      const seenUser = (await readEdgeCacheJson(`/user_seen/${encodeURIComponent(uid)}`)) || (await readKvJson(env, `u:${uid}`));
      if (!seenUser) {
        isNewUser = true;
        await writeEdgeCacheJson(`/user_seen/${encodeURIComponent(uid)}`, { id: uid, t: Date.now() }, EDGE_MEDIA_TTL);
        await writeKvJson(env, `u:${uid}`, { id: uid, t: Date.now() }, EDGE_MEDIA_TTL);
      }
    }

    let isNewCache = false;
    if (addCacheId) {
      const cid = String(addCacheId);
      const seenCache = (await readEdgeCacheJson(`/cache_seen/${encodeURIComponent(cid)}`)) || (await readKvJson(env, `c:${cid}`));
      if (!seenCache) {
        isNewCache = true;
        await writeEdgeCacheJson(`/cache_seen/${encodeURIComponent(cid)}`, { id: cid, t: Date.now() }, EDGE_MEDIA_TTL);
        await writeKvJson(env, `c:${cid}`, { id: cid, t: Date.now() }, EDGE_MEDIA_TTL);
      }
    }

    if (!isNewUser && !addDownload && !isNewCache && !addCacheHit) return;

    const current =
      (await readEdgeCacheJson('/metrics/global')) ||
      (await readKvJson(env, 'metrics:global')) || {
        users: 0,
        downloads: 0,
        cachedVideos: 0,
        cacheHits: 0
      };

    const next = {
      users: Math.max(Number(current.users || 0) + (isNewUser ? 1 : 0), memoryStore.users.size),
      downloads: Number(current.downloads || 0) + (addDownload ? 1 : 0),
      cachedVideos: Math.max(Number(current.cachedVideos || 0) + (isNewCache ? 1 : 0), memoryStore.cache.size),
      cacheHits: Number(current.cacheHits || 0) + (addCacheHit ? 1 : 0)
    };

    await writeEdgeCacheJson('/metrics/global', next, EDGE_MEDIA_TTL);
    await writeKvJson(env, 'metrics:global', next, EDGE_MEDIA_TTL);
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
  await ensureD1Schema(env);

  const id = Number(user.id);
  const username = user.username || '';
  const firstName = user.first_name || '';
  const now = new Date().toISOString();

  const existing = memoryStore.users.get(id) || { id, downloads_count: 0, created_at: now };
  existing.username = username;
  existing.first_name = firstName;
  existing.last_active_at = now;
  setBoundedMap(memoryStore.users, id, existing, MAX_MEM_USERS);

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

  await updateEdgeMetrics(env, { userId: id });
}

/**
 * Record user download + store link/video history per user
 */
export async function incrementUserDownloads(userId, env, details = {}) {
  if (!userId) return;
  await ensureD1Schema(env);
  const id = Number(userId);
  const videoId = details.videoId ? String(details.videoId) : '';
  const sourceUrl = details.sourceUrl ? String(details.sourceUrl) : '';
  const mediaType = details.mediaType || 'video';
  const fromCache = Boolean(details.fromCache);
  const now = new Date().toISOString();

  const u = memoryStore.users.get(id);
  if (u) u.downloads_count = (u.downloads_count || 0) + 1;

  // Record user's recent 30 downloaded videos/links in L1 + Edge Cache
  if (videoId || sourceUrl) {
    const entry = { videoId, sourceUrl, mediaType, at: now };
    const list = memoryStore.history.get(id) || (await readEdgeCacheJson(`/user_history/${id}`)) || [];
    const filtered = Array.isArray(list) ? list.filter((x) => x.videoId !== videoId).slice(0, 29) : [];
    filtered.unshift(entry);
    setBoundedMap(memoryStore.history, id, filtered, MAX_MEM_USERS);
    await writeEdgeCacheJson(`/user_history/${id}`, filtered, EDGE_MEDIA_TTL);
    await writeKvJson(env, `hist:${id}`, filtered, EDGE_MEDIA_TTL);
  }

  if (fromCache && videoId) {
    if (env?.DB) {
      await env.DB.prepare(`UPDATE video_cache SET hits = COALESCE(hits, 1) + 1 WHERE video_id = ?`).bind(videoId).run().catch(() => {});
    } else if (isNodeSqlite && db) {
      try { db.prepare(`UPDATE video_cache SET hits = COALESCE(hits, 1) + 1 WHERE video_id = ?`).run(videoId); } catch {}
    }
  }

  if (env && env.DB) {
    try {
      await env.DB.prepare(`UPDATE users SET downloads_count = downloads_count + 1 WHERE id = ?`).bind(id).run();
      if (videoId) {
        await env.DB.prepare(
          `INSERT INTO user_downloads (user_id, video_id, source_url, media_type, created_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(id, videoId, sourceUrl, mediaType, now).run().catch(() => {});
      }
      await updateEdgeMetrics(env, { addCacheHit: fromCache });
      return;
    } catch {}
  }

  if (isNodeSqlite && db) {
    try {
      db.prepare(`UPDATE users SET downloads_count = downloads_count + 1 WHERE id = ?`).run(id);
      if (videoId) {
        db.prepare(
          `INSERT INTO user_downloads (user_id, video_id, source_url, media_type, created_at) VALUES (?, ?, ?, ?, ?)`
        ).run(id, videoId, sourceUrl, mediaType, now);
      }
      await updateEdgeMetrics(env, { addCacheHit: fromCache });
      return;
    } catch {}
  }

  await updateEdgeMetrics(env, { userId: id, addDownload: true, addCacheHit: fromCache });
}

function parsePhotoFileIds(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get cached video/audio/photo entry by TikTok ID across L1 Memory -> D1/SQLite -> KV -> Cloudflare Edge Cache
 */
export async function getCachedVideo(videoId, env) {
  if (!videoId) return null;
  await ensureD1Schema(env);
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

  const edge = (await readEdgeCacheJson(`/video/${encodeURIComponent(vid)}`)) || (await readKvJson(env, `vid:${vid}`));

  if (baseRow || edge || mem) {
    const merged = {
      ...(edge || {}),
      ...(mem || {}),
      ...(baseRow || {})
    };
    merged.video_id = vid;
    merged.file_id = baseRow?.file_id || edge?.file_id || mem?.file_id || '';
    merged.file_unique_id = baseRow?.file_unique_id || edge?.file_unique_id || mem?.file_unique_id || null;
    merged.audio_file_id = baseRow?.audio_file_id || edge?.audio_file_id || mem?.audio_file_id || null;
    merged.audio_unique_id = baseRow?.audio_unique_id || edge?.audio_unique_id || mem?.audio_unique_id || null;
    merged.photo_file_ids =
      parsePhotoFileIds(baseRow?.photo_file_ids) ||
      parsePhotoFileIds(edge?.photo_file_ids) ||
      parsePhotoFileIds(mem?.photo_file_ids) ||
      null;
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
 * Cache video/photo Telegram file_id, file_unique_id, and stream metadata (30-day TTL on Edge/KV + permanent D1/SQLite)
 */
export async function setCachedVideo(videoId, title, fileId, env, extra = {}) {
  if (!videoId) return;
  await ensureD1Schema(env);
  const vid = String(videoId);
  const t = title || 'TikTok Video';
  const fid = fileId ? String(fileId) : '';
  const now = new Date().toISOString();

  const prev = (await getCachedVideo(vid, env)) || { video_id: vid, created_at: now };
  const photoIds = Array.isArray(extra.photoFileIds) && extra.photoFileIds.length > 0
    ? extra.photoFileIds
    : prev.photo_file_ids || null;

  const merged = {
    ...prev,
    video_id: vid,
    title: t || prev.title || 'TikTok Video',
    file_id: fid || prev.file_id || '',
    file_unique_id: extra.fileUniqueId || prev.file_unique_id || null,
    photo_file_ids: photoIds,
    audio_url: extra.audioUrl || prev.audio_url || null,
    music_title: extra.musicTitle || prev.music_title || null,
    width: extra.width || prev.width || undefined,
    height: extra.height || prev.height || undefined,
    duration: extra.duration || prev.duration || undefined
  };

  setBoundedMap(memoryStore.cache, vid, merged, MAX_MEM_CACHE);
  await writeEdgeCacheJson(`/video/${encodeURIComponent(vid)}`, merged, EDGE_MEDIA_TTL);
  await writeKvJson(env, `vid:${vid}`, merged, EDGE_MEDIA_TTL);

  const hasMediaHandle = Boolean(merged.file_id || (merged.photo_file_ids && merged.photo_file_ids.length > 0));
  if (!hasMediaHandle && !merged.audio_url) return;

  if (hasMediaHandle) {
    await updateEdgeMetrics(env, { addCacheId: vid });
  }

  const serializedPhotos = merged.photo_file_ids ? JSON.stringify(merged.photo_file_ids) : null;

  // 1. Cloudflare D1 priority
  if (env && env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, file_unique_id, photo_file_ids, audio_url, music_title, width, height, duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          file_id = CASE WHEN excluded.file_id != '' THEN excluded.file_id ELSE video_cache.file_id END,
          file_unique_id = COALESCE(excluded.file_unique_id, video_cache.file_unique_id),
          photo_file_ids = COALESCE(excluded.photo_file_ids, video_cache.photo_file_ids),
          audio_url = COALESCE(excluded.audio_url, video_cache.audio_url),
          music_title = COALESCE(excluded.music_title, video_cache.music_title),
          width = COALESCE(excluded.width, video_cache.width),
          height = COALESCE(excluded.height, video_cache.height),
          duration = COALESCE(excluded.duration, video_cache.duration);
      `).bind(
        vid,
        merged.title,
        merged.file_id || '',
        merged.file_unique_id,
        serializedPhotos,
        merged.audio_url,
        merged.music_title,
        merged.width || null,
        merged.height || null,
        merged.duration || null,
        now
      ).run();
      return;
    } catch {
      try {
        if (merged.file_id) {
          await env.DB.prepare(`
            INSERT INTO video_cache (video_id, title, file_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET title = excluded.title, file_id = excluded.file_id;
          `).bind(vid, merged.title, merged.file_id, now).run();
        }
        return;
      } catch (e) {
        console.warn('setCachedVideo D1 error:', e.message);
      }
    }
  }

  // 2. Node.js SQLite
  if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, file_unique_id, photo_file_ids, audio_url, music_title, width, height, duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          file_id = CASE WHEN excluded.file_id != '' THEN excluded.file_id ELSE video_cache.file_id END,
          file_unique_id = COALESCE(excluded.file_unique_id, video_cache.file_unique_id),
          photo_file_ids = COALESCE(excluded.photo_file_ids, video_cache.photo_file_ids),
          audio_url = COALESCE(excluded.audio_url, video_cache.audio_url),
          music_title = COALESCE(excluded.music_title, video_cache.music_title),
          width = COALESCE(excluded.width, video_cache.width),
          height = COALESCE(excluded.height, video_cache.height),
          duration = COALESCE(excluded.duration, video_cache.duration);
      `).run(
        vid,
        merged.title,
        merged.file_id || '',
        merged.file_unique_id,
        serializedPhotos,
        merged.audio_url,
        merged.music_title,
        merged.width || null,
        merged.height || null,
        merged.duration || null,
        now
      );
    } catch (e) {
      console.warn('setCachedVideo sqlite error:', e.message);
    }
  }
}

/**
 * Self-Healing Cache Eviction:
 * If Telegram ever invalidates a cached file_id ("wrong file identifier" / token rotated),
 * purge the stale handle immediately so the bot auto-reuploads & repairs the cache transparently!
 */
export async function invalidateCachedMedia(videoId, env, field = 'video') {
  if (!videoId) return;
  await ensureD1Schema(env);
  const vid = String(videoId);

  const existing = await getCachedVideo(vid, env);
  if (existing) {
    if (field === 'audio') {
      existing.audio_file_id = null;
      existing.audio_unique_id = null;
    } else if (field === 'photo') {
      existing.photo_file_ids = null;
    } else {
      existing.file_id = '';
      existing.file_unique_id = null;
    }
    setBoundedMap(memoryStore.cache, vid, existing, MAX_MEM_CACHE);
    await writeEdgeCacheJson(`/video/${encodeURIComponent(vid)}`, existing, EDGE_MEDIA_TTL);
    await writeKvJson(env, `vid:${vid}`, existing, EDGE_MEDIA_TTL);
  } else {
    memoryStore.cache.delete(vid);
    await deleteEdgeCacheKey(`/video/${encodeURIComponent(vid)}`);
    await deleteKvKey(env, `vid:${vid}`);
  }

  const col = field === 'audio' ? 'audio_file_id = NULL' : field === 'photo' ? 'photo_file_ids = NULL' : "file_id = ''";
  if (env?.DB) {
    await env.DB.prepare(`UPDATE video_cache SET ${col} WHERE video_id = ?`).bind(vid).run().catch(() => {});
  } else if (isNodeSqlite && db) {
    try { db.prepare(`UPDATE video_cache SET ${col} WHERE video_id = ?`).run(vid); } catch {}
  }
}

/**
 * Cache extracted audio file_id + audio_unique_id
 */
export async function setCachedAudio(videoId, audioFileId, env, title = 'TikTok Audio', audioUniqueId = null) {
  if (!videoId || !audioFileId) return;
  await ensureD1Schema(env);
  const vid = String(videoId);
  const afid = String(audioFileId);
  const now = new Date().toISOString();

  const prev = (await getCachedVideo(vid, env)) || { video_id: vid, title, file_id: '', created_at: now };
  const merged = {
    ...prev,
    video_id: vid,
    title: prev.title || title,
    audio_file_id: afid,
    audio_unique_id: audioUniqueId || prev.audio_unique_id || null
  };

  setBoundedMap(memoryStore.cache, vid, merged, MAX_MEM_CACHE);
  await writeEdgeCacheJson(`/video/${encodeURIComponent(vid)}`, merged, EDGE_MEDIA_TTL);
  await writeKvJson(env, `vid:${vid}`, merged, EDGE_MEDIA_TTL);

  if (env && env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, audio_file_id, audio_unique_id, created_at)
        VALUES (?, ?, '', ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          audio_file_id = excluded.audio_file_id,
          audio_unique_id = COALESCE(excluded.audio_unique_id, video_cache.audio_unique_id);
      `).bind(vid, merged.title, afid, merged.audio_unique_id, now).run();
      return;
    } catch {
      await env.DB.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, audio_file_id, created_at)
        VALUES (?, ?, '', ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET audio_file_id = excluded.audio_file_id;
      `).bind(vid, merged.title, afid, now).run().catch(() => {});
      return;
    }
  }

  if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO video_cache (video_id, title, file_id, audio_file_id, audio_unique_id, created_at)
        VALUES (?, ?, '', ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          audio_file_id = excluded.audio_file_id,
          audio_unique_id = COALESCE(excluded.audio_unique_id, video_cache.audio_unique_id);
      `).run(vid, merged.title, afid, merged.audio_unique_id, now);
    } catch {}
  }
}

/**
 * Universal Link -> Video ID Mapping Cache (L1 Memory + D1 + SQLite + KV + Edge Cache)
 * Maps EVERY variation (vt.tiktok.com, vm.tiktok.com, /t/..., canonical URL) to the TikTok video_id!
 */
export async function getCachedShortLink(shortUrl, env) {
  if (!shortUrl) return null;
  await ensureD1Schema(env);
  const key = String(shortUrl).trim();

  if (memoryStore.links.has(key)) return memoryStore.links.get(key);

  if (env?.DB) {
    try {
      const row = await env.DB.prepare(`SELECT video_id FROM link_cache WHERE url_key = ?`).bind(key).first();
      if (row?.video_id) {
        setBoundedMap(memoryStore.links, key, row.video_id, MAX_MEM_CACHE);
        return row.video_id;
      }
    } catch {}
  } else if (isNodeSqlite && db) {
    try {
      const row = db.prepare(`SELECT video_id FROM link_cache WHERE url_key = ?`).get(key);
      if (row?.video_id) {
        setBoundedMap(memoryStore.links, key, row.video_id, MAX_MEM_CACHE);
        return row.video_id;
      }
    } catch {}
  }

  const edgeHit = (await readEdgeCacheJson(`/shortlink/${encodeURIComponent(key)}`)) || (await readKvJson(env, `lnk:${key}`));
  if (edgeHit?.videoId) {
    setBoundedMap(memoryStore.links, key, edgeHit.videoId, MAX_MEM_CACHE);
    return edgeHit.videoId;
  }
  return null;
}

export async function setCachedShortLink(shortUrl, videoId, env) {
  if (!shortUrl || !videoId) return;
  await ensureD1Schema(env);
  const key = String(shortUrl).trim();
  const vid = String(videoId).trim();
  const now = new Date().toISOString();

  setBoundedMap(memoryStore.links, key, vid, MAX_MEM_CACHE);
  await writeEdgeCacheJson(`/shortlink/${encodeURIComponent(key)}`, { videoId: vid }, EDGE_MEDIA_TTL);
  await writeKvJson(env, `lnk:${key}`, { videoId: vid }, EDGE_MEDIA_TTL);

  if (env?.DB) {
    await env.DB.prepare(`
      INSERT INTO link_cache (url_key, video_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(url_key) DO UPDATE SET video_id = excluded.video_id;
    `).bind(key, vid, now).run().catch(() => {});
  } else if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO link_cache (url_key, video_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(url_key) DO UPDATE SET video_id = excluded.video_id;
      `).run(key, vid, now);
    } catch {}
  }
}

/**
 * Get aggregate statistics (Admin only & /health)
 */
export async function getStats(env) {
  await ensureD1Schema(env);
  const edgeMetrics = (await readEdgeCacheJson('/metrics/global')) || (await readKvJson(env, 'metrics:global'));

  if (env && env.DB) {
    try {
      const uRow = await env.DB.prepare(`SELECT COUNT(*) as users, COALESCE(SUM(downloads_count), 0) as downloads FROM users`).first();
      const cRow = await env.DB.prepare(
        `SELECT COUNT(*) as cached, COALESCE(SUM(hits - 1), 0) as hits FROM video_cache WHERE file_id != '' OR photo_file_ids IS NOT NULL`
      ).first();
      return {
        users: Number(uRow?.users || 0),
        downloads: Number(uRow?.downloads || 0),
        cachedVideos: Number(cRow?.cached || 0),
        cacheHits: Math.max(Number(cRow?.hits || 0), Number(edgeMetrics?.cacheHits || 0))
      };
    } catch {}
  }

  if (isNodeSqlite && db) {
    try {
      const uRow = db.prepare(`SELECT COUNT(*) as users, COALESCE(SUM(downloads_count), 0) as downloads FROM users`).get();
      const cRow = db.prepare(
        `SELECT COUNT(*) as cached, COALESCE(SUM(CASE WHEN hits > 1 THEN hits - 1 ELSE 0 END), 0) as hits FROM video_cache WHERE file_id != '' OR photo_file_ids IS NOT NULL`
      ).get();
      return {
        users: Number(uRow?.users || 0),
        downloads: Number(uRow?.downloads || 0),
        cachedVideos: Number(cRow?.cached || 0),
        cacheHits: Math.max(Number(cRow?.hits || 0), Number(edgeMetrics?.cacheHits || 0))
      };
    } catch (e) {
      console.warn('getStats sqlite error:', e.message);
    }
  }

  let memDownloads = 0;
  for (const u of memoryStore.users.values()) {
    memDownloads += u.downloads_count || 0;
  }

  if (edgeMetrics) {
    return {
      users: Math.max(Number(edgeMetrics.users || 0), memoryStore.users.size),
      downloads: Math.max(Number(edgeMetrics.downloads || 0), memDownloads),
      cachedVideos: Math.max(Number(edgeMetrics.cachedVideos || 0), memoryStore.cache.size),
      cacheHits: Number(edgeMetrics.cacheHits || 0)
    };
  }

  return {
    users: memoryStore.users.size,
    downloads: memDownloads,
    cachedVideos: memoryStore.cache.size,
    cacheHits: 0
  };
}

/**
 * Dynamic Bot Settings (L1 Memory + D1 + SQLite)
 */
export async function getSetting(key, env, fallback = null) {
  if (!key) return fallback;
  const memKey = `setting:${key}`;
  if (memoryStore.cache.has(memKey)) {
    return memoryStore.cache.get(memKey);
  }
  await ensureD1Schema(env);
  if (env?.DB) {
    try {
      const row = await env.DB.prepare('SELECT value FROM bot_settings WHERE key = ?').bind(key).first();
      if (row && row.value !== undefined) {
        setBoundedMap(memoryStore.cache, memKey, row.value, 100);
        return row.value;
      }
    } catch {}
  } else if (isNodeSqlite && db) {
    try {
      const row = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(key);
      if (row && row.value !== undefined) {
        setBoundedMap(memoryStore.cache, memKey, row.value, 100);
        return row.value;
      }
    } catch {}
  }
  return fallback;
}

export async function setSetting(key, value, env) {
  if (!key) return;
  const memKey = `setting:${key}`;
  const valStr = String(value);
  setBoundedMap(memoryStore.cache, memKey, valStr, 100);
  await ensureD1Schema(env);
  const now = new Date().toISOString();
  if (env?.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO bot_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(key, valStr, now).run();
    } catch (e) {
      console.warn('setSetting D1 error:', e.message);
    }
  } else if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO bot_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, valStr, now);
    } catch (e) {
      console.warn('setSetting sqlite error:', e.message);
    }
  }
}

/**
 * Force-Sub User Verification & Pending Link Store (Memory + Fast TTL)
 */
const verifiedUsersMem = new Map();
const pendingUserLinks = new Map();

export function isUserVerifiedMemory(userId) {
  if (!userId) return false;
  const exp = verifiedUsersMem.get(Number(userId));
  return Boolean(exp && exp > Date.now());
}

export function setUserVerifiedMemory(userId, durationMs = 30000) { // 30 seconds default window
  if (!userId) return;
  setBoundedMap(verifiedUsersMem, Number(userId), Date.now() + durationMs, 5000);
}

export function revokeUserVerifiedMemory(userId) {
  if (!userId) return;
  verifiedUsersMem.delete(Number(userId));
  pendingUserLinks.delete(Number(userId));
}

export function clearVerifiedUsersMemory() {
  verifiedUsersMem.clear();
}

export function setPendingLink(userId, url) {
  if (!userId || !url) return;
  setBoundedMap(pendingUserLinks, Number(userId), url, 2000);
}

export function getPendingLink(userId) {
  if (!userId) return null;
  return pendingUserLinks.get(Number(userId)) || null;
}

export function clearPendingLink(userId) {
  if (!userId) return;
  pendingUserLinks.delete(Number(userId));
}

export async function getConnectedChats(env) {
  const raw = await getSetting('connected_chats', env, null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  const single = await getSetting('force_sub_channel', env, null);
  if (single && single !== 'off' && single !== 'none') {
    const cleanTag = single.startsWith('@') || single.startsWith('-') ? single : '@' + single;
    return [{ target: cleanTag, title: cleanTag, chat_key: cleanTag }];
  }
  const channelTag = env?.CHANNEL_USERNAME
    ? (env.CHANNEL_USERNAME.startsWith('@') ? env.CHANNEL_USERNAME : '@' + env.CHANNEL_USERNAME)
    : '@RHToolsOfficial';
  if (channelTag && channelTag !== 'off') {
    return [{ target: channelTag, title: channelTag, chat_key: channelTag }];
  }
  return [];
}

export async function saveConnectedChats(chats, env) {
  const list = Array.isArray(chats) ? chats : [];
  await setSetting('connected_chats', JSON.stringify(list), env);
  if (list.length > 0) {
    await setSetting('force_sub_channel', list[0].target, env);
  } else {
    await setSetting('force_sub_channel', 'off', env);
  }
  clearVerifiedUsersMemory();
}

export async function getAllUserIds(env) {
  await ensureD1Schema(env);
  if (env?.DB) {
    try {
      const res = await env.DB.prepare('SELECT id FROM users ORDER BY id ASC').all();
      return (res.results || []).map((r) => Number(r.id)).filter(Boolean);
    } catch {}
  } else if (isNodeSqlite && db) {
    try {
      const rows = db.prepare('SELECT id FROM users ORDER BY id ASC').all();
      return rows.map((r) => Number(r.id)).filter(Boolean);
    } catch {}
  }
  return Array.from(memoryStore.users.keys()).map(Number).filter(Boolean);
}

/**
 * Server Error / Activity Logging for Admin Panel
 */
export async function logServerError({ userId = 0, username = '', url = '', errorType = 'Error', errorMessage = '', platform = 'TikTok' }, env) {
  await ensureD1Schema(env);
  const now = new Date().toISOString();
  if (env?.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO server_errors (user_id, username, url, error_type, error_message, platform, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(Number(userId) || 0, String(username || ''), String(url || ''), String(errorType || ''), String(errorMessage || '').slice(0, 1000), String(platform || 'TikTok'), now).run();
    } catch (e) {
      console.warn('logServerError D1 error:', e.message);
    }
  } else if (isNodeSqlite && db) {
    try {
      db.prepare(`
        INSERT INTO server_errors (user_id, username, url, error_type, error_message, platform, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(Number(userId) || 0, String(username || ''), String(url || ''), String(errorType || ''), String(errorMessage || '').slice(0, 1000), String(platform || 'TikTok'), now);
    } catch (e) {
      console.warn('logServerError sqlite error:', e.message);
    }
  }
}

export async function getRecentServerErrors(limit = 15, env) {
  await ensureD1Schema(env);
  if (env?.DB) {
    try {
      const res = await env.DB.prepare(`
        SELECT id, user_id, username, url, error_type, error_message, platform, created_at
        FROM server_errors
        ORDER BY id DESC
        LIMIT ?
      `).bind(limit).all();
      return res.results || [];
    } catch {}
  } else if (isNodeSqlite && db) {
    try {
      const rows = db.prepare(`
        SELECT id, user_id, username, url, error_type, error_message, platform, created_at
        FROM server_errors
        ORDER BY id DESC
        LIMIT ?
      `).all(limit);
      return rows || [];
    } catch {}
  }
  return [];
}

export async function clearServerErrors(env) {
  await ensureD1Schema(env);
  if (env?.DB) {
    try {
      await env.DB.prepare('DELETE FROM server_errors').run();
    } catch {}
  } else if (isNodeSqlite && db) {
    try {
      db.prepare('DELETE FROM server_errors').run();
    } catch {}
  }
}
