/**
 * Serverless Telegram TikTok Downloader Bot
 * Runs 100% on Cloudflare Workers (Edge Runtime) & Node.js Long Polling
 * Hybrid Delivery: Fast Zero-RAM CDN Hotlinking + Automatic Worker Multipart Binary Upload Fallback
 */

import * as db from './db.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MAX_UPLOAD_BYTES = 49 * 1024 * 1024; // 49 MB (under Telegram's 50 MB Bot API multipart cap)
const MIN_VIDEO_BYTES = 8192; // Reject 280-byte CDN 503/403 text stubs
const MIN_AUDIO_BYTES = 4096;
const MIN_IMAGE_BYTES = 1024;

let cachedBotUsername = null;

async function getBotTag(token) {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const res = await tgCall(token, 'getMe', {});
    if (res?.ok && res.result?.username) {
      cachedBotUsername = '@' + res.result.username.replace(/^@/, '');
      return cachedBotUsername;
    }
  } catch {}
  return '@TheTikTokDownloaderBot';
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

    // Health check & status
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const stats = await db.getStats(env);
      return new Response(
        JSON.stringify(
          {
            status: 'online',
            service: 'TikTok Downloader Telegram Bot',
            engine: 'Cloudflare Workers Edge (Triple-Engine + Multipart Fallback)',
            stats,
            timestamp: new Date().toISOString()
          },
          null,
          2
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
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
 * Handle incoming Telegram Update
 */
async function handleUpdate(update, token, env = {}) {
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

  // 3. Regular Messages (support both text and media captions containing links)
  const msg = update.message;
  if (!msg) return;
  const rawText = msg.text || msg.caption || '';
  if (!rawText) return;

  const chatId = msg.chat.id;
  const text = rawText.trim();
  const botTag = await getBotTag(token);
  const { channelTag, adminId } = getBotConfig(env);

  // Admin command (/admin)
  if (text === '/admin') {
    if (chatId === adminId || msg.from?.id === adminId) {
      const stats = await db.getStats(env);
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text:
          `<b>Admin Console</b>\n\n` +
          `Users: <b>${stats.users}</b>\n` +
          `Downloads: <b>${stats.downloads}</b>\n` +
          `Cache: <b>${stats.cachedVideos}</b>`,
        parse_mode: 'HTML'
      });
    }
  }

  // /start or /help command
  if (text === '/start' || text.startsWith('/start ') || text === '/help') {
    const welcome =
      `Updates: ${channelTag}\n\n` +
      `Send any TikTok link to download video without watermark or extract audio.`;

    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: welcome
    });
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

  // Fast L1/Edge Cache check if direct video ID is present in URL
  const idMatch = tiktokUrl.match(/\/(?:video|v)\/([0-9]+)/);
  const directId = idMatch ? idMatch[1] : null;

  if (directId) {
    const cached = await db.getCachedVideo(directId, env);
    if (cached && cached.file_id) {
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });
      const safeTitle = safeUnicodeSlice(cached.title || 'TikTok Video', 300);
      const sent = await sendVideoByIdOrUrl(token, chatId, cached.file_id, safeTitle, botTag, cached.video_id || directId);
      if (sent?.ok) {
        db.incrementUserDownloads(msg.from?.id, env).catch(() => {});
        return;
      }
    }
  }

  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });

  const statusMsg = await tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text: 'Downloading...'
  });
  const statusMsgId = statusMsg?.result?.message_id;

  try {
    let data = await extractTikTokData(tiktokUrl);

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

    const safeTitle = safeUnicodeSlice(data.title || 'TikTok Video', 300);

    // Handle TikTok Photo / Slideshow Carousels
    if (data.isPhoto && Array.isArray(data.images) && data.images.length > 0) {
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_photo' });
      if (data.id && data.audioUrl) {
        await db.setCachedVideo(data.id, data.title, '', env, {
          audioUrl: data.audioUrl,
          musicTitle: data.musicTitle
        });
      }

      const photoSent = await deliverPhotoPost(token, chatId, data, safeTitle, botTag);
      if (photoSent) {
        if (statusMsgId) {
          await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
        }
        db.incrementUserDownloads(msg.from?.id, env).catch(() => {});
        return;
      }
      throw new Error('Failed to deliver TikTok photo post');
    }

    // Check resolved video ID cache (for short vt.tiktok.com / vm.tiktok.com links)
    if (data.id) {
      const cached = await db.getCachedVideo(data.id, env);
      if (cached && cached.file_id) {
        const cachedSent = await sendVideoByIdOrUrl(token, chatId, cached.file_id, safeTitle, botTag, data.id);
        if (cachedSent?.ok) {
          if (statusMsgId) {
            await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
          }
          db.incrementUserDownloads(msg.from?.id, env).catch(() => {});
          return;
        }
      }
    }

    // Deliver Video: Stage 1 (Fast CDN Hotlink) -> Stage 2 (Worker Binary Stream Upload) -> Stage 3 (Fresh Engine Re-Extract + Binary Upload)
    let sent = await deliverVideoWithFallbacks(token, chatId, data, safeTitle, botTag, tiktokUrl);

    if (sent?.ok) {
      if (statusMsgId) {
        await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
      }
      db.incrementUserDownloads(msg.from?.id, env).catch(() => {});
      const tgFileId = sent.result?.video?.file_id;
      if (data.id) {
        await db.setCachedVideo(data.id, data.title, tgFileId || '', env, {
          audioUrl: data.audioUrl,
          musicTitle: data.musicTitle
        });
      }
    } else {
      throw new Error(sent?.description || 'All video delivery tiers failed');
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
  }
}

