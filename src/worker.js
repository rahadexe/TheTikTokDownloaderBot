/**
 * Serverless Telegram TikTok Downloader Bot
 * Runs 100% on Cloudflare Workers (Edge Runtime) & Node.js Long Polling
 * Hybrid Delivery: Fast Zero-RAM CDN Hotlinking + Automatic Worker Multipart Binary Upload Fallback
 */

import * as db from './db.js';
import {
  INDEX_HTML,
  STYLE_CSS,
  APP_JS,
  SAMPLE_COVER_B64,
  SAMPLE_AVATAR_B64
} from './web-assets.js';

function decodeBase64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MAX_UPLOAD_BYTES = 49 * 1024 * 1024; // 49 MB (under Telegram's 50 MB Bot API multipart cap)
const MIN_VIDEO_BYTES = 8192; // Reject 280-byte CDN 503/403 text stubs
const MIN_AUDIO_BYTES = 4096;
const MIN_IMAGE_BYTES = 1024;

// In-flight singleflight locks (prevents duplicate Worker uploads when multiple users send the same viral video simultaneously)
const inFlightVideoJobs = new Map();
const inFlightAudioJobs = new Map();

/**
 * Lightweight 1-hop short-link redirect resolver (0.08s HEAD hop):
 * Resolves ANY new vt.tiktok.com / vm.tiktok.com / /t/ link to its canonical TikTok video_id
 * BEFORE calling external scrapers — so different share links for an already-cached video forward instantly!
 */
