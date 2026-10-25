/**
 * Serverless Telegram TikTok Downloader Bot
 * Runs 100% on Cloudflare Workers (Edge Runtime)
 * Zero RAM/Bandwidth load on Worker (Telegram streams directly from CDN)
 */

import * as db from './db.js';

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
  const channelTag = env.CHANNEL_USERNAME ? (env.CHANNEL_USERNAME.startsWith('@') ? env.CHANNEL_USERNAME : '@' + env.CHANNEL_USERNAME) : '@RHToolsOfficial';
  const adminId = Number(env.ADMIN_ID || 6775546602);
  return { channelTag, adminId };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check & status
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const stats = await db.getStats(env);
      return new Response(JSON.stringify({
        status: 'online',
        service: 'TikTok Downloader Telegram Bot',
        engine: 'Cloudflare Workers Edge',
        stats,
        timestamp: new Date().toISOString()
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Set webhook helper route: GET /setWebhook
    if (request.method === 'GET' && url.pathname === '/setWebhook') {
      const botToken = env.BOT_TOKEN;
      if (!botToken || botToken === 'YOUR_BOT_TOKEN_HERE') {
        return new Response('Error: BOT_TOKEN is not configured.', { status: 400 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const data = await tgRes.json();
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

      // Optional secret validation
      if (env.SECRET_TOKEN) {
        const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (headerSecret !== env.SECRET_TOKEN) {
          return new Response('Unauthorized', { status: 401 });
        }
      }

      try {
        const update = await request.json();
        // Handle in background or async
        ctx.waitUntil(handleUpdate(update, botToken, env));
        return new Response('OK', { status: 200 });
      } catch (err) {
        console.error('Error handling update:', err);
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
  // Track user activity in database
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

  // 3. Regular Messages
  if (!update.message || !update.message.text) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
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

  // Check cache if direct video ID is in URL
  const idMatch = tiktokUrl.match(/\/video\/([0-9]+)/);
  const directId = idMatch ? idMatch[1] : null;

  if (directId) {
    const cached = await db.getCachedVideo(directId, env);
    if (cached && cached.file_id) {
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });
      const caption =
        `<b>${escapeHtml(cached.title || 'TikTok Video')}</b>\n\n` +
        `${botTag} ♥️`;

      const inlineKeyboard = [
        [
          { text: '🎵 Download Audio', callback_data: `audio_${cached.video_id}` }
        ]
      ];

      const sent = await tgCall(token, 'sendVideo', {
        chat_id: chatId,
        video: cached.file_id,
        caption: caption,
        parse_mode: 'HTML',
        supports_streaming: true,
        reply_markup: { inline_keyboard: inlineKeyboard }
      });

      if (sent?.ok) {
        db.incrementUserDownloads(msg.from?.id, env).catch(() => {});
        return;
      }
    }
  }

  // Show status action
  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });

  // Inform user
  const statusMsg = await tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text: '<i>Downloading video...</i>',
    parse_mode: 'HTML'
  });
  const statusMsgId = statusMsg?.result?.message_id;

  try {
    const data = await extractTikTokData(tiktokUrl);
    if (!data || !data.videoUrl) {
      if (statusMsgId) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: statusMsgId,
          text: 'Video is unavailable or private.'
        });
      }
      return;
    }

    // Check cache by data.id (e.g. if short link resolved)
    let videoToSend = data.videoUrl;
    if (data.id) {
      const cached = await db.getCachedVideo(data.id, env);
      if (cached && cached.file_id) {
        videoToSend = cached.file_id;
      }
    }

    const caption =
      `<b>${escapeHtml(data.title || 'TikTok Video')}</b>\n\n` +
      `${botTag} ♥️`;

    const inlineKeyboard = [
      [
        { text: '🎵 Download Audio', callback_data: `audio_${data.id}` }
      ]
    ];

    // Deliver video directly from CDN or Telegram file_id
    const sent = await tgCall(token, 'sendVideo', {
      chat_id: chatId,
      video: videoToSend,
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
      reply_markup: { inline_keyboard: inlineKeyboard }
    });

    // Delete progress message upon success
    if (sent?.ok) {
      if (statusMsgId) {
        await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
      }
      db.incrementUserDownloads(msg.from?.id, env).catch(() => {});
      const tgFileId = sent.result?.video?.file_id;
      if (tgFileId && data.id) {
        db.setCachedVideo(data.id, data.title, tgFileId, env).catch(() => {});
      }
    } else if (!sent?.ok) {
      throw new Error(sent?.description || 'Telegram failed to deliver video stream');
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
 * Handle Audio extraction callback
 */
async function handleCallback(cb, token, env = {}) {
  const botTag = await getBotTag(token);
  const data = cb.data;
  if (!data || !data.startsWith('audio_')) return;

  const videoId = data.replace('audio_', '');
  await tgCall(token, 'answerCallbackQuery', {
    callback_query_id: cb.id,
    text: 'Extracting audio...'
  });

  const chatId = cb.message.chat.id;
  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_document' });

  try {
    // 1. Check if audio is already cached
    const cached = await db.getCachedVideo(videoId, env);
    if (cached && cached.audio_file_id) {
      await tgCall(token, 'sendAudio', {
        chat_id: chatId,
        audio: cached.audio_file_id,
        title: (cached.title || 'TikTok Audio').substring(0, 50),
        performer: botTag,
        caption:
          `<b>${escapeHtml(cached.title || 'TikTok Audio')}</b>\n\n` +
          `${botTag} ♥️`,
        parse_mode: 'HTML'
      });
      return;
    }

    // 2. Fetch fresh audio stream and cache file_id
    const meta = await extractTikTokData(`https://www.tiktok.com/@a/video/${videoId}`);
    if (meta && meta.audioUrl) {
      const audioTitle = meta.title || 'TikTok Audio';
      const sentAudio = await tgCall(token, 'sendAudio', {
        chat_id: chatId,
        audio: meta.audioUrl,
        title: audioTitle.substring(0, 50),
        performer: botTag,
        caption:
          `<b>${escapeHtml(audioTitle)}</b>\n\n` +
          `${botTag} ♥️`,
        parse_mode: 'HTML'
      });

      const audioFileId = sentAudio?.result?.audio?.file_id;
      if (audioFileId) {
        db.setCachedAudio(videoId, audioFileId, env).catch(() => {});
      }
    } else {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Audio is unavailable.'
      });
    }
  } catch (e) {
    console.error('Audio callback error:', e);
  }
}

