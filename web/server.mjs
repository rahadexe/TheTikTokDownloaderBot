import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT || 8790;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg'
};

function sanitizeInputUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const match = raw.match(
    /(?:https?:\/\/|(?:^|[\s(])(?=(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/))(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[a-zA-Z0-9_./?=&%@#+-]+/i
  );
  let clean = (match ? match[0] : raw).trim().replace(/[.,;:!?)\]>]+$/, '');
  if (!/^https?:\/\//i.test(clean) && /tiktok\.com\//i.test(clean)) {
    clean = 'https://' + clean;
  }
  try {
    const u = new URL(clean);
    const host = u.hostname.toLowerCase();
    if (
      host === 'vt.tiktok.com' ||
      host === 'vm.tiktok.com' ||
      host === 'v.tiktok.com' ||
      u.pathname.includes('/video/') ||
      u.pathname.includes('/photo/') ||
      u.pathname.startsWith('/t/')
    ) {
      clean = `${u.origin}${u.pathname}`;
    }
  } catch {}
  return clean;
}

/**
 * Dual-Engine TikTok Extractor
 */
async function extractTikTok(url) {
  // Normalize URL
  const cleanUrl = sanitizeInputUrl(url);

  // Engine 1: TikWM API with HD + automatic 1.15s rate-limit retry
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}&hd=1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(9000)
      });

      if (res.ok) {
        const json = await res.json();
        if (json && json.code === -1 && attempt === 0 && /limit|second|busy/i.test(String(json.msg || ''))) {
          await new Promise((r) => setTimeout(r, 1150));
          continue;
        }
        if (json && json.code === 0 && json.data) {
          const d = json.data;
          return {
            success: true,
            id: d.id,
            title: d.title || 'TikTok Video',
            author: {
              nickname: d.author?.nickname || 'TikTok User',
              unique_id: d.author?.unique_id || '',
              avatar: d.author?.avatar || ''
            },
            cover: d.cover || '',
            duration: d.duration || 0,
            stats: {
              views: d.play_count || 0,
              likes: d.digg_count || 0,
              comments: d.comment_count || 0,
              shares: d.share_count || 0,
              downloads: d.download_count || 0
            },
            music: {
              title: d.music_info?.title || 'Original Sound',
              author: d.music_info?.author || '',
              play: d.music_info?.play || (d.music ? (d.music.startsWith('http') ? d.music : `https://www.tikwm.com${d.music}`) : '')
            },
            downloads: {
              hd_video: d.hdplay ? (d.hdplay.startsWith('http') ? d.hdplay : `https://www.tikwm.com${d.hdplay}`) : (d.play ? (d.play.startsWith('http') ? d.play : `https://www.tikwm.com${d.play}`) : ''),
              wm_video: d.wmplay ? (d.wmplay.startsWith('http') ? d.wmplay : `https://www.tikwm.com${d.wmplay}`) : '',
              fast_video: d.play ? (d.play.startsWith('http') ? d.play : `https://www.tikwm.com${d.play}`) : '',
              audio: d.music ? (d.music.startsWith('http') ? d.music : `https://www.tikwm.com${d.music}`) : (d.music_info?.play || ''),
              cover: d.cover || ''
            }
          };
        }
      }
      break;
    } catch (err) {
      if (attempt === 1) console.warn('[Extractor] TikWM failed:', err.message);
    }
  }

  // Engine 2: TikMate fallback
  try {
    const res2 = await fetch('https://api.tikmate.app/api/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: `url=${encodeURIComponent(cleanUrl)}`,
      signal: AbortSignal.timeout(9000)
    });

    if (res2.ok) {
      const d2 = await res2.json();
      if (d2 && d2.success && d2.token) {
        const hdToken = d2.hd_token || d2.token;
        return {
          success: true,
          id: d2.id,
          title: d2.desc || 'TikTok Video',
          author: {
            nickname: d2.author_name || 'TikTok User',
            unique_id: d2.author_id || '',
            avatar: d2.author_avatar || ''
          },
          cover: d2.cover || '',
          duration: 0,
          stats: {
            views: 0,
            likes: d2.like_count || 0,
            comments: d2.comment_count || 0,
            shares: d2.share_count || 0,
            downloads: 0
          },
          music: {
            title: 'Original Audio',
            author: '',
            play: ''
          },
          downloads: {
            hd_video: `https://tikmate.app/download/${hdToken}/${d2.id}.mp4?hd=1`,
            fast_video: `https://tikmate.app/download/${d2.token}/${d2.id}.mp4`,
            audio: '',
            cover: d2.cover || ''
          }
        };
      }
    }
  } catch (err2) {
    console.warn('[Extractor] TikMate failed:', err2.message);
  }

  return { success: false, error: 'Could not resolve TikTok video. Please ensure the link is public and valid.' };
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // 1. API: Extract TikTok
  if (pathname === '/api/extract') {
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Missing TikTok URL parameter.' }));
      return;
    }

    try {
      const result = await extractTikTok(targetUrl);
      res.writeHead(result.success ? 200 : 422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // 2. API: Proxy Download stream (forces browser download attachment with clean filename, supports fallback & inline preview)
  if (pathname === '/api/download') {
    const mediaUrl = reqUrl.searchParams.get('url');
    const fallbackUrl = reqUrl.searchParams.get('fallback');
    const isInline = reqUrl.searchParams.get('inline') === '1';
    const filename = reqUrl.searchParams.get('filename') || 'tiktok_media.mp4';
    if (!mediaUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing media URL parameter.');
      return;
    }

    try {
      const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Referer': 'https://www.tiktok.com/'
      };
      if (req.headers.range) {
        upstreamHeaders['Range'] = req.headers.range;
      }

      let mediaRes = await fetch(mediaUrl, { headers: upstreamHeaders });
      const contentLen = Number(mediaRes.headers.get('content-length') || 0);

      // Automatic fallback if HD CDN returns 503/403 or tiny 280-byte error stub
      if ((!mediaRes.ok || (contentLen > 0 && contentLen < 4096)) && fallbackUrl && fallbackUrl !== mediaUrl) {
        mediaRes = await fetch(fallbackUrl, { headers: upstreamHeaders });
      }

      if (!mediaRes.ok) {
        res.writeHead(mediaRes.status, { 'Content-Type': 'text/plain' });
        res.end('Failed to fetch remote media stream.');
        return;
      }

      const rawType = mediaRes.headers.get('content-type') || '';
      const safeType = rawType.startsWith('text/plain')
        ? (filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4')
        : (rawType || 'application/octet-stream');

      const outHeaders = {
        'Content-Type': safeType,
        'Accept-Ranges': 'bytes'
      };
      if (!isInline) {
        outHeaders['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`;
      }
      if (mediaRes.headers.get('content-length')) {
        outHeaders['Content-Length'] = mediaRes.headers.get('content-length');
      }
      if (mediaRes.headers.get('content-range')) {
        outHeaders['Content-Range'] = mediaRes.headers.get('content-range');
      }

      res.writeHead(mediaRes.status, outHeaders);

      const reader = mediaRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      console.error('[Proxy] Download error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Stream error occurred.');
    }
    return;
  }

  // 3. Static Files
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA/clean routes
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Error loading asset');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TikTok Web App] Running on http://localhost:${PORT}`);
});