async function resolveShortLinkIdFast(tiktokUrl) {
  try {
    const u = new URL(tiktokUrl);
    const host = u.hostname.toLowerCase();
    const isShort =
      host === 'vt.tiktok.com' ||
      host === 'vm.tiktok.com' ||
      host === 'v.tiktok.com' ||
      u.pathname.startsWith('/t/');
    if (!isShort) return null;

    const res = await fetch(tiktokUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(3500)
    });
    const loc = res.headers.get('location') || '';
    const match = loc.match(/\/(?:video|photo|v)\/([0-9]+)/i) || loc.match(/[?&](?:item_id|share_item_id)=([0-9]+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isStaleTelegramFileIdError(resp) {
  const desc = String(resp?.description || '');
  return /wrong file identifier|file reference|temporarily unavailable|invalid file_id/i.test(desc);
}

let cachedBotUsername = '@TheTikTokDownloaderBot';

async function getBotTag(token) {
  return cachedBotUsername;
}

function getBotConfig(env = {}) {
  const channelTag = env.CHANNEL_USERNAME
    ? env.CHANNEL_USERNAME.startsWith('@')
      ? env.CHANNEL_USERNAME
      : '@' + env.CHANNEL_USERNAME
    : '@RHToolsOfficial';
  const adminId = Number(env.ADMIN_ID || 6775546602);
  return { channelTag, adminId };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Health check & status JSON endpoint
    if (request.method === 'GET' && url.pathname === '/health') {
      const stats = await db.getStats(env);
      return new Response(
        JSON.stringify(
          {
            status: 'online',
            service: 'TikTok Downloader Telegram Bot & Web Studio',
            engine: 'Cloudflare Workers Edge (Triple-Engine + Multipart Fallback)',
            stats,
            timestamp: new Date().toISOString()
          },
          null,
          2
        ),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 2. Web Studio Static Assets (Live at root / on Cloudflare Workers Edge)
    if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(request.method === 'HEAD' ? null : INDEX_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/style.css') {
      return new Response(request.method === 'HEAD' ? null : STYLE_CSS, {
        headers: {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/app.js') {
      return new Response(request.method === 'HEAD' ? null : APP_JS, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    if (request.method === 'GET' && url.pathname === '/sample-cover.jpg') {
      return new Response(decodeBase64ToBytes(SAMPLE_COVER_B64), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }

    if (request.method === 'GET' && url.pathname === '/sample-avatar.jpg') {
      return new Response(decodeBase64ToBytes(SAMPLE_AVATAR_B64), {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }

    // 3. Web Studio API: /api/extract
    if (request.method === 'GET' && url.pathname === '/api/extract') {
      const rawUrl = url.searchParams.get('url') || '';
      const cleanUrl = extractTikTokUrl(rawUrl);
      if (!cleanUrl) {
        return new Response(
          JSON.stringify({ success: false, error: 'Please paste a valid TikTok video or photo link.' }),
          { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }

      const webData = await extractWebStudioData(cleanUrl);
      if (!webData) {
        return new Response(
          JSON.stringify({ success: false, error: 'Could not resolve TikTok media. Ensure the link is public.' }),
          { status: 422, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }

      return new Response(JSON.stringify(webData), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // 4. Web Studio API: /api/download (Streaming proxy with Referer + HD fallback + Range support)
    if (request.method === 'GET' && url.pathname === '/api/download') {
      const mediaUrl = url.searchParams.get('url');
      const fallbackUrl = url.searchParams.get('fallback');
      const isInline = url.searchParams.get('inline') === '1';
      const filename = url.searchParams.get('filename') || 'tiktok_media.mp4';
      if (!mediaUrl) {
        return new Response('Missing media URL parameter.', { status: 400 });
      }

      try {
        const upstreamHeaders = {
          'User-Agent': BROWSER_UA,
          'Referer': 'https://www.tiktok.com/'
        };
        const rangeHeader = request.headers.get('Range');
        if (rangeHeader) {
          upstreamHeaders['Range'] = rangeHeader;
        }

        let mediaRes = await fetch(mediaUrl, { redirect: 'follow', headers: upstreamHeaders });
        const len = Number(mediaRes.headers.get('content-length') || 0);

        if ((!mediaRes.ok || (len > 0 && len < 4096)) && fallbackUrl && fallbackUrl !== mediaUrl) {
          mediaRes = await fetch(fallbackUrl, { redirect: 'follow', headers: upstreamHeaders });
        }

        if (!mediaRes.ok) {
          return new Response('Failed to fetch remote media stream.', { status: mediaRes.status });
        }

        const rawType = mediaRes.headers.get('content-type') || '';
        const safeType = rawType.startsWith('text/plain')
          ? filename.endsWith('.mp3')
            ? 'audio/mpeg'
            : 'video/mp4'
          : rawType || 'application/octet-stream';

        const outHeaders = new Headers();
        outHeaders.set('Content-Type', safeType);
        outHeaders.set('Accept-Ranges', 'bytes');
        if (!isInline) {
          outHeaders.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        }
        if (mediaRes.headers.get('content-length')) {
          outHeaders.set('Content-Length', mediaRes.headers.get('content-length'));
        }
        if (mediaRes.headers.get('content-range')) {
          outHeaders.set('Content-Range', mediaRes.headers.get('content-range'));
        }

        return new Response(mediaRes.body, {
          status: mediaRes.status,
          headers: outHeaders
        });
      } catch (err) {
        return new Response('Stream error: ' + err.message, { status: 500 });
      }
    }

    // Set webhook helper route: GET /setWebhook
    if (request.method === 'GET' && url.pathname === '/setWebhook') {
      const botToken = env.BOT_TOKEN;
      if (!botToken || botToken === 'YOUR_BOT_TOKEN_HERE') {
        return new Response('Error: BOT_TOKEN is not configured.', { status: 400 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const data = await tgCall(botToken, 'setWebhook', {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query', 'inline_query']
      });
      return new Response(JSON.stringify(data, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Telegram webhook handler
    if (request.method === 'POST') {
      const botToken = env.BOT_TOKEN;
      if (!botToken || botToken === 'YOUR_BOT_TOKEN_HERE') {
        return new Response('BOT_TOKEN not configured', { status: 500 });
      }

      if (env.SECRET_TOKEN) {
        const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (headerSecret !== env.SECRET_TOKEN) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      try {
        const update = await request.json();
        const task = handleUpdate(update, botToken, env).catch((err) => {
          console.error('Unhandled update error:', err);
        });
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(task);
        } else {
          await task;
        }
        return new Response('OK', { status: 200 });
      } catch (err) {
        console.error('Error parsing webhook update:', err);
        return new Response('Bad Request', { status: 400 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * Extract link from Telegram message text, caption, OR text_link entities (hyperlink words)
 */
function extractInputTextWithEntities(msg) {
  const baseText = (msg.text || msg.caption || '').trim();
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  for (const ent of entities) {
    if (ent?.type === 'text_link' && ent.url && /tiktok\.com/i.test(ent.url)) {
      return baseText ? `${baseText} ${ent.url}` : ent.url;
    }
  }
  return baseText;
}

/**
 * Handle incoming Telegram Update
 */
async function handleUpdate(update, token, env = {}) {
  // 0. Deduplicate retried webhook updates (prevents double delivery)
  if (update?.update_id !== undefined) {
    const claimed = await db.claimUpdateId(update.update_id);
    if (!claimed) return;
  }

  // Non-blocking user stats recording: never delay Telegram response for analytics upsert!
  if (update.message?.from) {
    db.upsertUser(update.message.from, env).catch(() => {});
  } else if (update.callback_query?.from) {
    db.upsertUser(update.callback_query.from, env).catch(() => {});
  }

  // 1. Callback Queries (Audio extraction)
  if (update.callback_query) {
    return handleCallback(update.callback_query, token, env);
  }

  // 2. Inline Queries
  if (update.inline_query) {
    return handleInlineQuery(update.inline_query, token, env);
  }

  // 3. Regular Messages (support text, media captions, and hyperlinked entities)
  const msg = update.message;
  if (!msg) return;
  const text = extractInputTextWithEntities(msg);
  if (!text) return;

  const chatId = msg.chat.id;
  const botTag = await getBotTag(token);
  const { channelTag, adminId } = getBotConfig(env);
  const cmdToken = text.split(/\s+/)[0].split('@')[0].toLowerCase();

  // Admin command (/admin) — strictly isolated to ADMIN_ID
  if (cmdToken === '/admin') {
    if (chatId === adminId || msg.from?.id === adminId) {
      const stats = await db.getStats(env);
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text:
          `<b>Admin Console</b>\n\n` +
          `Users: <b>${stats.users}</b>\n` +
          `Downloads: <b>${stats.downloads}</b>\n` +
          `Cache: <b>${stats.cachedVideos}</b>` +
          (stats.cacheHits ? `\nCache Hits: <b>${stats.cacheHits}</b>` : ''),
        parse_mode: 'HTML'
      });
    }
    return;
  }

  // /start or /help command (supports group /start@BotName and deep-link TikTok payloads)
  if (cmdToken === '/start' || cmdToken === '/help') {
    const payloadPart = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim() : '';
    const deepTikTokUrl = payloadPart ? extractTikTokUrl(payloadPart) : null;
    if (!deepTikTokUrl) {
      const welcome =
        `Updates: ${channelTag}\n\n` +
        `Send any TikTok link to download video without watermark or extract audio.`;

      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: welcome
      });
    }
  }

  // Detect TikTok link
  const tiktokUrl = extractTikTokUrl(text);
  if (!tiktokUrl) {
    if (msg.chat.type === 'private' && !text.startsWith('/')) {
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Please send a valid TikTok video link.'
      });
    }
    return;
  }

  // Fast L1/D1/Edge Cache check:
  // 1) Direct video/photo ID in URL, OR 2) Cached short-link mapping, OR 3) 1-hop 0.08s HEAD redirect resolution!
  const directMatch = tiktokUrl.match(/\/(?:video|photo|v|embed\/v2|share\/video)\/([0-9]+)/);
  let directId = directMatch ? directMatch[1] : await db.getCachedShortLink(tiktokUrl, env);

  if (!directId) {
    const fastHopId = await resolveShortLinkIdFast(tiktokUrl);
    if (fastHopId) {
      directId = fastHopId;
      await db.setCachedShortLink(tiktokUrl, fastHopId, env).catch(() => {});
    }
  }

  // Wait if another user is currently uploading this exact video right now (Singleflight Deduplication!)
  if (directId && inFlightVideoJobs.has(directId)) {
    await inFlightVideoJobs.get(directId).catch(() => {});
  }

  if (directId) {
    const cached = await db.getCachedVideo(directId, env);
    // A) Cached Video Instant Forward via Telegram file_id hash
    if (cached && cached.file_id) {
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });
      const safeTitle = safeUnicodeSlice(cached.title || 'TikTok Video', 300);
      const sent = await sendVideoByIdOrUrl(
        token,
        chatId,
        cached.file_id,
        safeTitle,
        botTag,
        cached.video_id || directId,
        cached
      );
      if (sent?.ok) {
        await db.incrementUserDownloads(msg.from?.id, env, {
          videoId: cached.video_id || directId,
          sourceUrl: tiktokUrl,
          mediaType: 'video',
          fromCache: true
        }).catch(() => {});
        return;
      }
      // Self-heal: if Telegram invalidated cached file_id, purge it and proceed to fresh upload
      if (isStaleTelegramFileIdError(sent)) {
        await db.invalidateCachedMedia(directId, env, 'video').catch(() => {});
      }
    }

    // B) Cached Photo Album Instant Forward via Telegram photo file_id hashes
    if (cached && Array.isArray(cached.photo_file_ids) && cached.photo_file_ids.length > 0) {
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_photo' });
      const safeTitle = safeUnicodeSlice(cached.title || 'TikTok Photo', 300);
      const cachedPhotoRes = await deliverPhotoPost(
        token,
        chatId,
        {
          id: cached.video_id || directId,
          images: cached.photo_file_ids,
          audioUrl: cached.audio_url || cached.audio_file_id
        },
        safeTitle,
        botTag
      );
      if (cachedPhotoRes?.delivered) {
        await db.incrementUserDownloads(msg.from?.id, env, {
          videoId: cached.video_id || directId,
          sourceUrl: tiktokUrl,
          mediaType: 'photo',
          fromCache: true
        }).catch(() => {});
        return;
      }
      await db.invalidateCachedMedia(directId, env, 'photo').catch(() => {});
    }
  }

  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });

  const statusMsg = await tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text: 'Downloading...'
  });
  const statusMsgId = statusMsg?.result?.message_id;

  let releaseInFlight = null;
  if (directId && !inFlightVideoJobs.has(directId)) {
    const lockPromise = new Promise((resolve) => {
      releaseInFlight = resolve;
    });
    inFlightVideoJobs.set(directId, lockPromise);
  }

  try {
    const data = await extractTikTokData(tiktokUrl);

    if (!data || (!data.videoUrl && !(data.isPhoto && data.images?.length))) {
      if (statusMsgId) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: statusMsgId,
          text: 'Video is unavailable or private.'
        });
      }
      return;
    }

    if (data.id) {
      await db.setCachedShortLink(tiktokUrl, data.id, env).catch(() => {});
      await db.setCachedShortLink(`https://www.tiktok.com/@a/video/${data.id}`, data.id, env).catch(() => {});
    }

    const safeTitle = safeUnicodeSlice(data.title || 'TikTok Video', 300);

    // Handle TikTok Photo / Slideshow Carousels + Cache returned Telegram Photo file_id hashes!
    if (data.isPhoto && Array.isArray(data.images) && data.images.length > 0) {
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_photo' });
      const photoRes = await deliverPhotoPost(token, chatId, data, safeTitle, botTag);
      if (photoRes?.delivered) {
        if (statusMsgId) {
          await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
        }
        if (data.id) {
          await db.setCachedVideo(data.id, data.title, '', env, {
            photoFileIds: photoRes.photoFileIds,
            audioUrl: data.audioUrl,
            musicTitle: data.musicTitle
          }).catch(() => {});
        }
        await db.incrementUserDownloads(msg.from?.id, env, {
          videoId: data.id || directId,
          sourceUrl: tiktokUrl,
          mediaType: 'photo',
          fromCache: false
        }).catch(() => {});
        return;
      }
      throw new Error('Failed to deliver TikTok photo post');
    }

    // Check resolved video ID cache (in case short-link HEAD hop didn't resolve ID earlier)
    if (data.id) {
      const cached = await db.getCachedVideo(data.id, env);
      if (cached && cached.file_id) {
        const cachedSent = await sendVideoByIdOrUrl(
          token,
          chatId,
          cached.file_id,
          safeTitle,
          botTag,
          data.id,
          cached
        );
        if (cachedSent?.ok) {
          if (statusMsgId) {
            await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
          }
          await db.incrementUserDownloads(msg.from?.id, env, {
            videoId: data.id,
            sourceUrl: tiktokUrl,
            mediaType: 'video',
            fromCache: true
          }).catch(() => {});
          return;
        }
        if (isStaleTelegramFileIdError(cachedSent)) {
          await db.invalidateCachedMedia(data.id, env, 'video').catch(() => {});
        }
      }
    }

    // Deliver Video: Stage 1 (Fast CDN Hotlink <=19MB) -> Stage 2 (Worker Binary Upload to Telegram <=49MB + Document Fallback) -> Stage 3 (Fresh Engine Re-Extract)
    const delivery = await deliverVideoWithFallbacks(token, chatId, data, safeTitle, botTag, tiktokUrl);

    if (delivery?.sent?.ok) {
      if (statusMsgId) {
        await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
      }
      const mediaObj = delivery.sent.result?.video || delivery.sent.result?.document;
      const tgFileId = mediaObj?.file_id;
      const tgUniqueId = mediaObj?.file_unique_id;
      const finalId = data.id || delivery.meta?.id || directId;

      if (finalId) {
        await db.setCachedShortLink(tiktokUrl, finalId, env).catch(() => {});
        await db.setCachedVideo(finalId, data.title, tgFileId || '', env, {
          fileUniqueId: tgUniqueId,
          audioUrl: data.audioUrl || delivery.meta?.audioUrl,
          musicTitle: data.musicTitle || delivery.meta?.musicTitle,
          width: delivery.meta?.width || data.width,
          height: delivery.meta?.height || data.height,
          duration: delivery.meta?.duration || data.duration
        }).catch(() => {});
      }

      await db.incrementUserDownloads(msg.from?.id, env, {
        videoId: finalId,
        sourceUrl: tiktokUrl,
        mediaType: 'video',
        fromCache: false
      }).catch(() => {});
    } else if (delivery?.tooLarge) {
      if (statusMsgId) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: statusMsgId,
          text: 'Video exceeds Telegram 50MB bot limit.'
        });
      }
    } else {
      throw new Error(delivery?.sent?.description || 'All video delivery tiers failed');
    }
  } catch (err) {
    console.error('TikTok delivery error:', err);
    if (statusMsgId) {
      await tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: 'Video is unavailable or private.'
      });
    }
  } finally {
    if (releaseInFlight) {
      releaseInFlight();
      inFlightVideoJobs.delete(directId);
    }
  }
}

/**
 * Multi-tier video delivery:
 * 1) Fast Telegram URL Hotlink (0 Worker RAM) when stream is <= 19MB and Telegram-compatible
 * 2) Direct Worker Fetch (with Referer + Cookies + MP4 dimension parser) -> Multipart FormData Binary Upload (up to 49MB)
 * 3) Self-healing fresh scrape via Direct TikTok / TikMate if primary CDN links expired
 */
async function deliverVideoWithFallbacks(token, chatId, data, safeTitle, botTag, originalUrl) {
  let sent = null;
  let sawTooLarge = Boolean(
    data.sizeBytes && data.sizeBytes > MAX_UPLOAD_BYTES && (!data.hdSizeBytes || data.hdSizeBytes > MAX_UPLOAD_BYTES)
  );

  // Stage 1: Try fast Telegram URL hotlinking if upstream returns standard video/mp4 <= 19MB without cookie lock
  const HOTLINK_SAFE_BYTES = 19 * 1024 * 1024;
  const canHotlink = !data.requiresWorkerUpload && (!data.sizeBytes || data.sizeBytes <= HOTLINK_SAFE_BYTES);
  if (canHotlink) {
    const hotlinkCandidates = uniqueStrings([data.videoUrl, data.tikwmProxyUrl, data.fallbackUrl]);
    for (const candidateUrl of hotlinkCandidates.slice(0, 2)) {
      sent = await sendVideoByIdOrUrl(token, chatId, candidateUrl, safeTitle, botTag, data.id, data);
      if (sent?.ok) return { sent, meta: data, tooLarge: false };
    }
  }

  // Stage 2: Worker fetches MP4 binary directly with TikTok Referer/Cookie headers and uploads via FormData
  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });
  const binaryCandidates = uniqueStrings([
    data.videoUrl,
    data.tikwmProxyUrl,
    data.hdUrl,
    data.fallbackUrl,
    data.wmUrl
  ]);

  for (const streamUrl of binaryCandidates) {
    const media = await fetchMediaStream(streamUrl, 'video/mp4', MIN_VIDEO_BYTES, data.cookies);
    if (media?.tooLarge) {
      sawTooLarge = true;
      continue;
    }
    if (!media?.blob) continue;

    const enrichedMeta = {
      ...data,
      width: data.width || media.dims?.width,
      height: data.height || media.dims?.height
    };

    sent = await uploadVideoMultipart(token, chatId, media.blob, safeTitle, botTag, data.id, enrichedMeta);
    if (sent?.ok) return { sent, meta: enrichedMeta, tooLarge: false };
  }

  // Stage 3: Self-healing fallback — if primary engine's CDN links failed, pull fresh signed stream from backup engines
  if (originalUrl && data.source !== 'tiktok_direct') {
    const directData = await extractFromTikTokDirect(originalUrl);
    if (directData?.videoUrl) {
      const media = await fetchMediaStream(directData.videoUrl, 'video/mp4', MIN_VIDEO_BYTES, directData.cookies);
      if (media?.tooLarge) sawTooLarge = true;
      if (media?.blob) {
        if (!data.audioUrl && directData.audioUrl) data.audioUrl = directData.audioUrl;
        if (!data.id && directData.id) data.id = directData.id;
        const enrichedMeta = {
          ...directData,
          width: directData.width || media.dims?.width,
          height: directData.height || media.dims?.height
        };
        sent = await uploadVideoMultipart(
          token,
          chatId,
          media.blob,
          safeTitle,
          botTag,
          data.id || directData.id,
          enrichedMeta
        );
        if (sent?.ok) return { sent, meta: enrichedMeta, tooLarge: false };
      }
    }
  }

  if (originalUrl && data.source !== 'tikmate') {
    const tmData = await extractFromTikMate(originalUrl);
    if (tmData) {
      for (const tmUrl of uniqueStrings([tmData.videoUrl, tmData.hdUrl])) {
        const media = await fetchMediaStream(tmUrl, 'video/mp4', MIN_VIDEO_BYTES);
        if (media?.tooLarge) sawTooLarge = true;
        if (media?.blob) {
          if (!data.id && tmData.id) data.id = tmData.id;
          const enrichedMeta = {
            ...tmData,
            width: tmData.width || media.dims?.width,
            height: tmData.height || media.dims?.height
          };
          sent = await uploadVideoMultipart(
            token,
            chatId,
            media.blob,
            safeTitle,
            botTag,
            data.id || tmData.id,
            enrichedMeta
          );
          if (sent?.ok) return { sent, meta: enrichedMeta, tooLarge: false };
        }
      }
    }
  }

  return { sent, meta: data, tooLarge: sawTooLarge };
}

async function sendVideoByIdOrUrl(token, chatId, videoRef, safeTitle, botTag, videoId, meta = {}) {
  const htmlCaption = `<b>${escapeHtml(safeTitle)}</b>\n\n${botTag} ♥️`;
  const plainCaption = `${safeTitle}\n\n${botTag} ♥️`;
  const inlineKeyboard = videoId
    ? [[{ text: '🎵 Download Audio', callback_data: `audio_${videoId}` }]]
    : undefined;

  const basePayload = {
    chat_id: chatId,
    video: videoRef,
    supports_streaming: true,
    ...(meta.width ? { width: Number(meta.width) } : {}),
    ...(meta.height ? { height: Number(meta.height) } : {}),
    ...(meta.duration ? { duration: Math.round(Number(meta.duration)) } : {}),
    ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
  };

  let sent = await tgCall(token, 'sendVideo', {
    ...basePayload,
    caption: htmlCaption,
    parse_mode: 'HTML'
  });

  if (!sent?.ok && sent?.description && sent.description.includes('parse')) {
    sent = await tgCall(token, 'sendVideo', {
      ...basePayload,
      caption: plainCaption
    });
  }

  return sent;
}

async function uploadVideoMultipart(token, chatId, videoBlob, safeTitle, botTag, videoId, meta = {}) {
  const htmlCaption = `<b>${escapeHtml(safeTitle)}</b>\n\n${botTag} ♥️`;
  const plainCaption = `${safeTitle}\n\n${botTag} ♥️`;
  const replyMarkup = videoId
    ? JSON.stringify({ inline_keyboard: [[{ text: '🎵 Download Audio', callback_data: `audio_${videoId}` }]] })
    : null;

  const buildForm = (fieldName, captionText, useHtml) => {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append(fieldName, videoBlob, `tiktok_${videoId || Date.now()}.mp4`);
    fd.append('caption', captionText);
    if (useHtml) fd.append('parse_mode', 'HTML');
    if (fieldName === 'video') {
      fd.append('supports_streaming', 'true');
      if (meta.width) fd.append('width', String(meta.width));
      if (meta.height) fd.append('height', String(meta.height));
      if (meta.duration) fd.append('duration', String(Math.round(meta.duration)));
    }
    if (replyMarkup) fd.append('reply_markup', replyMarkup);
    return fd;
  };

  let sent = await tgCallMultipart(token, 'sendVideo', buildForm('video', htmlCaption, true));
  if (!sent?.ok && sent?.description && sent.description.includes('parse')) {
    sent = await tgCallMultipart(token, 'sendVideo', buildForm('video', plainCaption, false));
  }

  // Fallback to sendDocument if Telegram's video transcoder rejects unusual codec/container
  if (!sent?.ok && !/too large|Entity Too Large|413/i.test(String(sent?.description || ''))) {
    sent = await tgCallMultipart(token, 'sendDocument', buildForm('document', plainCaption, false));
  }
  return sent;
}

/**
 * Deliver TikTok Photo / Slideshow Carousel Posts + extract Telegram photo file_id hashes for instant caching!
 */
async function deliverPhotoPost(token, chatId, data, safeTitle, botTag) {
  const images = data.images.filter(Boolean);
  if (images.length === 0) return { delivered: false, photoFileIds: [] };

  const htmlCaption = `<b>${escapeHtml(safeTitle)}</b>\n\n${botTag} ♥️`;
  const plainCaption = `${safeTitle}\n\n${botTag} ♥️`;
  const hasAudioAction = Boolean(data.id && data.audioUrl);
  const inlineKeyboard = hasAudioAction
    ? [[{ text: '🎵 Download Audio', callback_data: `audio_${data.id}` }]]
    : undefined;
  const collectedPhotoIds = [];

  // Single photo post
  if (images.length === 1) {
    let sent = await tgCall(token, 'sendPhoto', {
      chat_id: chatId,
      photo: images[0],
      caption: htmlCaption,
      parse_mode: 'HTML',
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
    });

    if (!sent?.ok && /^https?:\/\//i.test(images[0])) {
      const imgBlob = await fetchMediaBlob(images[0], 'image/jpeg', MIN_IMAGE_BYTES, data.cookies);
      if (imgBlob) {
        const fd = new FormData();
        fd.append('chat_id', String(chatId));
        fd.append('photo', imgBlob, 'photo.jpg');
        fd.append('caption', plainCaption);
        if (inlineKeyboard) fd.append('reply_markup', JSON.stringify({ inline_keyboard: inlineKeyboard }));
        sent = await tgCallMultipart(token, 'sendPhoto', fd);
      }
    }

    const bestPhoto = Array.isArray(sent?.result?.photo) ? sent.result.photo[sent.result.photo.length - 1] : null;
    if (bestPhoto?.file_id) collectedPhotoIds.push(bestPhoto.file_id);
    return { delivered: !!sent?.ok, photoFileIds: collectedPhotoIds };
  }

  // Multi-photo carousel (Telegram allows up to 10 items per sendMediaGroup, and forbids inline_keyboard inside sendMediaGroup)
  let anyDelivered = false;
  for (let i = 0; i < images.length; i += 10) {
    const chunk = images.slice(i, i + 10);
    const mediaPayload = chunk.map((imgUrl, idx) => ({
      type: 'photo',
      media: imgUrl,
      ...(i === 0 && idx === 0 && !inlineKeyboard ? { caption: htmlCaption, parse_mode: 'HTML' } : {})
    }));

    let groupSent = await tgCall(token, 'sendMediaGroup', {
      chat_id: chatId,
      media: mediaPayload
    });

    if (!groupSent?.ok && chunk.every((u) => /^https?:\/\//i.test(u))) {
      const blobs = await Promise.all(
        chunk.map((imgUrl) => fetchMediaBlob(imgUrl, 'image/jpeg', MIN_IMAGE_BYTES, data.cookies))
      );
      const validPairs = blobs
        .map((b, idx) => (b ? { blob: b, idx } : null))
        .filter(Boolean);

      if (validPairs.length > 0) {
        const fd = new FormData();
        fd.append('chat_id', String(chatId));
        const attachMedia = validPairs.map((item, pos) => {
          const fieldName = `photo_${pos}`;
          fd.append(fieldName, item.blob, `${fieldName}.jpg`);
          return {
            type: 'photo',
            media: `attach://${fieldName}`,
            ...(i === 0 && pos === 0 && !inlineKeyboard ? { caption: plainCaption } : {})
          };
        });
        fd.append('media', JSON.stringify(attachMedia));
        groupSent = await tgCallMultipart(token, 'sendMediaGroup', fd);
      }
    }

    if (groupSent?.ok) {
      anyDelivered = true;
      if (Array.isArray(groupSent.result)) {
        for (const m of groupSent.result) {
          const best = Array.isArray(m?.photo) ? m.photo[m.photo.length - 1] : null;
          if (best?.file_id) collectedPhotoIds.push(best.file_id);
        }
      }
    }
  }

  // Attach clean caption + [ 🎵 Download Audio ] button directly below the photo album
  if (anyDelivered && inlineKeyboard) {
    const capRes = await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: htmlCaption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
    if (!capRes?.ok) {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: plainCaption,
        reply_markup: { inline_keyboard: inlineKeyboard }
      });
    }
  }

  return { delivered: anyDelivered, photoFileIds: collectedPhotoIds };
}

/**
 * Handle Audio extraction callback ([ 🎵 Download Audio ])
 */
async function handleCallback(cb, token, env = {}) {
  const botTag = await getBotTag(token);
  const data = cb.data;
  if (!data || !data.startsWith('audio_')) return;

  const videoId = data.replace('audio_', '');
  await tgCall(token, 'answerCallbackQuery', {
    callback_query_id: cb.id,
    text: 'Downloading audio...'
  });

  const chatId = cb.message?.chat?.id;
  if (!chatId) return;
  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_document' });

  if (inFlightAudioJobs.has(videoId)) {
    await inFlightAudioJobs.get(videoId).catch(() => {});
  }

  let releaseAudioLock = null;

  try {
    // 1. Instant delivery if audio_file_id hash is already cached
    const cached = await db.getCachedVideo(videoId, env);
    if (cached && cached.audio_file_id) {
      const cachedTitle = safeUnicodeSlice(cached.music_title || cached.title || 'TikTok Audio', 50);
      const safeCaption =
        `<b>${escapeHtml(safeUnicodeSlice(cached.title || 'TikTok Audio', 70))}</b>\n\n` +
        `${botTag} ♥️`;

      const cachedRes = await tgCall(token, 'sendAudio', {
        chat_id: chatId,
        audio: cached.audio_file_id,
        title: cachedTitle,
        performer: botTag,
        caption: safeCaption,
        parse_mode: 'HTML'
      });
      if (cachedRes?.ok) return;
      if (isStaleTelegramFileIdError(cachedRes)) {
        await db.invalidateCachedMedia(videoId, env, 'audio').catch(() => {});
      }
    }

    if (!inFlightAudioJobs.has(videoId)) {
      const p = new Promise((resolve) => {
        releaseAudioLock = resolve;
      });
      inFlightAudioJobs.set(videoId, p);
    }

    // 2. Gather candidate audio streams (use cached audio_url first to avoid TikWM 1-req/sec rate limit!)
    let audioCandidates = [];
    let cookies = null;
    let displayTitle = cached?.title || '';
    let musicTitle = cached?.music_title || '';

    if (cached?.audio_url) {
      audioCandidates.push(cached.audio_url);
    }

    let meta = null;
    if (audioCandidates.length === 0) {
      meta = await extractTikTokData(`https://www.tiktok.com/@a/video/${videoId}`);
      if (meta) {
        if (meta.audioUrl) audioCandidates.push(meta.audioUrl);
        cookies = meta.cookies || null;
        displayTitle = displayTitle || meta.title || '';
        musicTitle = musicTitle || meta.musicTitle || '';
      }
    }

    const cleanTitle = safeUnicodeSlice(musicTitle || displayTitle || 'TikTok Audio', 50) || 'TikTok Audio';
    const htmlCaption =
      `<b>${escapeHtml(safeUnicodeSlice(displayTitle || musicTitle || 'TikTok Audio', 70))}</b>\n\n` +
      `${botTag} ♥️`;
    const plainCaption = `${botTag} ♥️`;

    let sentAudio = null;

    // 3a. Try fast URL hotlink first (when not cookie-bound)
    for (const audioUrl of uniqueStrings(audioCandidates)) {
      if (!cookies) {
        sentAudio = await tgCall(token, 'sendAudio', {
          chat_id: chatId,
          audio: audioUrl,
          title: cleanTitle,
          performer: botTag,
          caption: htmlCaption,
          parse_mode: 'HTML'
        });

        if (!sentAudio?.ok && sentAudio?.description?.includes('parse')) {
          sentAudio = await tgCall(token, 'sendAudio', {
            chat_id: chatId,
            audio: audioUrl,
            title: 'TikTok Audio',
            performer: botTag,
            caption: plainCaption
          });
        }
        if (sentAudio?.ok) break;
      }

      // 3b. Worker Binary Fetch + Multipart FormData Upload fallback
      const audioBlob = await fetchMediaBlob(audioUrl, 'audio/mpeg', MIN_AUDIO_BYTES, cookies);
      if (audioBlob) {
        sentAudio = await uploadAudioMultipart(
          token,
          chatId,
          audioBlob,
          cleanTitle,
          botTag,
          htmlCaption,
          plainCaption,
          videoId
        );
        if (sentAudio?.ok) break;
      }
    }

    // 3c. If cached audio_url expired, fetch fresh stream once and upload
    if (!sentAudio?.ok && cached?.audio_url && !meta) {
      meta = await extractTikTokData(`https://www.tiktok.com/@a/video/${videoId}`);
      if (meta?.audioUrl) {
        const freshBlob = await fetchMediaBlob(meta.audioUrl, 'audio/mpeg', MIN_AUDIO_BYTES, meta.cookies);
        if (freshBlob) {
          sentAudio = await uploadAudioMultipart(
            token,
            chatId,
            freshBlob,
            cleanTitle,
            botTag,
            htmlCaption,
            plainCaption,
            videoId
          );
        }
      }
    }

    if (sentAudio?.ok) {
      const audioObj = sentAudio.result?.audio || sentAudio.result?.document;
      const audioFileId = audioObj?.file_id;
      const audioUniqueId = audioObj?.file_unique_id;
      if (audioFileId) {
        await db.setCachedAudio(videoId, audioFileId, env, cleanTitle, audioUniqueId);
      }
    } else {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Audio is unavailable.'
      });
    }
  } catch (e) {
    console.error('Audio callback error:', e);
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: 'Audio is unavailable.'
    });
  } finally {
    if (releaseAudioLock) {
      releaseAudioLock();
      inFlightAudioJobs.delete(videoId);
    }
  }
}

async function uploadAudioMultipart(token, chatId, audioBlob, cleanTitle, botTag, htmlCaption, plainCaption, videoId) {
  const buildForm = (titleText, captionText, useHtml) => {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('audio', audioBlob, `tiktok_audio_${videoId || Date.now()}.mp3`);
    fd.append('title', titleText);
    fd.append('performer', botTag);
    fd.append('caption', captionText);
    if (useHtml) fd.append('parse_mode', 'HTML');
    return fd;
  };

  let sent = await tgCallMultipart(token, 'sendAudio', buildForm(cleanTitle, htmlCaption, true));
  if (!sent?.ok) {
    sent = await tgCallMultipart(token, 'sendAudio', buildForm('TikTok Audio', plainCaption, false));
  }
  return sent;
}

/**
 * Handle Inline Query (@botname link)
 * Uses cached Telegram file_id when available for 100% reliable delivery, else public tikwm proxy URL
 */
async function handleInlineQuery(iq, token, env = {}) {
  const q = (iq.query || '').trim();
  const tiktokUrl = extractTikTokUrl(q);
  if (!tiktokUrl) return tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });

  try {
    const botTag = await getBotTag(token);

    // Check fast cache first (including 1-hop short-link redirect resolution)
    const directMatch = tiktokUrl.match(/\/(?:video|photo|v|embed\/v2|share\/video)\/([0-9]+)/);
    let cachedVidId = directMatch ? directMatch[1] : await db.getCachedShortLink(tiktokUrl, env);
    if (!cachedVidId) {
      cachedVidId = await resolveShortLinkIdFast(tiktokUrl);
      if (cachedVidId) {
        await db.setCachedShortLink(tiktokUrl, cachedVidId, env).catch(() => {});
      }
    }
    if (cachedVidId) {
      const cached = await db.getCachedVideo(cachedVidId, env);
      if (cached?.file_id) {
        const safeTitle = safeUnicodeSlice(cached.title || 'TikTok Video', 200);
        return tgCall(token, 'answerInlineQuery', {
          inline_query_id: iq.id,
          results: [
            {
              type: 'video',
              id: String(cachedVidId),
              video_file_id: cached.file_id,
              title: safeTitle,
              caption: `<b>${escapeHtml(safeTitle)}</b>\n\n${botTag} ♥️`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[{ text: '🎵 Download Audio', callback_data: `audio_${cachedVidId}` }]]
              }
            }
          ],
          cache_time: 300
        });
      }
    }

    const data = await extractTikTokData(tiktokUrl);
    if (!data || !data.videoUrl) {
      return tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });
    }

    const safeTitle = safeUnicodeSlice(data.title || 'TikTok Video', 200);
    // Prefer tikwmProxyUrl over cookie-bound direct URLs for Telegram inline video player
    const publicInlineUrl = data.tikwmProxyUrl || (!data.requiresWorkerUpload ? data.videoUrl : null);
    if (!publicInlineUrl) {
      return tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });
    }

    const results = [
      {
        type: 'video',
        id: String(data.id || Date.now()),
        video_url: publicInlineUrl,
        mime_type: 'video/mp4',
        thumb_url: data.thumbnail || 'https://raw.githubusercontent.com/TelegramBots/logos/main/logo.png',
        title: safeTitle,
        caption: `<b>${escapeHtml(safeTitle)}</b>\n\n${botTag} ♥️`,
        parse_mode: 'HTML',
        ...(data.id
          ? { reply_markup: { inline_keyboard: [[{ text: '🎵 Download Audio', callback_data: `audio_${data.id}` }]] } }
          : {})
      }
    ];

    await tgCall(token, 'answerInlineQuery', {
      inline_query_id: iq.id,
      results,
      cache_time: 300
    });
  } catch {
    await tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });
  }
}

