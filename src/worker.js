/**
 * Serverless Telegram TikTok Downloader Bot
 * Runs 100% on Cloudflare Workers (Edge Runtime)
 * Zero RAM/Bandwidth load on Worker (Telegram streams directly from CDN)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check & status
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response(JSON.stringify({
        status: 'online',
        service: 'TikTok Downloader Telegram Bot',
        engine: 'Cloudflare Workers Edge',
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
        ctx.waitUntil(handleUpdate(update, botToken));
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
async function handleUpdate(update, token) {
  // 1. Callback Queries (Audio extraction)
  if (update.callback_query) {
    return handleCallback(update.callback_query, token);
  }

  // 2. Inline Queries
  if (update.inline_query) {
    return handleInlineQuery(update.inline_query, token);
  }

  // 3. Regular Messages
  if (!update.message || !update.message.text) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // /start or /help command
  if (text === '/start' || text.startsWith('/start ') || text === '/help') {
    const welcome =
      `<b>TikTok Downloader</b>\n\n` +
      `Send any TikTok link to download video without watermark or extract audio.\n\n` +
      `Updates: @RHToolsOfficial`;

    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: welcome,
      parse_mode: 'HTML'
    });
  }

  // Detect TikTok link
  const tiktokUrl = extractTikTokUrl(text);
  if (!tiktokUrl) {
    if (msg.chat.type === 'private' && !text.startsWith('/')) {
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '<b>Link not found</b>\n<blockquote>Please send a valid TikTok video link.</blockquote>',
        parse_mode: 'HTML'
      });
    }
    return;
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
          text: '<b>Video unavailable</b>\n<blockquote>Make sure the video is public and accessible.</blockquote>',
          parse_mode: 'HTML'
        });
      }
      return;
    }

    const caption =
      `<b>${escapeHtml(data.title || 'TikTok Video')}</b>\n\n` +
      `@TheTikTokDownloaderBot ♥️`;

    const inlineKeyboard = [
      [
        { text: '🎵 Download Audio', callback_data: `audio_${data.id}` }
      ]
    ];

    // Deliver video directly from CDN via Telegram API
    const sent = await tgCall(token, 'sendVideo', {
      chat_id: chatId,
      video: data.videoUrl,
      caption: caption,
      parse_mode: 'HTML',
      supports_streaming: true,
      reply_markup: { inline_keyboard: inlineKeyboard }
    });

    // Delete progress message upon success
    if (sent?.ok && statusMsgId) {
      await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: statusMsgId });
    } else if (!sent?.ok) {
      throw new Error(sent?.description || 'Telegram failed to deliver video stream');
    }
  } catch (err) {
    console.error('TikTok delivery error:', err);
    if (statusMsgId) {
      await tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: statusMsgId,
        text: `❌ <b>Error:</b> ${escapeHtml(err.message || 'Failed to download video.')}`,
        parse_mode: 'HTML'
      });
    }
  }
}

/**
 * Handle Audio extraction callback
 */
async function handleCallback(cb, token) {
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
    const meta = await extractTikTokData(`https://www.tiktok.com/@a/video/${videoId}`);
    if (meta && meta.audioUrl) {
      const audioTitle = meta.title || 'TikTok Audio';
      await tgCall(token, 'sendAudio', {
        chat_id: chatId,
        audio: meta.audioUrl,
        title: audioTitle.substring(0, 50),
        performer: '@TheTikTokDownloaderBot',
        caption:
          `<b>${escapeHtml(audioTitle)}</b>\n\n` +
          `@TheTikTokDownloaderBot ♥️`,
        parse_mode: 'HTML'
      });
    } else {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '<b>Audio unavailable</b>\n<blockquote>Could not extract audio from this video.</blockquote>',
        parse_mode: 'HTML'
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

    const results = [
      {
        type: 'video',
        id: String(data.id || Date.now()),
        video_url: data.videoUrl,
        mime_type: 'video/mp4',
        thumb_url: data.thumbnail || 'https://raw.githubusercontent.com/TelegramBots/logos/main/logo.png',
        title: data.title || 'TikTok Video',
        caption:
          `<b>${escapeHtml(data.title || 'TikTok Video')}</b>\n` +
          `<blockquote>@TheTikTokDownloaderBot · @RHToolsOfficial</blockquote>`,
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