/**
 * Multi-tier video delivery:
 * 1) Fast Telegram URL Hotlink (0 Worker RAM) when stream is Telegram-compatible
 * 2) Direct Worker Fetch (with Referer + Cookies) -> Multipart FormData Binary Upload to Telegram (bypasses CDN 403/503 IP blocks & 20MB URL limit up to 50MB)
 * 3) Self-healing fresh scrape via Direct TikTok / TikMate if primary CDN links expired
 */
async function deliverVideoWithFallbacks(token, chatId, data, safeTitle, botTag, originalUrl) {
  let sent = null;

  // Stage 1: Try fast Telegram URL hotlinking if upstream returns standard video/mp4 without cookie lock
  if (!data.requiresWorkerUpload) {
    const hotlinkCandidates = uniqueStrings([data.videoUrl, data.tikwmProxyUrl, data.fallbackUrl]);
    for (const candidateUrl of hotlinkCandidates.slice(0, 2)) {
      sent = await sendVideoByIdOrUrl(token, chatId, candidateUrl, safeTitle, botTag, data.id, data);
      if (sent?.ok) return sent;
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
    const mediaBlob = await fetchMediaBlob(streamUrl, 'video/mp4', MIN_VIDEO_BYTES, data.cookies);
    if (!mediaBlob) continue;

    sent = await uploadVideoMultipart(token, chatId, mediaBlob, safeTitle, botTag, data.id, data);
    if (sent?.ok) return sent;
  }

  // Stage 3: Self-healing fallback — if primary engine's CDN links failed, pull fresh signed stream from backup engines
  if (originalUrl && data.source !== 'tiktok_direct') {
    const directData = await extractFromTikTokDirect(originalUrl);
    if (directData?.videoUrl) {
      const blob = await fetchMediaBlob(directData.videoUrl, 'video/mp4', MIN_VIDEO_BYTES, directData.cookies);
      if (blob) {
        if (!data.audioUrl && directData.audioUrl) data.audioUrl = directData.audioUrl;
        if (!data.id && directData.id) data.id = directData.id;
        sent = await uploadVideoMultipart(token, chatId, blob, safeTitle, botTag, data.id || directData.id, directData);
        if (sent?.ok) return sent;
      }
    }
  }

  if (originalUrl && data.source !== 'tikmate') {
    const tmData = await extractFromTikMate(originalUrl);
    if (tmData) {
      for (const tmUrl of uniqueStrings([tmData.videoUrl, tmData.hdUrl])) {
        const blob = await fetchMediaBlob(tmUrl, 'video/mp4', MIN_VIDEO_BYTES);
        if (blob) {
          if (!data.id && tmData.id) data.id = tmData.id;
          sent = await uploadVideoMultipart(token, chatId, blob, safeTitle, botTag, data.id || tmData.id, tmData);
          if (sent?.ok) return sent;
        }
      }
    }
  }

  return sent;
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
    ...(meta.width ? { width: meta.width } : {}),
    ...(meta.height ? { height: meta.height } : {}),
    ...(meta.duration ? { duration: meta.duration } : {}),
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

  const buildForm = (captionText, useHtml) => {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('video', videoBlob, `tiktok_${videoId || Date.now()}.mp4`);
    fd.append('caption', captionText);
    if (useHtml) fd.append('parse_mode', 'HTML');
    fd.append('supports_streaming', 'true');
    if (meta.width) fd.append('width', String(meta.width));
    if (meta.height) fd.append('height', String(meta.height));
    if (meta.duration) fd.append('duration', String(Math.round(meta.duration)));
    if (replyMarkup) fd.append('reply_markup', replyMarkup);
    return fd;
  };

  let sent = await tgCallMultipart(token, 'sendVideo', buildForm(htmlCaption, true));
  if (!sent?.ok && sent?.description && sent.description.includes('parse')) {
    sent = await tgCallMultipart(token, 'sendVideo', buildForm(plainCaption, false));
  }
  return sent;
}

/**
 * Deliver TikTok Photo / Slideshow Carousel Posts
 */
async function deliverPhotoPost(token, chatId, data, safeTitle, botTag) {
  const images = data.images.filter(Boolean);
  if (images.length === 0) return false;

  const htmlCaption = `<b>${escapeHtml(safeTitle)}</b>\n\n${botTag} ♥️`;
  const plainCaption = `${safeTitle}\n\n${botTag} ♥️`;
  const inlineKeyboard = data.id
    ? [[{ text: '🎵 Download Audio', callback_data: `audio_${data.id}` }]]
    : undefined;

  // Single photo post
  if (images.length === 1) {
    let sent = await tgCall(token, 'sendPhoto', {
      chat_id: chatId,
      photo: images[0],
      caption: htmlCaption,
      parse_mode: 'HTML',
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
    });

    if (!sent?.ok) {
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
    return !!sent?.ok;
  }

  // Multi-photo carousel (Telegram allows up to 10 items per sendMediaGroup)
  let anyDelivered = false;
  for (let i = 0; i < images.length; i += 10) {
    const chunk = images.slice(i, i + 10);
    const mediaPayload = chunk.map((imgUrl, idx) => ({
      type: 'photo',
      media: imgUrl,
      ...(i === 0 && idx === 0 ? { caption: htmlCaption, parse_mode: 'HTML' } : {})
    }));

    let groupSent = await tgCall(token, 'sendMediaGroup', {
      chat_id: chatId,
      media: mediaPayload
    });

    if (!groupSent?.ok) {
      // Binary upload fallback for photo album
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
            ...(i === 0 && pos === 0 ? { caption: plainCaption } : {})
          };
        });
        fd.append('media', JSON.stringify(attachMedia));
        groupSent = await tgCallMultipart(token, 'sendMediaGroup', fd);
      }
    }

    if (groupSent?.ok) anyDelivered = true;
  }

  return anyDelivered;
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

  try {
    // 1. Instant delivery if audio_file_id is already cached
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
        sentAudio = await uploadAudioMultipart(token, chatId, audioBlob, cleanTitle, botTag, htmlCaption, plainCaption, videoId);
        if (sentAudio?.ok) break;
      }
    }

    // 3c. If cached audio_url expired, fetch fresh stream once and upload
    if (!sentAudio?.ok && cached?.audio_url && !meta) {
      meta = await extractTikTokData(`https://www.tiktok.com/@a/video/${videoId}`);
      if (meta?.audioUrl) {
        const freshBlob = await fetchMediaBlob(meta.audioUrl, 'audio/mpeg', MIN_AUDIO_BYTES, meta.cookies);
        if (freshBlob) {
          sentAudio = await uploadAudioMultipart(token, chatId, freshBlob, cleanTitle, botTag, htmlCaption, plainCaption, videoId);
        }
      }
    }

    if (sentAudio?.ok) {
      const audioFileId = sentAudio.result?.audio?.file_id;
      if (audioFileId) {
        await db.setCachedAudio(videoId, audioFileId, env, cleanTitle);
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
 */
async function handleInlineQuery(iq, token) {
  const q = (iq.query || '').trim();
  const tiktokUrl = extractTikTokUrl(q);
  if (!tiktokUrl) return tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });

  try {
    const data = await extractTikTokData(tiktokUrl);
    if (!data || !data.videoUrl) {
      return tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });
    }

    const botTag = await getBotTag(token);
    const safeTitle = safeUnicodeSlice(data.title || 'TikTok Video', 200);
    const results = [
      {
        type: 'video',
        id: String(data.id || Date.now()),
        video_url: data.videoUrl,
        mime_type: 'video/mp4',
        thumb_url: data.thumbnail || 'https://raw.githubusercontent.com/TelegramBots/logos/main/logo.png',
        title: safeTitle,
        caption: `<b>${escapeHtml(safeTitle)}</b>\n\n${botTag} ♥️`,
        parse_mode: 'HTML'
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

      // Code -1 on TikWM is often "Free Api Limit: 1 request/second." on shared Cloudflare POP IPs
      if (json && json.code === -1 && attempt === 0 && /limit|second|busy/i.test(String(json.msg || ''))) {
        await sleep(1150 + Math.floor(Math.random() * 250));
        continue;
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

    // Video post: prefer highest-bitrate H.264 stream for universal Telegram inline playback
    const bitrates = Array.isArray(item.video?.bitrateInfo) ? item.video.bitrateInfo : [];
    const h264Streams = bitrates
      .filter((b) => /h264|avc/i.test(String(b?.CodecType || '')) && b?.PlayAddr?.UrlList?.[0])
      .sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));

    const bestH264 = h264Streams[0]?.PlayAddr?.UrlList?.[0] || null;
    const playAddr = item.video?.playAddr || item.video?.PlayAddrStruct?.UrlList?.[0] || null;
    const downloadAddr = item.video?.downloadAddr || null;
    const primaryVideo = bestH264 || playAddr || downloadAddr;

    if (!primaryVideo) return null;

    return {
      source: 'tiktok_direct',
      id: item.id ? String(item.id) : null,
      title: item.desc || 'TikTok Video',
      author: item.author?.nickname || item.author?.uniqueId || 'TikTok User',
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
          isPhoto: false,
          images: [],
          videoUrl: sdUrl,
          hdUrl,
          fallbackUrl: hdUrl || sdUrl,
          audioUrl: null,
          musicTitle: d2.desc || 'TikTok Audio',
          thumbnail: d2.cover || null,
          duration: 0,
          // TikMate serves Content-Type: text/plain & HEAD -> 503, so Worker binary upload is required
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
 * Fetch binary media stream safely inside Worker / Node for multipart Telegram upload
 */
async function fetchMediaBlob(streamUrl, mimeType, minBytes = MIN_VIDEO_BYTES, cookies = null) {
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
    if (contentLength > MAX_UPLOAD_BYTES) return null;
    if (contentLength > 0 && contentLength < minBytes) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < minBytes || buffer.byteLength > MAX_UPLOAD_BYTES) {
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

    return new Blob([buffer], { type: mimeType });
  } catch (err) {
    console.warn('fetchMediaBlob failed:', err.message);
    return null;
  }
}

/**
 * URL Extractor & Sanitizer
 */
function extractTikTokUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s<>"']+/i);
  if (!match) return null;
  let cleanUrl = match[0].replace(/[.,;:!?)\]>]+$/, '');
  try {
    const u = new URL(cleanUrl);
    const host = u.hostname.toLowerCase();
    const isShortHost =
      host === 'vt.tiktok.com' ||
      host === 'vm.tiktok.com' ||
      host === 'v.tiktok.com';
    if (
      isShortHost ||
      u.pathname.includes('/video/') ||
      u.pathname.includes('/photo/') ||
      u.pathname.startsWith('/t/') ||
      u.pathname.startsWith('/v/')
    ) {
      cleanUrl = `${u.origin}${u.pathname}`;
    }
  } catch {}
  return cleanUrl;
}

/**
 * Telegram JSON API Helper
 */
async function tgCall(token, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

/**
 * Telegram Multipart FormData Upload Helper (for binary Blob uploads up to 50 MB)
 */
async function tgCallMultipart(token, method, formData) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(25000)
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
  escapeHtml
};