/**
 * Triple-Engine TikTok Extractor:
 * 1. TikWM API (with automatic 1.15s retry when shared Cloudflare IP hits 1-req/sec rate limit + photo carousel support)
 * 2. Direct First-Party TikTok Web Rehydration Scraper (__UNIVERSAL_DATA_FOR_REHYDRATION__ + ttwid cookie, zero rate limits)
 * 3. TikMate API (with proper hd_token, caption preservation, and Worker multipart flag)
 */
async function extractTikTokData(url) {
  const tikwm = await extractFromTikWM(url);
  if (tikwm) return tikwm;

  const direct = await extractFromTikTokDirect(url);
  if (direct) return direct;

  const tikmate = await extractFromTikMate(url);
  if (tikmate) return tikmate;

  return null;
}

/**
 * Web Studio JSON Formatter (used by GET /api/extract on Cloudflare Workers Edge)
 */
async function extractWebStudioData(url) {
  const d = await extractTikTokData(url);
  if (!d) return null;

  return {
    success: true,
    id: d.id,
    title: d.title || 'TikTok Video',
    author: {
      nickname: d.author || 'TikTok User',
      unique_id: d.authorHandle || '',
      avatar: d.authorAvatar || ''
    },
    cover: d.thumbnail || '',
    duration: d.duration || 0,
    sizeBytes: d.sizeBytes || d.hdSizeBytes || undefined,
    images: d.images || [],
    stats: d.stats || {
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0
    },
    music: {
      title: d.musicTitle || 'Original Sound',
      play: d.audioUrl || ''
    },
    downloads: {
      hd_video: d.hdUrl || d.videoUrl || '',
      fast_video: d.videoUrl || d.tikwmProxyUrl || '',
      audio: d.audioUrl || '',
      cover: d.thumbnail || ''
    }
  };
}