/**
 * Handle Inline Query (@botname link)
 */
async function handleInlineQuery(iq, token) {
  const q = iq.query.trim();
  const tiktokUrl = extractTikTokUrl(q);
  if (!tiktokUrl) return tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });

  try {
    const data = await extractTikTokData(tiktokUrl);
    if (!data || !data.videoUrl) {
      return tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });
    }

    const botTag = await getBotTag(token);
    const results = [
      {
        type: 'video',
        id: String(data.id || Date.now()),
        video_url: data.videoUrl,
        mime_type: 'video/mp4',
        thumb_url: data.thumbnail || 'https://raw.githubusercontent.com/TelegramBots/logos/main/logo.png',
        title: data.title || 'TikTok Video',
        caption:
          `<b>${escapeHtml(data.title || 'TikTok Video')}</b>\n\n` +
          `${botTag} ♥️`,
        parse_mode: 'HTML'
      }
    ];

    await tgCall(token, 'answerInlineQuery', {
      inline_query_id: iq.id,
      results: results,
      cache_time: 300
    });
  } catch {
    await tgCall(token, 'answerInlineQuery', { inline_query_id: iq.id, results: [] });
  }
}

/**
 * Dual-Engine TikTok Extractor
 */
async function extractTikTokData(url) {
  // Engine 1: TikWM API
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (res.ok) {
      const json = await res.json();
      if (json && json.code === 0 && json.data) {
        const d = json.data;
        return {
          id: d.id,
          title: d.title || 'TikTok Video',
          author: d.author?.nickname || d.author?.unique_id || 'TikTok User',
          videoUrl: d.hdplay || d.play,
          audioUrl: d.music || d.play,
          thumbnail: d.cover,
          duration: d.duration || 0
        };
      }
    }
  } catch (err) {
    console.warn('TikWM API primary failed, trying fallback...', err.message);
  }

  // Engine 2: TikMate / Web Fallback
  try {
    const res2 = await fetch('https://api.tikmate.app/api/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      body: `url=${encodeURIComponent(url)}`,
      signal: AbortSignal.timeout(8000)
    });

    if (res2.ok) {
      const d2 = await res2.json();
      if (d2 && d2.success && d2.token) {
        return {
          id: d2.id,
          title: 'TikTok Video',
          author: d2.author_name || 'TikTok User',
          videoUrl: `https://tikmate.app/download/${d2.token}/${d2.id}.mp4?hd=1`,
          audioUrl: null,
          thumbnail: null,
          duration: 0
        };
      }
    }
  } catch (err2) {
    console.warn('TikMate fallback failed:', err2.message);
  }

  return null;
}

/**
 * URL Extractor & Validator
 */
function extractTikTokUrl(text) {
  const match = text.match(/https?:\/\/(?:(?:www|vm|vt|m)\.)?tiktok\.com\/[^\s]+/i);
  return match ? match[0] : null;
}

/**
 * Telegram API Helper
 */
async function tgCall(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return await res.json().catch(() => ({ ok: false }));
}

/**
 * HTML Escaper
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export { handleUpdate, extractTikTokData, extractTikTokUrl, escapeHtml };