function normalizeTikwmUrl(u) {
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  return `https://www.tikwm.com${u.startsWith('/') ? '' : '/'}${u}`;
}

async function extractFromTikWM(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) break;
      const json = await res.json();

      // Code -1 on TikWM is "Free Api Limit: 1 request/second." on shared Cloudflare POP IPs
      // Fast failover immediately to Engine 2 (Direct TikTok) with zero sleep delay!
      if (json && json.code === -1) {
        break;
      }

      if (json && json.code === 0 && json.data) {
        const d = json.data;
        const images = Array.isArray(d.images) ? d.images.map(normalizeTikwmUrl).filter(Boolean) : [];
        const isPhoto = images.length > 0;
        const playUrl = normalizeTikwmUrl(d.play);
        const hdUrl = normalizeTikwmUrl(d.hdplay);
        const wmUrl = normalizeTikwmUrl(d.wmplay);
        const musicUrl = normalizeTikwmUrl(d.music || d.music_info?.play || (isPhoto ? d.play : null));

        return {
          source: 'tikwm',
          id: d.id ? String(d.id) : null,
          title: d.title || 'TikTok Video',
          author: d.author?.nickname || d.author?.unique_id || 'TikTok User',
          authorHandle: d.author?.unique_id || '',
          authorAvatar: normalizeTikwmUrl(d.author?.avatar) || '',
          stats: {
            views: Number(d.play_count || 0),
            likes: Number(d.digg_count || 0),
            comments: Number(d.comment_count || 0),
            shares: Number(d.share_count || 0)
          },
          isPhoto,
          images,
          videoUrl: isPhoto ? null : (playUrl || hdUrl),
          hdUrl: isPhoto ? null : hdUrl,
          wmUrl: isPhoto ? null : wmUrl,
          fallbackUrl: isPhoto ? null : (hdUrl || playUrl),
          tikwmProxyUrl: !isPhoto && d.id ? `https://www.tikwm.com/video/media/play/${d.id}.mp4` : null,
          audioUrl: musicUrl,
          musicTitle: d.music_info?.title || d.title || 'TikTok Audio',
          thumbnail: normalizeTikwmUrl(d.cover),
          duration: Number(d.duration || 0),
          sizeBytes: Number(d.size || 0) || undefined,
          hdSizeBytes: Number(d.hd_size || 0) || undefined,
          requiresWorkerUpload: false
        };
      }
      break;
    } catch (err) {
      if (attempt === 1) {
        console.warn('TikWM extractor failed:', err.message);
      }
    }
  }
  return null;
}

async function extractFromTikTokDirect(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(9000)
    });

    if (!res.ok) return null;

    let cookieHeader = '';
    if (typeof res.headers.getSetCookie === 'function') {
      const list = res.headers.getSetCookie();
      if (Array.isArray(list) && list.length > 0) {
        cookieHeader = list.map((c) => c.split(';')[0]).join('; ');
      }
    }
    if (!cookieHeader) {
      const rawCookie = res.headers.get('set-cookie');
      if (rawCookie) {
        cookieHeader = rawCookie
          .split(/,(?=\s*[a-zA-Z0-9_-]+=)/)
          .map((c) => c.split(';')[0].trim())
          .join('; ');
      }
    }

    const html = await res.text();
    const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;

    const payload = JSON.parse(match[1]);
    const scope = payload?.__DEFAULT_SCOPE__ || {};
    const item =
      scope['webapp.video-detail']?.itemInfo?.itemStruct ||
      scope['webapp.reflow.video.detail']?.itemInfo?.itemStruct;

    if (!item) return null;

    // Photo post check
    const rawImages = item.imagePost?.images;
    if (Array.isArray(rawImages) && rawImages.length > 0) {
      const images = rawImages
        .map((img) => img?.imageURL?.urlList?.[0])
        .filter(Boolean);
      if (images.length > 0) {
        return {
          source: 'tiktok_direct',
          id: item.id ? String(item.id) : null,
          title: item.desc || 'TikTok Photo',
          author: item.author?.nickname || item.author?.uniqueId || 'TikTok User',
          isPhoto: true,
          images,
          videoUrl: null,
          audioUrl: item.music?.playUrl || null,
          musicTitle: item.music?.title || item.desc || 'TikTok Audio',
          thumbnail: images[0],
          duration: 0,
          cookies: cookieHeader || null,
          requiresWorkerUpload: true
        };
      }
    }

    // Video post: prefer highest-bitrate H.264 stream under 49MB for universal Telegram inline playback
    const bitrates = Array.isArray(item.video?.bitrateInfo) ? item.video.bitrateInfo : [];
    const h264Streams = bitrates
      .filter((b) => {
        const isH264 = /h264|avc/i.test(String(b?.CodecType || ''));
        const hasUrl = Boolean(b?.PlayAddr?.UrlList?.[0]);
        const dataSize = Number(b?.PlayAddr?.DataSize || 0);
        const fitsCap = !dataSize || dataSize <= MAX_UPLOAD_BYTES;
        return isH264 && hasUrl && fitsCap;
      })
      .sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));

    const bestH264 = h264Streams[0]?.PlayAddr?.UrlList?.[0] || null;
    const bestSize = Number(h264Streams[0]?.PlayAddr?.DataSize || 0) || undefined;
    const playAddr = item.video?.playAddr || item.video?.PlayAddrStruct?.UrlList?.[0] || null;
    const downloadAddr = item.video?.downloadAddr || null;
    const primaryVideo = bestH264 || playAddr || downloadAddr;

    if (!primaryVideo) return null;

    return {
      source: 'tiktok_direct',
      id: item.id ? String(item.id) : null,
      title: item.desc || 'TikTok Video',
      author: item.author?.nickname || item.author?.uniqueId || 'TikTok User',
      authorHandle: item.author?.uniqueId || '',
      authorAvatar: item.author?.avatarMedium || item.author?.avatarThumb || '',
      stats: {
        views: Number(item.stats?.playCount || 0),
        likes: Number(item.stats?.diggCount || 0),
        comments: Number(item.stats?.commentCount || 0),
        shares: Number(item.stats?.shareCount || 0)
      },
      isPhoto: false,
      images: [],
      videoUrl: primaryVideo,
      hdUrl: playAddr !== primaryVideo ? playAddr : null,
      fallbackUrl: downloadAddr,
      audioUrl: item.music?.playUrl || null,
      musicTitle: item.music?.title || item.desc || 'TikTok Audio',
      thumbnail: item.video?.cover || item.video?.originCover || null,
      width: Number(item.video?.width || 0) || undefined,
      height: Number(item.video?.height || 0) || undefined,
      duration: Number(item.video?.duration || 0) || undefined,
      sizeBytes: bestSize,
      cookies: cookieHeader || null,
      requiresWorkerUpload: true
    };
  } catch (err) {
    console.warn('Direct TikTok extractor failed:', err.message);
    return null;
  }
}

async function extractFromTikMate(url) {
  try {
    const res2 = await fetch('https://api.tikmate.app/api/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': BROWSER_UA
      },
      body: `url=${encodeURIComponent(url)}`,
      signal: AbortSignal.timeout(8000)
    });

    if (res2.ok) {
      const d2 = await res2.json();
      if (d2 && d2.success && d2.token && d2.id) {
        const sdUrl = `https://tikmate.app/download/${d2.token}/${d2.id}.mp4`;
        const hdUrl = d2.hd_token ? `https://tikmate.app/download/${d2.hd_token}/${d2.id}.mp4?hd=1` : null;
        return {
          source: 'tikmate',
          id: String(d2.id),
          title: d2.desc || 'TikTok Video',
          author: d2.author_name || d2.author_id || 'TikTok User',
          authorHandle: d2.author_id || '',
          authorAvatar: d2.author_avatar || '',
          stats: {
            views: 0,
            likes: Number(d2.like_count || 0),
            comments: Number(d2.comment_count || 0),
            shares: Number(d2.share_count || 0)
          },
          isPhoto: false,
          images: [],
          videoUrl: sdUrl,
          hdUrl,
          fallbackUrl: hdUrl || sdUrl,
          audioUrl: null,
          musicTitle: d2.desc || 'TikTok Audio',
          thumbnail: d2.cover || null,
          duration: 0,
          requiresWorkerUpload: true
        };
      }
    }
  } catch (err2) {
    console.warn('TikMate fallback failed:', err2.message);
  }
  return null;
}

/**
 * Parse video width & height directly from MP4 `tkhd` atom inside binary buffer
 * Ensures vertical 9:16 TikTok videos never display as squashed squares in Telegram mobile!
 */
function parseMp4Dimensions(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    // Scan up to first 512KB and last 256KB (covers both faststart and trailing moov atoms)
    const ranges = [[0, Math.min(bytes.length, 524288)]];
    if (bytes.length > 524288) {
      ranges.push([Math.max(524288, bytes.length - 262144), bytes.length]);
    }

    for (const [start, end] of ranges) {
      for (let i = start; i <= end - 96; i++) {
        // 't' (0x74), 'k' (0x6b), 'h' (0x68), 'd' (0x64)
        if (bytes[i] === 0x74 && bytes[i + 1] === 0x6b && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
          const version = bytes[i + 4];
          const dimOffset = i + 4 + (version === 1 ? 88 : 76);
          if (dimOffset + 8 <= bytes.length) {
            const w = view.getUint32(dimOffset, false) >>> 16;
            const h = view.getUint32(dimOffset + 4, false) >>> 16;
            if (w >= 64 && w <= 8192 && h >= 64 && h <= 8192) {
              return { width: w, height: h };
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Fetch binary media stream safely inside Worker / Node for multipart Telegram upload
 * Returns { blob, dims, tooLarge }
 */
async function fetchMediaStream(streamUrl, mimeType, minBytes = MIN_VIDEO_BYTES, cookies = null) {
  if (!streamUrl) return null;
  try {
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'Referer': 'https://www.tiktok.com/'
    };
    if (cookies) {
      headers['Cookie'] = cookies;
    }

    const res = await fetch(streamUrl, {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(18000)
    });

    if (!res.ok) return null;

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_UPLOAD_BYTES) return { blob: null, dims: null, tooLarge: true };
    if (contentLength > 0 && contentLength < minBytes) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      return { blob: null, dims: null, tooLarge: true };
    }
    if (buffer.byteLength < minBytes) {
      return null;
    }

    // Reject HTML/XML/JSON error pages masquerading as 200 OK
    const headBytes = new Uint8Array(buffer.slice(0, 32));
    const headAscii = String.fromCharCode(...headBytes).trimStart();
    if (
      headAscii.startsWith('<!DOCTYPE') ||
      headAscii.startsWith('<html') ||
      headAscii.startsWith('<?xml') ||
      headAscii.startsWith('{"code":') ||
      headAscii.startsWith('AccessDenied')
    ) {
      return null;
    }

    const dims = mimeType === 'video/mp4' ? parseMp4Dimensions(buffer) : null;
    return {
      blob: new Blob([buffer], { type: mimeType }),
      dims,
      tooLarge: false
    };
  } catch (err) {
    console.warn('fetchMediaStream failed:', err.message);
    return null;
  }
}

async function fetchMediaBlob(streamUrl, mimeType, minBytes = MIN_VIDEO_BYTES, cookies = null) {
  const res = await fetchMediaStream(streamUrl, mimeType, minBytes, cookies);
  return res?.blob || null;
}

/**
 * URL Extractor, Validator & Sanitizer
 * Supports schemeless links (vt.tiktok.com/...), strips attached emojis/punctuation, and rejects non-media profile/discover pages
 */
function extractTikTokUrl(text) {
  if (!text || typeof text !== 'string') return null;

  // Match full https://...tiktok.com/... OR schemeless (vt|vm|www|m).tiktok.com/...
  const match = text.match(
    /(?:https?:\/\/|(?:^|[\s(])(?=(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/))(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[a-zA-Z0-9_./?=&%@#+-]+/i
  );
  if (!match) return null;

  let raw = match[0].trim().replace(/[.,;:!?)\]>]+$/, '');
  if (!/^https?:\/\//i.test(raw)) {
    raw = 'https://' + raw;
  }

  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null;

    const isShortHost =
      host === 'vt.tiktok.com' ||
      host === 'vm.tiktok.com' ||
      host === 'v.tiktok.com';

    const itemId = u.searchParams.get('item_id') || u.searchParams.get('share_item_id');
    if (itemId && /^[0-9]+$/.test(itemId)) {
      return `https://www.tiktok.com/@a/video/${itemId}`;
    }

    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '') return null;

    if (isShortHost) {
      // Short links need at least a shortcode segment (e.g. /ZSgQuVgCe)
      if (!/^\/[a-zA-Z0-9_-]{4,}$/.test(path)) return null;
      return `${u.origin}${path}/`;
    }

    // Standard tiktok.com hosts: accept video, photo, /t/<code>, /v/<id>, /embed/..., /share/video/...
    const isMediaPath =
      /\/(?:video|photo)\/[0-9]+/i.test(path) ||
      /^\/t\/[a-zA-Z0-9_-]+/i.test(path) ||
      /^\/v\/[0-9]+/i.test(path) ||
      /\/embed\/(?:v2\/)?[0-9]+/i.test(path) ||
      /\/share\/video\/[0-9]+/i.test(path);

    if (isMediaPath) {
      const keepSlash = /^\/t\//i.test(path) ? '/' : '';
      return `${u.origin}${path}${keepSlash}`;
    }

    // Reject bare profile links (/@username), /discover, /tag, /live so bot asks for a valid video link immediately
    return null;
  } catch {
    return null;
  }
}

/**
 * Telegram JSON API Helper (with automatic 429 Flood-Wait retry_after backoff)
 */
async function tgCall(token, method, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000)
      });
      const json = await res.json().catch(() => ({ ok: false }));
      if (!json?.ok && json?.error_code === 429 && attempt === 0) {
        const waitSec = Math.min(Number(json?.parameters?.retry_after || 2), 8);
        await sleep(waitSec * 1000 + 150);
        continue;
      }
      return json;
    } catch (err) {
      if (attempt === 1) return { ok: false, description: err.message };
      await sleep(400);
    }
  }
  return { ok: false };
}

/**
 * Telegram Multipart FormData Upload Helper (for binary Blob uploads up to 50 MB + 429 retry)
 */
async function tgCallMultipart(token, method, formData) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(35000)
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

function uniqueStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (item && typeof item === 'string' && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUnicodeSlice(str, limit = 50) {
  if (!str) return '';
  return Array.from(String(str)).slice(0, limit).join('').trim();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export {
  handleUpdate,
  extractTikTokData,
  extractFromTikWM,
  extractFromTikTokDirect,
  extractFromTikMate,
  extractTikTokUrl,
  fetchMediaBlob,
  fetchMediaStream,
  parseMp4Dimensions,
  escapeHtml
};
