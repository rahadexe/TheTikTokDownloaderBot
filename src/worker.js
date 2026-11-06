/**
 * Serverless Telegram TikTok Downloader Bot
 * Runs 100% on Cloudflare Workers (Edge Runtime) & Node.js Long Polling
 * Hybrid Delivery: Fast Zero-RAM CDN Hotlinking + Automatic Worker Multipart Binary Upload Fallback
 */

import * as db from './db.js';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';
const MAX_UPLOAD_BYTES = 49 * 1024 * 1024; // 49 MB (under Telegram's 50 MB Bot API multipart cap)
const MIN_VIDEO_BYTES = 8192; // Reject 280-byte CDN 503/403 text stubs
const MIN_AUDIO_BYTES = 4096;
const MIN_IMAGE_BYTES = 1024;

// In-flight singleflight locks (prevents duplicate Worker uploads when multiple users send the same viral video simultaneously)
const inFlightVideoJobs = new Map();
const inFlightAudioJobs = new Map();
const userRateLimit = new Map();     // userId -> [timestamps]
const userSpamCooldown = new Map();  // userId -> cooldownEndTimestamp
const userLastCooldownWarn = new Map(); // userId -> lastWarningTimestamp
export const userActiveJobs = new Map(); // userId -> active job count
export const userQueueTail = new Map();  // userId -> Promise

export async function enqueueUserJob(userId, jobFn) {
  if (!userId) {
    return jobFn();
  }
  const prevPromise = userQueueTail.get(userId);
  let releaseCurrent;
  const currentPromise = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  userQueueTail.set(userId, currentPromise);

  try {
    if (prevPromise) {
      // Await previous job with 60s safety timeout to prevent permanent blocking/deadlock
      await Promise.race([
        prevPromise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 60000))
      ]);
    }
    return await jobFn();
  } finally {
    releaseCurrent();
    if (userQueueTail.get(userId) === currentPromise) {
      userQueueTail.delete(userId);
    }
  }
}
const RATE_LIMIT_WINDOW = 60000;     // 60 seconds
const RATE_LIMIT_MAX_LINKS = 10;     // 10 links per minute

export function checkUserRateLimit(userId, numLinks = 1) {
  if (!userId) return { blocked: false, warning: null };
  const now = Date.now();
  const cooldownUntil = userSpamCooldown.get(userId) || 0;
  if (now < cooldownUntil) {
    const remainingSec = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
    const lastWarn = userLastCooldownWarn.get(userId) || 0;
    if (now - lastWarn >= 3000) {
      userLastCooldownWarn.set(userId, now);
      return {
        blocked: true,
        warning: `⏱ Back in <b>${remainingSec}s</b>`
      };
    }
    return { blocked: true, warning: null }; // Throttled to avoid Telegram spam
  }
  let history = userRateLimit.get(userId) || [];
  history = history.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (history.length + numLinks > RATE_LIMIT_MAX_LINKS) {
    userSpamCooldown.set(userId, now + RATE_LIMIT_WINDOW);
    userLastCooldownWarn.set(userId, now);
    userRateLimit.set(userId, history);
    return {
      blocked: true,
      warning: "⏱ Back in <b>60s</b>"
    };
  }
  for (let i = 0; i < numLinks; i++) {
    history.push(now);
  }
  userRateLimit.set(userId, history);
  return { blocked: false, warning: null };
}

/**
 * Lightweight 1-hop short-link redirect resolver (0.08s HEAD hop):
 * Resolves ANY new vt.tiktok.com / vm.tiktok.com / /t/ link to its canonical TikTok video_id
 * BEFORE calling external scrapers : so different share links for an already-cached video forward instantly!
 */
async function resolveShortLinkIdFast(tiktokUrl, timeoutMs = 3500) {
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
      signal: AbortSignal.timeout(timeoutMs)
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

function bgTask(promise, ctx) {
  if (!promise || typeof promise.catch !== 'function') return;
  const p = promise.catch((err) => console.warn('bgTask warning:', err?.message));
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(p);
  }
}

async function getActiveForceSubChannel(env) {
  const dynamic = await db.getSetting('force_sub_channel', env, null);
  if (dynamic !== null) return dynamic.trim();
  const cfg = getBotConfig(env);
  return cfg.channelTag || '@RHToolsOfficial';
}

async function checkChannelMember(token, channel, userId) {
  if (!channel || channel === 'off' || channel === 'none' || channel === 'false') return true;
  try {
    const chatTarget = channel.startsWith('@') || channel.startsWith('-') ? channel : '@' + channel;
    const res = await tgCall(token, 'getChatMember', {
      chat_id: chatTarget,
      user_id: Number(userId)
    });
    if (res?.ok && res.result) {
      const status = res.result.status;
      return (
        status === 'creator' ||
        status === 'administrator' ||
        status === 'member' ||
        (status === 'restricted' && Boolean(res.result.is_member))
      );
    }
    const errDesc = String(res?.description || '').toLowerCase();
    if (
      errDesc.includes('participant_id_invalid') ||
      errDesc.includes('user_not_participant') ||
      errDesc.includes('user not found') ||
      errDesc.includes('user not a participant')
    ) {
      return false;
    }
  } catch (err) {
    console.warn('checkChannelMember error:', err.message);
  }
  return true;
}

const channelErrorCache = new Map(); // target -> timestamp (TTL 5 mins)
const channelAlertCache = new Map(); // target -> timestamp (TTL 10 mins)

export function getShortChannelReason(reasonStr) {
  const low = String(reasonStr || '').toLowerCase();
  if (low.includes('kicked') || low.includes('restricted') || low.includes('banned') || low.includes('removed')) {
    return 'Bot Removed';
  }
  if (low.includes('chat_admin_required') || low.includes('administrator') || low.includes('rights') || low.includes('permission')) {
    return 'Not Admin';
  }
  if (low.includes('chat not found') || low.includes('invalid') || low.includes('deleted') || low.includes('inaccessible')) {
    return 'Chat Inaccessible';
  }
  return 'Not Admin';
}

export async function notifyAdminChannelIssue(
  token,
  adminId,
  ch,
  errorReason,
  actionLabel = 'Direct download allowed',
  force = false,
  customTitle = '',
  env = {}
) {
  if (!adminId) return;
  const now = Date.now();
  const lastAlert = channelAlertCache.get(ch) || 0;
  if (!force && now - lastAlert < 10 * 60 * 1000) return;
  channelAlertCache.set(ch, now);

  const cleanTitle = customTitle || ch || 'Connected Channel';
  const unamePart = ch.startsWith('@') ? `\nUsername: <b>${escapeHtml(ch)}</b>` : '';
  const shortReason = getShortChannelReason(errorReason);
  const cleanAction = actionLabel || 'Direct download allowed';

  try {
    await db.logServerError(
      0,
      cleanAction,
      ch.startsWith('@') ? ch : cleanTitle,
      'ChannelIssue',
      `${cleanTitle} | ${shortReason}`,
      'Telegram Chat',
      env
    );
  } catch {}

  const alertText =
    `⚠️ <b>Channel Issue Alert</b>\n` +
    `<blockquote>` +
    `Chat: <b>${escapeHtml(cleanTitle)}</b>` +
    unamePart +
    `\nReason: <b>${escapeHtml(shortReason)}</b>\n` +
    `Action: <b>${escapeHtml(cleanAction)}</b>` +
    `</blockquote>`;

  await tgCall(token, 'sendMessage', {
    chat_id: adminId,
    text: alertText,
    parse_mode: 'HTML'
  }).catch(() => {});
}

export async function syncBotCommandsAndProfile(token, env = {}) {
  const commands = [
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'How to use the bot' }
  ];
  let cmdRes = null;
  try {
    cmdRes = await tgCall(token, 'setMyCommands', { commands });
  } catch (e) {
    console.warn('setMyCommands failed:', e.message);
  }

  let menuRes = null;
  try {
    menuRes = await tgCall(token, 'setChatMenuButton', {
      menu_button: { type: 'commands' }
    });
  } catch {}

  const desc =
    '📥 TikTok Video Downloader!\n\n' +
    '🌐 Supported Platforms:\n' +
    '• TikTok: Videos, Photos & Audio\n\n' +
    '✨ Features:\n' +
    '• Download videos without watermark\n' +
    '• One tap MP3 audio extraction\n' +
    '• Fast, safe & unlimited downloads\n' +
    '• 100% free with no watermark\n\n' +
    'Send any TikTok link to download instantly!\n\n' +
    '📢 Updates: @RHToolsOfficial';

  const shortDesc = 'TikTok Video Downloader. Download HD Videos & MP3 for free without watermark.';

  try {
    await tgCall(token, 'setMyDescription', { description: desc });
  } catch {}

  try {
    await tgCall(token, 'setMyShortDescription', { short_description: shortDesc });
  } catch {}

  // Default Administrator Rights for Channels (ONLY Invite Users via Link)
  try {
    await tgCall(token, 'setMyDefaultAdministratorRights', {
      rights: {
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: false,
        can_manage_video_chats: false,
        can_restrict_members: false,
        can_promote_members: false,
        can_change_info: false,
        can_invite_users: true,
        can_post_stories: false,
        can_edit_stories: false,
        can_delete_stories: false,
        can_post_messages: false,
        can_edit_messages: false
      },
      for_channels: true
    });
  } catch {}

  // Default Administrator Rights for Groups (ONLY Invite Users via Link)
  try {
    await tgCall(token, 'setMyDefaultAdministratorRights', {
      rights: {
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: false,
        can_manage_video_chats: false,
        can_restrict_members: false,
        can_promote_members: false,
        can_change_info: false,
        can_invite_users: true,
        can_post_stories: false,
        can_edit_stories: false,
        can_delete_stories: false
      },
      for_channels: false
    });
  } catch {}

  return { ok: true, commands: cmdRes, menu: menuRes };
}

export async function getUnjoinedChannels(token, userId, currentChatId = null, currentChatUsername = null, env = {}) {
  const forceSubStatus = await db.getSetting('force_sub_status', env, 'on');
  if (forceSubStatus === 'off') return [];

  const channels = await db.getConnectedChats(env);
  if (!channels || channels.length === 0) return [];

  const inGroupSet = new Set();
  if (currentChatId) inGroupSet.add(String(currentChatId).toLowerCase());
  if (currentChatUsername) inGroupSet.add(currentChatUsername.replace(/^@/, '').toLowerCase());

  const channelsToCheck = channels.filter((ch) => {
    const normTarget = String(ch.target || '').replace(/^@/, '').toLowerCase();
    const normKey = String(ch.chat_key || '').toLowerCase();
    return !inGroupSet.has(normTarget) && !inGroupSet.has(normKey);
  });

  if (channelsToCheck.length === 0) return [];

  const { adminId } = getBotConfig(env);
  const now = Date.now();
  const unjoinedResults = await Promise.all(
    channelsToCheck.map(async (ch) => {
      const chTarget = ch.target;
      const norm = String(chTarget || '').toLowerCase();
      const lastErr = channelErrorCache.get(norm) || 0;
      if (now - lastErr < 5 * 60 * 1000) return null;

      try {
        const chatRef = chTarget.startsWith('-') ? Number(chTarget) : chTarget;
        const memRes = await tgCall(token, 'getChatMember', { chat_id: chatRef, user_id: Number(userId) });
        if (memRes?.ok && memRes.result) {
          channelErrorCache.delete(norm);
          const status = memRes.result.status;
          if (['left', 'kicked'].includes(status)) return ch;
          if (status === 'restricted' && memRes.result.is_member === false) return ch;
        } else {
          const errDesc = String(memRes?.description || '').toLowerCase();
          if (
            errDesc.includes('participant_id_invalid') ||
            errDesc.includes('user_not_participant') ||
            errDesc.includes('user not found') ||
            errDesc.includes('user not a participant')
          ) {
            channelErrorCache.delete(norm);
            return ch;
          } else {
            channelErrorCache.set(norm, now);
            await notifyAdminChannelIssue(
              token,
              adminId,
              chTarget,
              errDesc || 'Bot permission error',
              'Direct download allowed',
              false,
              ch.title,
              env
            );
            if (
              errDesc.includes('chat not found') ||
              errDesc.includes('kicked') ||
              errDesc.includes('bot was kicked') ||
              errDesc.includes('chat_id_invalid') ||
              errDesc.includes('peer_id_invalid')
            ) {
              try {
                const allChans = await db.getConnectedChats(env);
                const remaining = allChans.filter(
                  (c) =>
                    c.target.toLowerCase() !== chTarget.toLowerCase() &&
                    String(c.chat_key) !== String(chTarget)
                );
                if (remaining.length < allChans.length) {
                  await db.saveConnectedChats(remaining, env);
                }
              } catch {}
            }
          }
        }
      } catch (e) {}
      return null;
    })
  );

  return unjoinedResults.filter(Boolean);
}

export function buildForceSubPrompt(missingChannels = []) {
  const buttons = missingChannels.map((ch) => {
    const target = ch.target || '';
    const isGroup = ch.type === 'group' || target.startsWith('-');
    const defaultLabel = isGroup ? '👥 Join Group' : '📢 Join Channel';
    const label = ch.button_label?.trim() || ch.buttonLabel?.trim() || defaultLabel;
    let url = ch.invite_url || (target.startsWith('https://') ? target : (target.startsWith('@') ? `https://t.me/${target.replace(/^@/, '')}` : ''));
    if (!url || !url.startsWith('https://t.me/')) {
      url = target.startsWith('@') ? `https://t.me/${target.replace(/^@/, '')}` : 'https://t.me';
    }
    return [{ text: label, url }];
  });

  buttons.push([{ text: '✅ Joined', callback_data: 'verify_sub' }]);

  const text =
    '🔒 <b>Verification Required</b>\n\n' +
    '<blockquote>Please join our connected channels below to continue your download.</blockquote>';

  return { text, reply_markup: { inline_keyboard: buttons } };
}

export async function checkBotChatRights(token, chatId) {
  let rawBotId = token.includes(':') ? token.split(':')[0] : token;
  let botId = isNaN(Number(rawBotId)) ? rawBotId : Number(rawBotId);
  try {
    const mem = await tgCall(token, 'getChatMember', { chat_id: chatId, user_id: botId });
    if (!mem?.ok || !mem.result) {
      return { ok: false, reason: mem?.description || 'Could not verify bot admin membership' };
    }
    const res = mem.result;
    const st = res.status;
    if (st === 'creator') return { ok: true, reason: '' };
    if (st !== 'administrator') {
      return { ok: false, reason: 'Bot must be added as Administrator' };
    }
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err.message || 'Error checking bot permissions' };
  }
}

export async function connectChatCore(token, env, targetRef, fallbackTitle = '', buttonLabel = '') {
  let cleanTarget = String(targetRef).trim();
  const botTag = await getBotTag(token);
  const ownBot = (botTag || '').replace(/^@/, '').toLowerCase();

  const normT = cleanTarget.replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').toLowerCase();
  if (['share', 'addstickers', 'joinchat', ownBot].includes(normT)) {
    return {
      ok: false,
      text: '⚠️ <b>Invalid Chat:</b> Only Telegram Channels and Groups can be connected.'
    };
  }

  // Normalize target format
  if (cleanTarget.includes('t.me/')) {
    cleanTarget = `@${cleanTarget.split('t.me/')[1].replace('/', '')}`;
  }
  if (!cleanTarget.startsWith('@') && !cleanTarget.startsWith('-100') && isNaN(Number(cleanTarget))) {
    cleanTarget = `@${cleanTarget}`;
  }

  let chatCheck = null;
  try {
    chatCheck = await tgCall(token, 'getChat', { chat_id: cleanTarget });
  } catch (err) {
    const rawMsg = err.message || 'Chat not found';
    const lower = rawMsg.toLowerCase();
    let reason = 'Chat not found.';
    if (lower.includes('not an administrator') || lower.includes('chat_admin_required') || lower.includes('not enough rights')) {
      reason = 'Bot is not an administrator.';
    } else if (lower.includes('chat not found') || lower.includes('peer_id_invalid') || lower.includes('invalid chat')) {
      reason = 'Chat not found.';
    } else {
      reason = rawMsg.replace(/^bad request:\s*/i, '');
      if (!reason.endsWith('.')) reason += '.';
    }
    return {
      ok: false,
      text: `⚠️ <b>Failed to connect chat</b>\n<blockquote>${escapeHtml(reason)} Make sure the bot is an admin in your channel.</blockquote>`
    };
  }

  if (!chatCheck?.ok || !chatCheck.result) {
    const rawMsg = chatCheck?.description || 'Chat not found';
    const lower = rawMsg.toLowerCase();
    let reason = 'Chat not found.';
    if (lower.includes('not an administrator') || lower.includes('chat_admin_required') || lower.includes('not enough rights')) {
      reason = 'Bot is not an administrator.';
    } else if (lower.includes('chat not found') || lower.includes('peer_id_invalid') || lower.includes('invalid chat')) {
      reason = 'Chat not found.';
    } else {
      reason = rawMsg.replace(/^bad request:\s*/i, '');
      if (!reason.endsWith('.')) reason += '.';
    }
    return {
      ok: false,
      text: `⚠️ <b>Failed to connect chat</b>\n<blockquote>${escapeHtml(reason)} Make sure the bot is an admin in your channel.</blockquote>`
    };
  }

  const chatObj = chatCheck.result;
  const dispName = chatObj.title || chatObj.username || fallbackTitle || cleanTarget;

  if (chatObj && chatObj.type === 'private') {
    return {
      ok: false,
      text: `⚠️ <b>Failed to connect chat</b>\n<blockquote>Only channels and groups can be connected. Make sure the bot is an admin in your channel.</blockquote>`
    };
  }

  const { ok: rightsOk, reason: rightsReason } = await checkBotChatRights(token, chatObj.id || cleanTarget);
  if (!rightsOk) {
    return {
      ok: false,
      text: `⚠️ <b>Failed to connect chat</b>\n<blockquote>Bot is not an administrator. Make sure the bot is an admin in your channel.</blockquote>`
    };
  }

  const channels = await db.getConnectedChats(env);
  const target = chatObj.username ? `@${chatObj.username}` : (cleanTarget.startsWith('@') ? cleanTarget : String(chatObj.id || cleanTarget));
  const altTarget = String(chatObj.id || cleanTarget);

  const isAlready = channels.some(
    (c) =>
      (c.target && target && c.target.toLowerCase() === target.toLowerCase()) ||
      (c.chat_key && altTarget && String(c.chat_key) === altTarget) ||
      (c.target && altTarget && c.target.toLowerCase() === altTarget.toLowerCase()) ||
      (c.chat_key && target && String(c.chat_key).toLowerCase() === target.toLowerCase())
  );
  if (isAlready) {
    const kind = ['group', 'supergroup'].includes(chatObj.type) ? 'Group' : 'Channel';
    return {
      ok: false,
      text: `⚠️ <b>Failed to connect chat</b>\n<blockquote>${kind} is already connected.</blockquote>`
    };
  }

  if (channels.length >= 3) {
    return {
      ok: false,
      text: '⚠️ <b>Failed to connect chat</b>\n<blockquote>Limit reached (3/3).</blockquote>'
    };
  }

  let inviteUrl = chatObj.invite_link || '';
  if (!inviteUrl && !chatObj.username) {
    try {
      const exp = await tgCall(token, 'exportChatInviteLink', { chat_id: chatObj.id || cleanTarget });
      if (exp?.ok && typeof exp.result === 'string') inviteUrl = exp.result;
    } catch {}
  }

  const chatType = chatObj.type || (String(cleanTarget).startsWith('-') ? 'group' : 'channel');
  const customLabel = buttonLabel?.trim() || undefined;
  channels.push({
    target,
    title: chatObj.title || dispName,
    chat_key: altTarget,
    type: ['group', 'supergroup'].includes(chatType) ? 'group' : 'channel',
    invite_url: inviteUrl || (chatObj.username ? `https://t.me/${chatObj.username}` : ''),
    button_label: customLabel
  });
  await db.saveConnectedChats(channels, env);
  await db.setSetting('force_sub_status', 'on', env);

  const labelInfo = customLabel ? ` [Button: <b>${escapeHtml(customLabel)}</b>]` : '';
  const chList = formatConnectedChatsList(channels);
  return {
    ok: true,
    text: `✅ Connected: <b>${escapeHtml(dispName)}</b>${labelInfo}\n\n<b>Connected Chats (${channels.length}/3):</b>\n${chList}`
  };
}

export async function handleMyChatMember(myChatMember, token, env = {}, ctx = null) {
  if (!myChatMember) return;
  const chat = myChatMember.chat;
  const user = myChatMember.from;
  const oldStatus = myChatMember.old_chat_member?.status;
  const newStatus = myChatMember.new_chat_member?.status;
  const { adminId } = getBotConfig(env);
  const isAdmin = user && (user.id === adminId || String(user.id) === String(adminId));

  const target = chat.username ? `@${chat.username}` : String(chat.id);
  const altTarget = String(chat.id);
  const title = chat.title || target;

  // 1. If bot was removed, kicked, or demoted from Administrator in a connected chat -> auto-disconnect & alert Admin
  if (['left', 'kicked'].includes(newStatus) || (oldStatus === 'administrator' && newStatus !== 'administrator')) {
    const channels = await db.getConnectedChats(env);
    const removedChat = channels.find(
      (c) =>
        (c.target && target && c.target.toLowerCase() === target.toLowerCase()) ||
        (c.chat_key && altTarget && String(c.chat_key) === altTarget) ||
        (c.target && altTarget && c.target.toLowerCase() === altTarget.toLowerCase()) ||
        (c.chat_key && target && String(c.chat_key).toLowerCase() === target.toLowerCase())
    );

    const newChannels = channels.filter((c) => c !== removedChat);
    if (removedChat || newChannels.length < channels.length) {
      await db.saveConnectedChats(newChannels, env);
      const dispTitle = removedChat?.title || title;
      const dispTarget = removedChat?.target || target;
      await tgCall(token, 'sendMessage', {
        chat_id: adminId,
        text: `🗑️ <b>Chat Disconnected:</b> <b>${escapeHtml(dispTitle)}</b> (${escapeHtml(dispTarget)})`,
        parse_mode: 'HTML'
      });
    } else if (isAdmin) {
      await tgCall(token, 'sendMessage', {
        chat_id: adminId,
        text: `🗑️ <b>Chat Disconnected:</b> <b>${escapeHtml(title)}</b> (${escapeHtml(target)})`,
        parse_mode: 'HTML'
      });
    }
    return;
  }

  // 2. If a non-admin adds the bot:
  // Auto-leave channels (users cannot send messages in channels).
  // Stay in groups so members can download videos (while NEVER adding to Force-Join list).
  if (!isAdmin) {
    if (chat.type === 'channel' && ['member', 'administrator'].includes(newStatus)) {
      try {
        await tgCall(token, 'leaveChat', { chat_id: chat.id });
      } catch {}
    }
    return;
  }

  // 3. Authorized Admin added the bot as Administrator:
  // Auto-connect chat (matching PhotoMetadataCleanerBot behavior)
  if (['channel', 'group', 'supergroup'].includes(chat.type) && newStatus === 'administrator' && oldStatus !== 'administrator') {
    if (user?.id) adminViewState.set(user.id, 'PANEL');
    const channels = await db.getConnectedChats(env);
    const isAlreadyConnected = channels.some(
      (c) =>
        (c.target && target && c.target.toLowerCase() === target.toLowerCase()) ||
        (c.chat_key && altTarget && String(c.chat_key) === altTarget) ||
        (c.target && altTarget && c.target.toLowerCase() === altTarget.toLowerCase()) ||
        (c.chat_key && target && String(c.chat_key).toLowerCase() === target.toLowerCase())
    );
    if (isAlreadyConnected) return;

    if (channels.length >= 3) {
      await tgCall(token, 'sendMessage', {
        chat_id: adminId,
        text: `🔔 <b>Bot added to ${chat.type === 'channel' ? 'Channel' : 'Group'}:</b> <b>${escapeHtml(title)}</b>\n\n<blockquote>Join Verification limit reached (3/3). Not added.</blockquote>`,
        parse_mode: 'HTML'
      });
      return;
    }

    const res = await connectChatCore(token, env, target, title);
    const updatedChannels = await db.getConnectedChats(env);
    if (res.ok) {
      await tgCall(token, 'sendMessage', {
        chat_id: adminId,
        text: `✅ <b>Connected:</b> <b>${escapeHtml(title)}</b> (${escapeHtml(target)})\n\n<b>Connected Chats (${updatedChannels.length}/3):</b>\n${formatConnectedChatsList(updatedChannels)}`,
        parse_mode: 'HTML'
      });
    } else {
      await tgCall(token, 'sendMessage', {
        chat_id: adminId,
        text: res.text,
        parse_mode: 'HTML'
      });
    }
    return;
  }
}

export async function handleUserChatMember(chatMemberUpdate, token, env = {}, ctx = null) {
  if (!chatMemberUpdate) return;
  const newMember = chatMemberUpdate.new_chat_member;
  if (!newMember || !newMember.user) return;
  const uid = newMember.user.id;
  const newStatus = newMember.status;
  if (['member', 'administrator', 'creator'].includes(newStatus)) {
    // User joined a connected chat in real-time -> mark verified!
    db.setUserVerifiedMemory(uid, 5000);
  } else if (['left', 'kicked'].includes(newStatus)) {
    // User left or was kicked/banned -> IMMEDIATELY revoke verification!
    db.revokeUserVerifiedMemory(uid);
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Health check & status JSON endpoint (available at / and /health)
    if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/health' || url.pathname === '/')) {
      const stats = request.method === 'HEAD' ? {} : await db.getStats(env);
      return new Response(
        request.method === 'HEAD'
          ? null
          : JSON.stringify(
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
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // Set webhook helper route: GET /setWebhook
    if (request.method === 'GET' && (url.pathname === '/setWebhook' || url.pathname === '/webhookInfo' || url.pathname === '/setup' || url.pathname === '/setCommands' || url.pathname === '/setcommands')) {
      const botToken = env.BOT_TOKEN;
      if (!botToken || botToken === 'YOUR_BOT_TOKEN_HERE') {
        return new Response('Error: BOT_TOKEN is not configured.', { status: 400 });
      }
      if (url.pathname === '/webhookInfo') {
        const info = await tgCall(botToken, 'getWebhookInfo', {});
        return new Response(JSON.stringify(info, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const data = await tgCall(botToken, 'setWebhook', {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member', 'chat_join_request']
      });
      const syncRes = await syncBotCommandsAndProfile(botToken, env).catch(() => null);
      return new Response(JSON.stringify({ webhook: data, commands: syncRes }, null, 2), {
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
        const task = handleUpdate(update, botToken, env, ctx).catch((err) => {
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

const adminViewState = new Map(); // userId -> 'MAIN' | 'PANEL' | 'SUBMENU'
const adminBroadcastState = new Map(); // userId -> { stage, chat_id, message_id, preview_msg_id, auto_delete_mins }
const adminWaitingAddChat = new Map(); // userId -> boolean
const adminCacheClearState = new Map(); // userId -> boolean
const inlinePendingDownloads = new Map(); // token -> url

export function getMainAdminKeyboard() {
  return {
    keyboard: [[{ text: '⚙️ Admin Panel' }]],
    resize_keyboard: true
  };
}

export function getAdminPanelKeyboard(channels = []) {
  const chRights = {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: true,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
    can_post_messages: false,
    can_edit_messages: false
  };
  const grpRights = {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: true,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false
  };

  let addRow;
  if (channels.length < 3) {
    addRow = [
      {
        text: '📢 Add Channel',
        request_chat: {
          request_id: 101,
          chat_is_channel: true,
          user_administrator_rights: chRights,
          bot_administrator_rights: chRights,
          request_title: true,
          request_username: true
        }
      },
      {
        text: '👥 Add Group',
        request_chat: {
          request_id: 102,
          chat_is_channel: false,
          user_administrator_rights: grpRights,
          bot_administrator_rights: grpRights,
          request_title: true,
          request_username: true
        }
      }
    ];
  } else {
    addRow = [
      { text: '📢 Add Channel' },
      { text: '👥 Add Group' }
    ];
  }

  const rows = [addRow];
  if (channels.length > 0) {
    rows.push([{ text: '🗑️ Disconnect' }, { text: '📣 Broadcast' }]);
    rows.push([{ text: '🗑️ Clear Cache' }, { text: '📊 Activity' }]);
    rows.push([{ text: 'Back' }]);
  } else {
    rows.push([{ text: '📣 Broadcast' }, { text: '🗑️ Clear Cache' }]);
    rows.push([{ text: '📊 Activity' }, { text: 'Back' }]);
  }

  return { keyboard: rows, resize_keyboard: true };
}

export function getDisconnectKeyboard(channels = []) {
  const rows = channels.map((c) => [{ text: `❌ Disconnect ${c.title || c.target}` }]);
  rows.push([{ text: 'Back' }]);
  return { keyboard: rows, resize_keyboard: true };
}

export function getBroadcastConfirmKeyboard(autoDeleteMins = 10) {
  const opts = [[10, '10m'], [30, '30m'], [60, '1h'], [1440, '24h'], [0, 'Off']];
  const timerRow = opts.map(([val, label]) => {
    const btnTxt = autoDeleteMins === val ? `${label} ✓` : label;
    return { text: btnTxt };
  });
  return {
    keyboard: [
      timerRow,
      [{ text: '✅ Confirm' }, { text: '❌ Cancel' }]
    ],
    resize_keyboard: true
  };
}

export function formatAutoDeleteLabel(mins) {
  if (mins <= 0) return 'Off';
  if (mins % 60 === 0 && mins >= 60) {
    const hrs = mins / 60;
    return hrs === 1 ? `${hrs} hr` : `${hrs} hrs`;
  }
  return mins === 1 ? `${mins} min` : `${mins} mins`;
}

export function formatConnectedChatsList(channels = []) {
  if (!channels || channels.length === 0) return '• <i>None</i>';
  return channels
    .map((c) => {
      const title = c.title || c.target;
      const target = c.target || '';
      const url =
        c.invite_url ||
        (target.startsWith('https://')
          ? target
          : target.startsWith('@')
          ? `https://t.me/${target.replace(/^@/, '')}`
          : '');
      if (url) {
        return `• <a href="${url}"><b>${escapeHtml(title)}</b></a>`;
      }
      return `• <b>${escapeHtml(title)}</b>`;
    })
    .join('\n');
}

async function showAdminDashboard(chatId, token, env) {
  adminViewState.set(Number(chatId), 'PANEL');
  const stats = await db.getStats(env);
  const channels = await db.getConnectedChats(env);
  const forceSubStatus = await db.getSetting('force_sub_status', env, 'on');
  const statusTag = forceSubStatus === 'off' ? 'Paused' : 'Active';
  const chList = formatConnectedChatsList(channels);
  const totalUsers = stats.users || 0;
  const activeUsers = stats.activeUsers || totalUsers;
  const totalDownloads = stats.downloads || 0;
  const cachedVideos = stats.cachedVideos || 0;

  const statsBlock =
    `⚙️ <b>Admin Panel</b>\n` +
    `<blockquote>` +
    `Total Users: <b>${totalUsers}</b>\n` +
    `Active Users: <b>${activeUsers}</b>\n` +
    `Total Downloads: <b>${totalDownloads}</b>\n` +
    `Cached Videos: <b>${cachedVideos}</b>\n` +
    `Force Join Gate: <b>${statusTag}</b>` +
    `</blockquote>`;

  let dashboardText;
  if (channels.length > 0) {
    dashboardText = `${statsBlock}\n\n<b>Connected Chats (${channels.length}/3):</b>\n${chList}`;
  } else {
    dashboardText = `${statsBlock}\n\n<b>Connected Chats (0/3)</b>`;
  }

  return tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text: dashboardText,
    parse_mode: 'HTML',
    reply_markup: getAdminPanelKeyboard(channels)
  });
}

async function handleUpdate(update, token, env = {}, ctx = null) {
  if (!update) return;

  // 1. Bot Membership Updates in Channels & Groups
  if (update.my_chat_member) {
    return handleMyChatMember(update.my_chat_member, token, env, ctx);
  }

  // 2. Real-time User Membership Updates in Channels & Groups
  if (update.chat_member) {
    return handleUserChatMember(update.chat_member, token, env, ctx);
  }

  // 3. Callback Queries
  if (update.callback_query) {
    return handleCallback(update.callback_query, token, env, ctx);
  }

  // 4. Inline Queries
  if (update.inline_query) {
    return handleInlineQuery(update.inline_query, token, env, ctx);
  }

  // 5. Regular Messages
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id || chatId;
  const botTag = await getBotTag(token);
  const { channelTag, adminId } = getBotConfig(env);
  const isAdminUser = chatId === adminId || userId === adminId;

  if (msg.from && msg.chat?.type === 'private') {
    bgTask(db.upsertUser({ id: userId, username: msg.from.username, firstName: msg.from.first_name }, env), ctx);
  }

  // Handle Telegram request_chat shared responses with strict validation
  if (isAdminUser && msg.chat_shared) {
    adminViewState.set(userId, 'PANEL');
    const sharedChatId = msg.chat_shared.chat_id;
    const res = await connectChatCore(token, env, sharedChatId, msg.chat_shared.title || '');
    const channels = await db.getConnectedChats(env);
    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: res.text,
      parse_mode: 'HTML',
      reply_markup: getAdminPanelKeyboard(channels)
    });
  }

  let text = extractInputTextWithEntities(msg) || '';
  const cmdToken = text.split(/\s+/)[0].split('@')[0].toLowerCase();

  // Admin Broadcast Composer Handler
  if (isAdminUser && adminBroadcastState.has(userId)) {
    const bcast = adminBroadcastState.get(userId);
    const adminNavButtons = new Set([
      'Add Channel', 'Add Group', '📢 Add Channel', '👥 Add Group',
      'Disconnect', 'Disconnect Channel', '🗑️ Disconnect Channel', '🗑️ Disconnect',
      'Broadcast', '📣 Broadcast', 'Activity', '📊 Activity', '🔄 Refresh Activity',
      'Clear Cache Video', '🗑️ Clear Cache Video', 'Clear Cache', '🗑️ Clear Cache',
      'Clear Logs', '🗑️ Clear Logs', 'Logs', '📄 Logs'
    ]);

    if (adminNavButtons.has(text) || text.startsWith('Disconnect ') || text.startsWith('❌ Disconnect ')) {
      adminBroadcastState.delete(userId);
    } else if (bcast?.stage === 'WAITING_MESSAGE') {
      if (['Admin', '⚙️ Admin', 'Admin Panel', '⚙️ Admin Panel', '⚙️ Admin Dashboard', '/admin', 'Back', '⬅️ Back to Admin', '⬅️ Back', '❌ Cancel Broadcast', 'Cancel', '/cancel'].includes(text)) {
        adminBroadcastState.delete(userId);
        return showAdminDashboard(chatId, token, env);
      }

      const previewRes = await tgCall(token, 'copyMessage', {
        chat_id: chatId,
        from_chat_id: chatId,
        message_id: msg.message_id
      });

      const allUids = await db.getAllUserIds(env);
      const targetCount = allUids.length;
      const userWord = targetCount === 1 ? 'user' : 'users';

      adminBroadcastState.set(userId, {
        stage: 'CONFIRM',
        chat_id: chatId,
        message_id: msg.message_id,
        preview_msg_id: previewRes?.result?.message_id,
        auto_delete_mins: 10
      });

      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text:
          `<b>Broadcast Preview Above</b>\n` +
          `Recipients: <b>${targetCount} ${userWord}</b>\n` +
          `Auto Delete: <b>10 mins</b>`,
        parse_mode: 'HTML',
        reply_markup: getBroadcastConfirmKeyboard(10)
      });
    } else if (bcast?.stage === 'CONFIRM') {
      const cleanT = text.replace(/✓/g, '').trim().toLowerCase();
      if (['10m', '30m', '1h', '24h', 'off'].includes(cleanT) || /^\d+\s*[mh]?$/.test(cleanT)) {
        let newMins = 10;
        if (cleanT === 'off') newMins = 0;
        else if (cleanT.endsWith('h')) newMins = parseInt(cleanT, 10) * 60;
        else if (cleanT.endsWith('m')) newMins = parseInt(cleanT, 10);
        else newMins = parseInt(cleanT, 10);

        bcast.auto_delete_mins = newMins;
        const allUids = await db.getAllUserIds(env);
        const targetCount = allUids.length;
        const userWord = targetCount === 1 ? 'user' : 'users';

        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            `<b>Broadcast Preview Above</b>\n` +
            `Recipients: <b>${targetCount} ${userWord}</b>\n` +
            `Auto Delete: <b>${formatAutoDeleteLabel(newMins)}</b>`,
          parse_mode: 'HTML',
          reply_markup: getBroadcastConfirmKeyboard(newMins)
        });
      }

      if (['✅ Confirm', 'Confirm', 'Confirm & Send', '✅ Confirm & Send'].includes(text)) {
        adminBroadcastState.delete(userId);
        adminViewState.set(userId, 'PANEL');
        const channels = await db.getConnectedChats(env);
        await tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: '⏳ <b>Broadcasting...</b>',
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(channels)
        });

        const userIds = await db.getAllUserIds(env);
        let sent = 0;
        let failed = 0;
        const delivered = [];

        for (const uid of userIds) {
          try {
            const r = await tgCall(token, 'copyMessage', {
              chat_id: uid,
              from_chat_id: bcast.chat_id,
              message_id: bcast.message_id
            });
            if (r?.ok && r.result?.message_id) {
              sent++;
              delivered.push({ chat_id: uid, message_id: r.result.message_id });
            } else {
              failed++;
            }
          } catch {
            failed++;
          }
        }

        if (bcast.auto_delete_mins > 0 && delivered.length > 0) {
          bgTask((async () => {
            await new Promise((r) => setTimeout(r, bcast.auto_delete_mins * 60 * 1000));
            for (const d of delivered) {
              await tgCall(token, 'deleteMessage', d).catch(() => {});
            }
          })(), ctx);
        }

        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            `✅ <b>Broadcast Completed</b>\n` +
            `Delivered: <b>${sent}</b>\n` +
            `Failed: <b>${failed}</b>\n` +
            `Auto Delete: <b>${formatAutoDeleteLabel(bcast.auto_delete_mins)}</b>`,
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(channels)
        });
      }

      if (['❌ Cancel', 'Cancel', 'Back', '⬅️ Back', 'Admin', '⚙️ Admin'].includes(text)) {
        if (bcast.preview_msg_id) {
          await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: bcast.preview_msg_id }).catch(() => {});
        }
        adminBroadcastState.delete(userId);
        return showAdminDashboard(chatId, token, env);
      }

      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Tap <b>✅ Confirm</b> or <b>❌ Cancel</b> below.',
        parse_mode: 'HTML',
        reply_markup: getBroadcastConfirmKeyboard(bcast.auto_delete_mins || 10)
      });
    }
  }

  // Admin Cache Clear Mode Handler
  if (isAdminUser && adminCacheClearState.has(userId)) {
    const adminNavButtons = new Set([
      'Admin', '⚙️ Admin', 'Admin Panel', '⚙️ Admin Panel', '⚙️ Admin Dashboard', '/admin',
      'Back', '⬅️ Back to Admin', '⬅️ Back', 'Cancel', '/cancel',
      'Add Channel', 'Add Group', '📢 Add Channel', '👥 Add Group',
      'Disconnect', 'Disconnect Channel', '🗑️ Disconnect Channel', '🗑️ Disconnect',
      'Broadcast', '📣 Broadcast', 'Activity', '📊 Activity', '🔄 Refresh Activity',
      'Clear Cache Video', '🗑️ Clear Cache Video', 'Clear Cache', '🗑️ Clear Cache',
      'Clear Logs', '🗑️ Clear Logs', 'Logs', '📄 Logs'
    ]);

    if (['Back', '⬅️ Back to Admin', '⬅️ Back', 'Cancel', '/cancel', 'Admin', '⚙️ Admin', 'Admin Panel', '⚙️ Admin Panel', '⚙️ Admin Dashboard', '/admin'].includes(text)) {
      adminCacheClearState.delete(userId);
      return showAdminDashboard(chatId, token, env);
    }

    if (adminNavButtons.has(text) || text.startsWith('Disconnect ') || text.startsWith('❌ Disconnect ')) {
      adminCacheClearState.delete(userId);
      // Fall through to admin navigation below
    } else {
      const parsedUrl = extractTikTokUrl(text.trim());
      let vid = parsedUrl ? (parsedUrl.match(/\/(?:video|photo|v|post)\/([0-9]+)/i)?.[1]) : null;
      if (!vid && parsedUrl) {
        vid = await resolveShortLinkIdFast(parsedUrl, 3000);
      }
      if (vid) {
        await db.invalidateCachedMedia(vid, env);
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            `🗑️ <b>Cache Reset Successfully</b>\n\n` +
            `<blockquote><b>TikTok Post:</b> <code>${escapeHtml(vid)}</code>\n` +
            `Cached media removed.</blockquote>`,
          parse_mode: 'HTML'
        });
      } else {
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            `⚠️ <b>Invalid Link</b>\n\n` +
            `<blockquote>Please send a valid TikTok video link to clear cache.</blockquote>`,
          parse_mode: 'HTML'
        });
      }
    }
  }

  // Admin Navigation Handlers
  if (isAdminUser) {
    if (['Admin', '⚙️ Admin', 'Admin Panel', '⚙️ Admin Panel', '⚙️ Admin Dashboard', '/admin', 'Refresh', '🔄 Refresh', '⬅️ Back to Admin'].includes(text)) {
      adminBroadcastState.delete(userId);
      adminWaitingAddChat.delete(userId);
      adminCacheClearState.delete(userId);
      return showAdminDashboard(chatId, token, env);
    }

    if (['Back', 'Cancel', '❌ Cancel', '⬅️ Cancel', '⬅️ Back', '⬅️ Back to Menu'].includes(text)) {
      adminBroadcastState.delete(userId);
      adminWaitingAddChat.delete(userId);
      adminCacheClearState.delete(userId);
      if (adminViewState.get(userId) === 'SUBMENU') {
        return showAdminDashboard(chatId, token, env);
      } else {
        adminViewState.set(userId, 'MAIN');
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: 'Exited',
          reply_markup: getMainAdminKeyboard()
        });
      }
    }

    if (['Clear Cache Video', '🗑️ Clear Cache Video', 'Clear Cache', '🗑️ Clear Cache'].includes(text)) {
      adminBroadcastState.delete(userId);
      adminWaitingAddChat.delete(userId);
      adminViewState.set(userId, 'SUBMENU');
      adminCacheClearState.set(userId, true);
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text:
          `🗑️ <b>Clear Cache Video</b>\n\n` +
          `<blockquote>Send the video link to clear its cached media.\n` +
          `You can send multiple links one by one.</blockquote>`,
        parse_mode: 'HTML',
        reply_markup: { keyboard: [[{ text: 'Back' }]], resize_keyboard: true }
      });
    }

    if (['Add Channel', 'Add Group', '📢 Add Channel', '👥 Add Group'].includes(text)) {
      adminCacheClearState.delete(userId);
      const channels = await db.getConnectedChats(env);
      if (channels.length >= 3) {
        adminWaitingAddChat.delete(userId);
        adminViewState.set(userId, 'PANEL');
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: '⚠️ Limit reached (<b>3/3</b>).',
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(channels)
        });
      } else {
        adminWaitingAddChat.set(userId, true);
        adminViewState.set(userId, 'SUBMENU');
        const botUser = (await getBotTag(token)).replace(/^@/, '') || 'TheTikTokDownloaderBot';
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            `📢 <b>Connect Channel or Group:</b>\n\n` +
            `1. Add @${botUser} as an <b>Administrator</b> in your channel or group.\n` +
            `2. Send the channel <b>@username</b>, <b>-100... ID</b>, or forward any post from it here.`,
          parse_mode: 'HTML',
          reply_markup: { keyboard: [[{ text: 'Back' }]], resize_keyboard: true }
        });
      }
    }

    if (['Disconnect', 'Disconnect Channel', '🗑️ Disconnect Channel', '🗑️ Disconnect'].includes(text)) {
      const channels = await db.getConnectedChats(env);
      if (!channels || channels.length === 0) {
        adminViewState.set(userId, 'PANEL');
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: 'No connected chats.',
          reply_markup: getAdminPanelKeyboard(channels)
        });
      }
      adminViewState.set(userId, 'SUBMENU');
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '<b>Select to disconnect:</b>',
        parse_mode: 'HTML',
        reply_markup: getDisconnectKeyboard(channels)
      });
    }

    if (text.startsWith('Disconnect ') || text.startsWith('❌ Disconnect ')) {
      const prefix = text.startsWith('❌ Disconnect ') ? '❌ Disconnect ' : 'Disconnect ';
      const targetDisp = text.slice(prefix.length).trim();
      const channels = await db.getConnectedChats(env);
      const remaining = channels.filter((c) => {
        const disp = c.title || c.target;
        return disp.trim().toLowerCase() !== targetDisp.toLowerCase() && c.target.toLowerCase() !== targetDisp.toLowerCase() && c.chat_key !== targetDisp;
      });
      if (remaining.length < channels.length) {
        await db.saveConnectedChats(remaining, env);
      }
      if (remaining.length > 0) {
        adminViewState.set(userId, 'SUBMENU');
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: `✅ Disconnected: <b>${escapeHtml(targetDisp)}</b>`,
          parse_mode: 'HTML',
          reply_markup: getDisconnectKeyboard(remaining)
        });
      } else {
        adminViewState.set(userId, 'PANEL');
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: `✅ Disconnected: <b>${escapeHtml(targetDisp)}</b>`,
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(remaining)
        });
      }
    }

    if (['Broadcast', '📣 Broadcast'].includes(text)) {
      adminViewState.set(userId, 'SUBMENU');
      adminBroadcastState.set(userId, { stage: 'WAITING_MESSAGE', auto_delete_mins: 10 });
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Send any message (text, photo, or video) to preview it.',
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: [[{ text: 'Back' }]],
          resize_keyboard: true
        }
      });
    }

    if (['Activity', '📊 Activity', '🔄 Refresh Activity'].includes(text)) {
      adminViewState.set(userId, 'SUBMENU');
      const errors = await db.getRecentServerErrors(15, env);
      if (errors && errors.length > 0) {
        const issueBlocks = errors.map((err, idx) => {
          const ts = err.created_at || '';
          const rawUrl = err.url || '';
          const linkStr = rawUrl.startsWith('http') ? `<a href="${escapeHtml(rawUrl)}">Click Here</a>` : '<b>Unavailable</b>';
          const reason = err.error_message || err.error_type || 'Server error';
          const shortReason = escapeHtml(reason.slice(0, 100));
          return (
            `<blockquote>` +
            `${idx + 1}. <b>${escapeHtml(err.platform || 'TikTok')} Issue</b>\n` +
            `Link: ${linkStr}\n` +
            `Reason: <b>${shortReason}</b>\n` +
            `Time: <b>${escapeHtml(ts)}</b>` +
            `</blockquote>`
          );
        });

        const activityText = `⚠️ <b>Issues (${errors.length}):</b>\n\n${issueBlocks.join('\n\n')}`;
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: activityText.slice(0, 4000),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            keyboard: [
              [{ text: '📄 Logs' }, { text: '🗑️ Clear Logs' }],
              [{ text: 'Back' }]
            ],
            resize_keyboard: true
          }
        });
      } else {
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            `📊 <b>System Activity</b>\n` +
            `<blockquote>Status: <b>Healthy</b>\n` +
            `Issues: <b>None</b></blockquote>`,
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [
              [{ text: '📄 Logs' }, { text: 'Back' }]
            ],
            resize_keyboard: true
          }
        });
      }
    }

    if (['Clear Logs', '🗑️ Clear Logs'].includes(text)) {
      await db.clearServerErrors(env);
      adminViewState.set(userId, 'PANEL');
      const channels = await db.getConnectedChats(env);
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '✅ Logs cleared.',
        reply_markup: getAdminPanelKeyboard(channels)
      });
    }

    if (['Logs', '📄 Logs', 'Download Logs', '📄 Download Logs'].includes(text)) {
      const now = new Date();
      const nowStr = now.toISOString().replace('T', ' ').slice(0, 19);
      const fileTimestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);

      const channels = await db.getConnectedChats(env);
      const errors = await db.getRecentServerErrors(100, env);

      let stats = { users: 0, downloads: 0, cached: 0, cacheHits: 0 };
      try {
        stats = await db.getStats(env);
      } catch {}

      const chList = channels.map((c, i) => `  ${i + 1}. ${c.title || c.target} (${c.target}) [${c.type || 'channel'}]`).join('\n') || '  None connected';

      const logHeader = [
        '================================================================================',
        '                        BOT SYSTEM AUDIT & DIAGNOSTIC LOGS                       ',
        '================================================================================',
        `Generated: ${nowStr} UTC`,
        `Platform : Cloudflare Workers Edge Runtime + D1 SQL Database`,
        `Bot Name : @${botTag}`,
        `Admin ID : ${adminId}`,
        `Status   : Operational (100% Health)`,
        '',
        '--------------------------------------------------------------------------------',
        'SYSTEM ENVIRONMENT & BOT CONFIGURATION',
        '--------------------------------------------------------------------------------',
        `Low Cost Mode : ${env.LOW_COST_MODE || 'true'}`,
        `Database Type : Cloudflare D1 Serverless SQL`,
        `Total Registered Users: ${stats.users || 0}`,
        `Total Delivered Media : ${stats.downloads || 0}`,
        `Cached Unique Hashes  : ${stats.cached || 0}`,
        `Instant Cache Hits    : ${stats.cacheHits || 0}`,
        `Connected Force-Sub Chats: ${channels.length}/3`,
        chList,
        '',
        '--------------------------------------------------------------------------------',
        'INCIDENT LOGS & EXTRACTION ERRORS',
        '--------------------------------------------------------------------------------'
      ];

      let errorSection = '';
      if (!errors || errors.length === 0) {
        errorSection = 'Zero error incidents logged. Extraction & API operations running at 100% health.';
      } else {
        errorSection = errors.map((e, i) => `#${i + 1} [${e.created_at}] [${e.platform || 'TIKTOK'}] ${e.error_message}\n    URL: ${e.url}`).join('\n\n');
      }

      const fullLog = `${logHeader.join('\n')}\n${errorSection}\n\n================================================================================\nEND OF LOG FILE\n================================================================================\n`;

      try {
        const blob = new Blob([fullLog], { type: 'text/plain;charset=utf-8' });
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('document', blob, `bot_system_logs_${fileTimestamp}.txt`);

        const sent = await tgCallMultipart(token, 'sendDocument', form);
        if (sent?.ok) {
          return sent;
        }
      } catch {}

      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: `📄 <b>System Status & Diagnostic:</b>\n\n` +
          `• <b>Bot:</b> @${botTag}\n` +
          `• <b>Health:</b> 100% Operational\n` +
          `• <b>Connected Chats:</b> ${channels.length}/3\n` +
          `• <b>Recent Incidents:</b> ${errors.length} logged\n\n` +
          `<pre>${escapeHtml(fullLog.slice(-1500))}</pre>`,
        parse_mode: 'HTML',
        reply_markup: getMainAdminKeyboard()
      });
    }

    // Manual text / forward adding when waiting
    if (adminWaitingAddChat.get(userId)) {
      let targetCh = null;
      let targetTitle = null;
      let targetLabel = '';
      const fwdChat = msg.forward_from_chat;
      if (fwdChat) {
        targetCh = fwdChat.username ? `@${fwdChat.username}` : String(fwdChat.id);
        targetTitle = fwdChat.title;
      } else {
        const parts = text.trim().split(/\s+/);
        const first = parts[0];
        targetLabel = parts.slice(1).join(' ').trim();
        if (first.startsWith('@') || first.startsWith('-100')) {
          targetCh = first;
        } else {
          const tme = first.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,})\/?$/i);
          if (tme) {
            targetCh = `@${tme[1]}`;
          } else if (!first.startsWith('/')) {
            targetCh = first;
          }
        }
      }

      if (targetCh) {
        adminWaitingAddChat.delete(userId);
        adminViewState.set(userId, 'PANEL');
        const res = await connectChatCore(token, env, targetCh, targetTitle || '', targetLabel);
        const channels = await db.getConnectedChats(env);
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: res.text,
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(channels)
        });
      } else {
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: '⚠️ <b>Invalid Channel/Group:</b> Please forward a message from the channel or send a valid @username or chat ID.',
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(await db.getConnectedChats(env))
        });
      }
    }

    if (cmdToken === '/channel' || cmdToken === '/channel_off' || cmdToken === '/channel_on') {
      const parts = text.trim().split(/\s+/);
      const newChan = parts[1]?.trim();
      const customLabel = parts.slice(2).join(' ').trim();
      if (cmdToken === '/channel_off' || newChan?.toLowerCase() === 'off') {
        await db.setSetting('force_sub_status', 'off', env);
        const channels = await db.getConnectedChats(env);
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            '⏸️ <b>Join Verification Paused</b>\n\n' +
            'Channels remain saved in your list. Users can now download directly without verification.',
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(channels)
        });
      }
      if (cmdToken === '/channel_on' || newChan?.toLowerCase() === 'on') {
        await db.setSetting('force_sub_status', 'on', env);
        const channels = await db.getConnectedChats(env);
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            '▶️ <b>Join Verification Active</b>\n\n' +
            'Join verification is now active for all connected channels.',
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(channels)
        });
      }
      if (!newChan) {
        const channels = await db.getConnectedChats(env);
        const chList = formatConnectedChatsList(channels);
        const forceSubStatus = await db.getSetting('force_sub_status', env, 'on');
        const statusTag = forceSubStatus === 'off' ? 'Paused' : 'Active';
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text:
            `💡 <b>Usage:</b> <code>/channel @username [Button Label]</code>\n\n` +
            `Example:\n<code>/channel @RHToolsOfficial Join RH Tools</code>\n\n` +
            `To pause:\n<code>/channel off</code>\n\n` +
            `To resume:\n<code>/channel on</code>\n\n` +
            `<b>Connected Chats (${channels.length}/3):</b>\n${chList}`,
          parse_mode: 'HTML',
          reply_markup: getAdminPanelKeyboard(channels)
        });
      }
      const res = await connectChatCore(token, env, newChan, '', customLabel);
      const channels = await db.getConnectedChats(env);
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: res.text,
        parse_mode: 'HTML',
        reply_markup: getAdminPanelKeyboard(channels)
      });
    }

    if (cmdToken === '/setup' || cmdToken === '/setcommands') {
      await syncBotCommandsAndProfile(token, env);
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '✅ <b>Bot Commands & Profile Synced!</b>\n\n<code>/start</code> and <code>/help</code> commands and Menu button are now registered with Telegram.',
        parse_mode: 'HTML',
        reply_markup: getMainAdminKeyboard()
      });
    }
  }

  const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';

  const helpText =
    '<b>How to Use:</b>\n\n' +
    '<blockquote>1. Copy any video or photo link from TikTok.\n' +
    '2. Send the link here.\n' +
    '3. Clean video is returned without watermark.</blockquote>\n\n' +
    'Supports TikTok videos, photos, and audio.';

  if (cmdToken === '/help') {
    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: helpText,
      parse_mode: 'HTML',
      reply_to_message_id: isGroup ? msg.message_id : undefined
    });
  }

  // Group /start handler: when admin adds bot to group or deep-links ?startgroup=true
  if (isGroup && cmdToken === '/start') {
    if (isAdminUser) {
      try {
        await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id });
      } catch {}

      const res = await connectChatCore(token, env, chatId, msg.chat.title || '');
      const channels = await db.getConnectedChats(env);
      return tgCall(token, 'sendMessage', {
        chat_id: userId,
        text: res.text,
        parse_mode: 'HTML',
        reply_markup: getAdminPanelKeyboard(channels)
      });
    }
    return;
  }

  // In Groups/Supergroups: ONLY respond when valid TikTok link(s) are detected!
  // Stay 100% silent for any other text, conversation, or non-TikTok links (FB, IG, YouTube, etc.)
  if (isGroup) {
    const allGroupTikTokUrls = extractAllTikTokUrls(text, 100);
    if (allGroupTikTokUrls.length === 0) {
      return; // Silently ignore all non-TikTok messages in groups
    }

    let groupTikTokUrls = allGroupTikTokUrls;
    if (allGroupTikTokUrls.length > 5) {
      groupTikTokUrls = allGroupTikTokUrls.slice(0, 5);
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '⚠️ <b>Max 5 links at once.</b>',
        parse_mode: 'HTML',
        reply_to_message_id: msg.message_id
      }).catch(() => {});
    }

    // Anti-Spam Flood Shield (budget checked for all links)
    const rateLimitResult = checkUserRateLimit(userId, groupTikTokUrls.length);
    if (rateLimitResult.blocked) {
      if (rateLimitResult.warning) {
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: rateLimitResult.warning,
          parse_mode: 'HTML',
          reply_to_message_id: msg.message_id,
          allow_sending_without_reply: true
        });
      }
      return;
    }

    // Force-Subscribe Verification Gate (Group support with group exemption)
    if (userId && userId !== adminId) {
      const isVerified = db.isUserVerifiedMemory(userId);
      if (!isVerified) {
        const currentChatId = chatId;
        const currentChatUname = msg.chat.username ? `@${msg.chat.username}` : null;
        const missing = await getUnjoinedChannels(token, userId, currentChatId, currentChatUname, env);

        if (missing.length === 0) {
          db.setUserVerifiedMemory(userId);
        } else {
          db.setPendingLink(userId, { url: groupTikTokUrls[0], chatId, replyToMsgId: msg.message_id });
          const { text: promptText, reply_markup: markup } = buildForceSubPrompt(missing);
          return tgCall(token, 'sendMessage', {
            chat_id: chatId,
            text: promptText,
            parse_mode: 'HTML',
            reply_markup: markup,
            reply_to_message_id: msg.message_id
          });
        }
      }
    }

    // Send 0% progress bar immediately for every link (No "In queue..." text!)
    const groupJobPromises = [];
    for (const singleUrl of groupTikTokUrls) {
      userActiveJobs.set(userId, (userActiveJobs.get(userId) || 0) + 1);

      let statusMsgId = null;
      try {
        const sm = await tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: '░░░░░░░░░░ <b>0%</b>',
          parse_mode: 'HTML',
          reply_to_message_id: msg.message_id
        });
        statusMsgId = sm?.result?.message_id || null;
      } catch {}

      const jobPromise = enqueueUserJob(userId, async () => {
        try {
          await processTikTokDownload(singleUrl, chatId, msg.from, token, env, ctx, statusMsgId, msg.message_id);
        } finally {
          const cur = (userActiveJobs.get(userId) || 1) - 1;
          if (cur <= 0) {
            userActiveJobs.delete(userId);
          } else {
            userActiveJobs.set(userId, cur);
          }
        }
      });

      groupJobPromises.push(jobPromise);
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(jobPromise);
      }
    }
    await Promise.all(groupJobPromises);
    return;
  }

  // /start command in private chat
  if (cmdToken === '/start') {
    if (msg.from) {
      await db.upsertUser({ id: userId, username: msg.from.username, firstName: msg.from.first_name }, env).catch(() => {});
    }
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(syncBotCommandsAndProfile(token, env).catch(() => {}));
    }
    const payloadPart = text.includes(' ') ? text.slice(text.indexOf(' ') + 1).trim() : '';
    if (payloadPart === 'verify') {
      const missing = await getUnjoinedChannels(token, userId, null, null, env);
      if (missing.length > 0) {
        const { text: promptText, reply_markup: markup } = buildForceSubPrompt(missing);
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: promptText,
          parse_mode: 'HTML',
          reply_markup: markup
        });
      } else {
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: '✅ <b>Verification Successful!</b>\n\n<blockquote>You have joined all connected channels. You can now download videos!</blockquote>',
          parse_mode: 'HTML'
        });
      }
    }
    if (payloadPart === 'guide') {
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: helpText,
        parse_mode: 'HTML'
      });
    }
    if (payloadPart === 'igfb') {
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '📸 <b>Instagram & Facebook Downloader</b>\n\n<blockquote>Please use @InstaFBDownloaderProBot to download Instagram and Facebook videos!</blockquote>',
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📸 Open Instagram & FB Downloader', url: 'https://t.me/InstaFBDownloaderProBot' }]
          ]
        }
      });
    }
    if (payloadPart === 'yt') {
      return tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '▶️ <b>YouTube Not Supported</b>\n\n<blockquote>This bot only downloads TikTok videos and photos. YouTube is not supported.</blockquote>',
        parse_mode: 'HTML'
      });
    }
    if (payloadPart.startsWith('dl_')) {
      let pendingUrl = inlinePendingDownloads.get(payloadPart) || (await db.getCachedShortLink(payloadPart, env));
      if (!pendingUrl) {
        const mVid = payloadPart.match(/^dl_(\d+)$/);
        const mVm = payloadPart.match(/^dl_vm_([a-zA-Z0-9_-]+)$/);
        const mVt = payloadPart.match(/^dl_vt_([a-zA-Z0-9_-]+)$/);
        const mT = payloadPart.match(/^dl_t_([a-zA-Z0-9_-]+)$/);
        const mU = payloadPart.match(/^dl_u_([a-zA-Z0-9_-]+)$/);
        if (mVid) {
          pendingUrl = `https://www.tiktok.com/@a/video/${mVid[1]}`;
        } else if (mVm) {
          pendingUrl = `https://vm.tiktok.com/${mVm[1]}/`;
        } else if (mVt) {
          pendingUrl = `https://vt.tiktok.com/${mVt[1]}/`;
        } else if (mT) {
          pendingUrl = `https://www.tiktok.com/t/${mT[1]}/`;
        } else if (mU) {
          try {
            const pad = mU[1].length % 4;
            const b64 = mU[1].replace(/-/g, '+').replace(/_/g, '/') + ('='.repeat((4 - pad) % 4));
            pendingUrl = atob(b64);
          } catch (e) {}
        }
      }
      if (pendingUrl) {
        text = pendingUrl;
      } else {
        return tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: '💡 <b>Download in Bot:</b>\n\n<blockquote>Please send or paste your TikTok link here to download.</blockquote>',
          parse_mode: 'HTML'
        });
      }
    } else {
      const deepTikTokUrl = payloadPart ? extractTikTokUrl(payloadPart) : null;
      if (!deepTikTokUrl) {
        const userName = msg.from?.first_name || 'there';
        const welcome =
          `👋 <b>Welcome, ${escapeHtml(userName)}!</b>\n\n` +
          `<blockquote>Download TikTok videos, photos, and audio with 100% high quality and without watermark.</blockquote>\n\n` +
          `Send any TikTok link to download.`;

        if (isAdminUser) {
          adminViewState.set(userId, 'MAIN');
          return tgCall(token, 'sendMessage', {
            chat_id: chatId,
            text: welcome,
            parse_mode: 'HTML',
            reply_markup: getMainAdminKeyboard()
          });
        } else {
          return tgCall(token, 'sendMessage', {
            chat_id: chatId,
            text: welcome,
            parse_mode: 'HTML'
          });
        }
      }
    }
  }

  // Smart URL Classifier & Cross-Platform Routing
  const IG_FB_REGEX = /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)*(?:instagram\.com|instagr\.am|facebook\.com|fb\.watch|fb\.gg|fb\.com)\/[^\s]+/i;
  const YT_REGEX = /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be)\/[^\s]+/i;
  const OTHER_REGEX = /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)*(?:x\.com|twitter\.com|pinterest\.com|pin\.it|reddit\.com|threads\.net)\/[^\s]+/i;

  if (IG_FB_REGEX.test(text)) {
    const isIg = /instagram\.com|instagr\.am/i.test(text);
    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: isIg ? '📸 Instagram not supported.' : '📘 Facebook not supported.',
      reply_markup: {
        inline_keyboard: [[{ text: '🎬 Insta & FB Downloader', url: 'https://t.me/InstaFBDownloaderProBot' }]]
      }
    });
  }

  if (YT_REGEX.test(text)) {
    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: '▶️ YouTube not supported.'
    });
  }

  if (OTHER_REGEX.test(text)) {
    return tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: '⚠️ Platform not supported.'
    });
  }

  // Detect TikTok links (up to 5 links per message)
  const allTiktokUrls = extractAllTikTokUrls(text, 100);
  if (allTiktokUrls.length === 0) {
    if (msg.via_bot) return;
    if (msg.chat?.type === "private" && !text.startsWith("/")) {
      const anyUrl = /https?:\/\/[^\s]+/i.test(text);
      if (anyUrl) {
        return tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ Invalid video link."
        });
      } else {
        return tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "🔗 Send a TikTok link."
        });
      }
    }
    return;
  }

  let tiktokUrls = allTiktokUrls;
  if (allTiktokUrls.length > 5) {
    tiktokUrls = allTiktokUrls.slice(0, 5);
    await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: '⚠️ <b>Max 5 links at once.</b>',
      parse_mode: 'HTML',
      reply_to_message_id: msg.message_id
    }).catch(() => {});
  }

  // Anti-Spam Flood Shield (budget checked for all links)
  const rateLimitResult = checkUserRateLimit(userId, tiktokUrls.length);
  if (rateLimitResult.blocked) {
    if (rateLimitResult.warning) {
      return tgCall(token, "sendMessage", {
        chat_id: chatId,
        text: rateLimitResult.warning,
        parse_mode: "HTML",
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
      });
    }
    return;
  }

  if (isAdminUser) {
    adminViewState.set(userId, "MAIN");
  }

  // Force-Subscribe Verification Gate (Shows only unjoined channels)
  if (userId && userId !== adminId) {
    const isVerified = db.isUserVerifiedMemory(userId);
    if (!isVerified) {
      const currentChatId = isGroup ? chatId : null;
      const currentChatUname = isGroup && msg.chat.username ? `@${msg.chat.username}` : null;
      const missing = await getUnjoinedChannels(token, userId, currentChatId, currentChatUname, env);

      if (missing.length === 0) {
        db.setUserVerifiedMemory(userId);
      } else {
        db.setPendingLink(userId, { url: tiktokUrls[0], chatId, replyToMsgId: msg.message_id });
        const { text: promptText, reply_markup: markup } = buildForceSubPrompt(missing);
        return tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: promptText,
          parse_mode: "HTML",
          reply_markup: markup,
          reply_to_message_id: msg.message_id
        });
      }
    }
  }

  // Send 0% progress bar immediately for each link (No "In queue..." text!)
  const privateJobPromises = [];
  for (const singleUrl of tiktokUrls) {
    userActiveJobs.set(userId, (userActiveJobs.get(userId) || 0) + 1);
    let statusMsgId = null;
    try {
      const sm = await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '░░░░░░░░░░ <b>0%</b>',
        parse_mode: 'HTML',
        reply_to_message_id: msg.message_id
      });
      statusMsgId = sm?.result?.message_id || null;
    } catch {}

    const jobPromise = enqueueUserJob(userId, async () => {
      try {
        await processTikTokDownload(singleUrl, chatId, msg.from, token, env, ctx, statusMsgId, msg.message_id);
      } finally {
        const cur = (userActiveJobs.get(userId) || 1) - 1;
        if (cur <= 0) {
          userActiveJobs.delete(userId);
        } else {
          userActiveJobs.set(userId, cur);
        }
      }
    });

    privateJobPromises.push(jobPromise);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(jobPromise);
    }
  }

  await Promise.all(privateJobPromises);
}


export function isGenericMusicTitle(str) {
  if (!str) return true;
  const s = String(str).trim().toLowerCase();
  return (
    s === "original sound" ||
    s === "original audio" ||
    s === "original" ||
    s.startsWith("original sound") ||
    s.startsWith("original audio") ||
    s.startsWith("sound -") ||
    s.startsWith("audio -")
  );
}

export function resolveMediaTitle(videoTitle, musicTitle, fallback = "TikTok Audio") {
  if (videoTitle && typeof videoTitle === "string") {
    const vt = videoTitle.trim();
    if (vt && !["tiktok video", "video", "tiktok photo"].includes(vt.toLowerCase())) {
      return vt;
    }
  }
  if (musicTitle && typeof musicTitle === "string" && !isGenericMusicTitle(musicTitle)) {
    return musicTitle.trim();
  }
  return fallback;
}

export function formatCaptionTitle(rawTitle, author = null, maxChars = 75) {
  if (!rawTitle) return '';
  let cleaned = String(rawTitle).trim();
  if (author) {
    const cleanAuthor = String(author).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const authorPattern = new RegExp(`^${cleanAuthor}[:\\s-]*`, 'i');
    cleaned = cleaned.replace(authorPattern, '').trim();
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.toLowerCase() === 'tiktok video' || cleaned.toLowerCase() === 'video' || cleaned.toLowerCase() === 'tiktok audio' || cleaned.toLowerCase() === 'audio' || isGenericMusicTitle(cleaned)) return '';
  if (cleaned.length > maxChars) {
    let cut = cleaned.slice(0, maxChars - 3);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace >= 25) cut = cut.slice(0, lastSpace);
    cleaned = `${cut}...`;
  }
  return cleaned;
}

export function buildMediaCaption(title, author, botTag) {
  const formatted = formatCaptionTitle(title, author, 75);
  if (formatted) {
    return {
      html: `<blockquote><b>${escapeHtml(formatted)}</b></blockquote>\n\n${botTag}`,
      plain: `${formatted}\n\n${botTag}`
    };
  }
  return {
    html: botTag,
    plain: botTag
  };
}

export class ProgressBarTracker {
  constructor(chatId, messageId, token) {
    this.chatId = chatId;
    this.messageId = messageId;
    this.token = token;
    this.lastUpdate = Date.now();
    this.lastText = '░░░░░░░░░░ <b>0%</b>';
    this.currentPct = 0;
  }

  async update(pct, force = false) {
    if (!this.messageId) return;
    const now = Date.now();
    pct = Math.max(0, Math.min(100, Math.floor(pct)));
    if (pct <= this.currentPct) return;
    if (!force && now - this.lastUpdate < 1000) return;

    this.currentPct = pct;
    const filled = Math.floor(pct / 10);
    const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
    const text = `${bar} <b>${pct}%</b>`;
    if (text === this.lastText) return;

    try {
      await tgCall(this.token, 'editMessageText', {
        chat_id: this.chatId,
        message_id: this.messageId,
        text,
        parse_mode: 'HTML'
      });
      this.lastUpdate = now;
      this.lastText = text;
    } catch {}
  }
}

/**
 * Core TikTok Download & Delivery Runner
 */
async function processTikTokDownload(tiktokUrl, chatId, fromUser, token, env, ctx, statusMsgId = null, replyToMsgId = null) {
  const botTag = await getBotTag(token);

  let activeStatusId = statusMsgId;
  if (!activeStatusId) {
    try {
      const sm = await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '░░░░░░░░░░ <b>0%</b>',
        parse_mode: 'HTML'
      });
      activeStatusId = sm?.result?.message_id || null;
    } catch {}
  }

  const tracker = new ProgressBarTracker(chatId, activeStatusId, token);

  // Fast L1/D1/Edge Cache check:
  // 1) Direct video/photo ID in URL, OR 2) Cached short-link mapping, OR 3) 1-hop 0.08s HEAD redirect resolution!
  const directMatch = tiktokUrl.match(/\/(?:video|photo|v|embed\/v2|share\/video)\/([0-9]+)/);
  let directId = directMatch ? directMatch[1] : await db.getCachedShortLink(tiktokUrl, env);

  if (!directId) {
    const fastHopId = await resolveShortLinkIdFast(tiktokUrl);
    if (fastHopId) {
      directId = fastHopId;
      bgTask(db.setCachedShortLink(tiktokUrl, fastHopId, env), ctx);
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
      await tracker.update(100, true);
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });
      const safeTitle = cached.title || 'TikTok Video';
      const sent = await sendVideoByIdOrUrl(
        token,
        chatId,
        cached.file_id,
        safeTitle,
        botTag,
        cached.video_id || directId,
        cached,
        replyToMsgId
      );
      if (sent?.ok) {
        if (activeStatusId) {
          await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: activeStatusId }).catch(() => {});
        }
        bgTask(
          db.incrementUserDownloads(fromUser?.id, env, {
            videoId: cached.video_id || directId,
            sourceUrl: tiktokUrl,
            mediaType: 'video',
            fromCache: true
          }),
          ctx
        );
        return;
      }
      // Self-heal: if Telegram invalidated cached file_id, purge it and proceed to fresh upload
      if (isStaleTelegramFileIdError(sent)) {
        bgTask(db.invalidateCachedMedia(directId, env, 'video'), ctx);
      }
    }

    // B) Cached Photo Album Instant Forward via Telegram photo file_id hashes
    if (cached && Array.isArray(cached.photo_file_ids) && cached.photo_file_ids.length > 0) {
      await tracker.update(100, true);
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_photo' });
      const safeTitle = cached.title || 'TikTok Photo';
      const cachedPhotoRes = await deliverPhotoPost(
        token,
        chatId,
        {
          id: cached.video_id || directId,
          images: cached.photo_file_ids,
          audioUrl: cached.audio_url || cached.audio_file_id
        },
        safeTitle,
        botTag,
        replyToMsgId
      );
      if (cachedPhotoRes?.delivered) {
        if (activeStatusId) {
          await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: activeStatusId }).catch(() => {});
        }
        bgTask(
          db.incrementUserDownloads(fromUser?.id, env, {
            videoId: cached.video_id || directId,
            sourceUrl: tiktokUrl,
            mediaType: 'photo',
            fromCache: true
          }),
          ctx
        );
        return;
      }
      bgTask(db.invalidateCachedMedia(directId, env, 'photo'), ctx);
    }
  }

  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_video' });

  let releaseInFlight = null;
  if (directId && !inFlightVideoJobs.has(directId)) {
    const lockPromise = new Promise((resolve) => {
      releaseInFlight = resolve;
    });
    inFlightVideoJobs.set(directId, lockPromise);
  }

  try {
    await tracker.update(20, true);
    const data = await extractTikTokData(tiktokUrl);

    if (!data || (!data.videoUrl && !(data.isPhoto && data.images?.length))) {
      if (activeStatusId) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: activeStatusId,
          text: '🗑️ Video not found or deleted.',
          parse_mode: 'HTML'
        });
      }
      return;
    }

    if (data.id) {
      bgTask(db.setCachedShortLink(tiktokUrl, data.id, env), ctx);
      bgTask(db.setCachedShortLink(`https://www.tiktok.com/@a/video/${data.id}`, data.id, env), ctx);
    }

    const safeTitle = data.title || 'TikTok Video';

    // Check resolved video ID cache (in case short-link HEAD hop didn't resolve ID earlier)
    if (data.id) {
      const cached = await db.getCachedVideo(data.id, env);
      if (cached && cached.file_id) {
        await tracker.update(100, true);
        const cachedSent = await sendVideoByIdOrUrl(
          token,
          chatId,
          cached.file_id,
          safeTitle,
          botTag,
          data.id,
          cached,
          replyToMsgId
        );
        if (cachedSent?.ok) {
          if (activeStatusId) {
            await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: activeStatusId }).catch(() => {});
          }
          bgTask(
            db.incrementUserDownloads(fromUser?.id, env, {
              videoId: data.id,
              sourceUrl: tiktokUrl,
              mediaType: 'video',
              fromCache: true
            }),
            ctx
          );
          return;
        }
        if (isStaleTelegramFileIdError(cachedSent)) {
          bgTask(db.invalidateCachedMedia(data.id, env, 'video'), ctx);
        }
      }
    }

    await tracker.update(40, true);

    // Handle TikTok Photo / Slideshow Carousels + Cache returned Telegram Photo file_id hashes!
    if (data.isPhoto && Array.isArray(data.images) && data.images.length > 0) {
      await tracker.update(100, true);
      await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_photo' });
      const photoRes = await deliverPhotoPost(token, chatId, data, safeTitle, botTag, replyToMsgId);
      if (photoRes?.delivered) {
        if (activeStatusId) {
          await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: activeStatusId }).catch(() => {});
        }
        if (data.id) {
          bgTask(
            db.setCachedVideo(data.id, data.title, '', env, {
              photoFileIds: photoRes.photoFileIds,
              audioUrl: data.audioUrl,
              musicTitle: data.musicTitle
            }),
            ctx
          );
        }
        bgTask(
          db.incrementUserDownloads(fromUser?.id, env, {
            videoId: data.id || directId,
            sourceUrl: tiktokUrl,
            mediaType: 'photo',
            fromCache: false
          }),
          ctx
        );
        return;
      }
      throw new Error('Failed to deliver TikTok photo post');
    }

    // Deliver Video: Stage 1 (Fast CDN Hotlink <=19MB) -> Stage 2 (Worker Binary Upload to Telegram <=49MB + Document Fallback) -> Stage 3 (Fresh Engine Re-Extract)
    await tracker.update(50, true);
    const delivery = await deliverVideoWithFallbacks(token, chatId, data, safeTitle, botTag, tiktokUrl, tracker, replyToMsgId);

    if (delivery?.sent?.ok) {
      await tracker.update(100, true);
      if (activeStatusId) {
        await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: activeStatusId }).catch(() => {});
      }
      const mediaObj = delivery.sent.result?.video || delivery.sent.result?.document;
      const tgFileId = mediaObj?.file_id;
      const tgUniqueId = mediaObj?.file_unique_id;
      const finalId = data.id || delivery.meta?.id || directId;

      if (finalId) {
        bgTask(db.setCachedShortLink(tiktokUrl, finalId, env), ctx);
        bgTask(
          db.setCachedVideo(finalId, data.title, tgFileId || '', env, {
            fileUniqueId: tgUniqueId,
            audioUrl: data.audioUrl || delivery.meta?.audioUrl,
            musicTitle: data.musicTitle || delivery.meta?.musicTitle,
            width: delivery.meta?.width || data.width,
            height: delivery.meta?.height || data.height,
            duration: delivery.meta?.duration || data.duration
          }),
          ctx
        );
      }

      bgTask(
        db.incrementUserDownloads(fromUser?.id, env, {
          videoId: finalId,
          sourceUrl: tiktokUrl,
          mediaType: 'video',
          fromCache: false
        }),
        ctx
      );
    } else if (delivery?.tooLarge) {
      const dlUrl = data.hdUrl || data.videoUrl || data.fallbackUrl;
      const buttons = [];
      if (dlUrl) {
        buttons.push([{ text: '⬇️ Download Video', url: dlUrl }]);
      }
      if (data.audioUrl) {
        buttons.push([{ text: '🎵 Download Audio', url: data.audioUrl }]);
      }
      if (activeStatusId) {
        await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: activeStatusId }).catch(() => {});
      }
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '<b>File is larger than 50MB</b>\n\n<blockquote>Please download directly below:</blockquote>',
        parse_mode: 'HTML',
        reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
        ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {})
      });
      return;
    } else {
      throw new Error(delivery?.sent?.description || 'All video delivery tiers failed');
    }
  } catch (err) {
    console.error('TikTok delivery error:', err);
    const rawErr = String(err?.message || '');
    const lowErr = rawErr.toLowerCase();

    let failText = '⚠️ Server error, please try again.';
    let errType = 'ServerError';

    if (lowErr.includes('not found') || lowErr.includes('deleted') || lowErr.includes('404')) {
      failText = '🗑️ Video not found or deleted.';
      errType = 'NotFound';
    } else if (lowErr.includes('private') || lowErr.includes('restricted') || lowErr.includes('login') || lowErr.includes('empty media response')) {
      failText = '🔒 Video is private, age-restricted, or requires login.';
      errType = 'PrivateRestricted';
    } else if (lowErr.includes('unsupported link') || lowErr.includes('invalid link')) {
      failText = '⚠️ Unsupported link format.';
      errType = 'UnsupportedLink';
    }

    if (activeStatusId) {
      await tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: activeStatusId,
        text: failText,
        parse_mode: 'HTML'
      }).catch(() => {});
    } else {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: failText,
        parse_mode: 'HTML'
      }).catch(() => {});
    }

    // Persist error to DB for Admin Activity / Logs
    bgTask(db.logServerError({
      userId: fromUser?.id || chatId,
      username: fromUser?.username ? `@${fromUser.username}` : (fromUser?.first_name || ''),
      url: tiktokUrl,
      errorType: errType,
      errorMessage: rawErr,
      platform: 'TikTok'
    }, env), ctx);

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
async function deliverVideoWithFallbacks(token, chatId, data, safeTitle, botTag, originalUrl, tracker = null, replyToMsgId = null) {
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
      sent = await sendVideoByIdOrUrl(token, chatId, candidateUrl, safeTitle, botTag, data.id, data, replyToMsgId);
      if (sent?.ok) {
        if (tracker) await tracker.update(100, true);
        return { sent, meta: data, tooLarge: false };
      }
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

  let cachedThumbBlob = undefined;
  const ensureThumbBlob = async (thumbUrl, cookies) => {
    if (cachedThumbBlob !== undefined) return cachedThumbBlob;
    cachedThumbBlob = await fetchThumbnailBlob(thumbUrl || data.thumbnail, cookies || data.cookies);
    return cachedThumbBlob;
  };

  for (const streamUrl of binaryCandidates) {
    if (tracker) await tracker.update(70, false);
    const [media, thumbBlob] = await Promise.all([
      fetchMediaStream(streamUrl, 'video/mp4', MIN_VIDEO_BYTES, data.cookies),
      ensureThumbBlob(data.thumbnail, data.cookies)
    ]);
    if (media?.tooLarge) {
      sawTooLarge = true;
      continue;
    }
    if (!media?.blob) continue;

    if (tracker) await tracker.update(90, false);
    const enrichedMeta = {
      ...data,
      width: data.width || media.dims?.width,
      height: data.height || media.dims?.height,
      thumbBlob
    };

    sent = await uploadVideoMultipart(token, chatId, media.blob, safeTitle, botTag, data.id, enrichedMeta, replyToMsgId);
    if (sent?.ok) {
      if (tracker) await tracker.update(100, true);
      return { sent, meta: enrichedMeta, tooLarge: false };
    }
  }

  // Stage 3: Self-healing fallback if primary engine's CDN links failed, pull fresh signed stream from backup engines
  if (originalUrl && data.source !== 'tiktok_direct') {
    if (tracker) await tracker.update(90, false);
    const directData = await extractFromTikTokDirect(originalUrl);
    if (directData?.videoUrl) {
      const [media, thumbBlob] = await Promise.all([
        fetchMediaStream(directData.videoUrl, 'video/mp4', MIN_VIDEO_BYTES, directData.cookies),
        fetchThumbnailBlob(directData.thumbnail || data.thumbnail, directData.cookies)
      ]);
      if (media?.tooLarge) sawTooLarge = true;
      if (media?.blob) {
        if (!data.audioUrl && directData.audioUrl) data.audioUrl = directData.audioUrl;
        if (!data.id && directData.id) data.id = directData.id;
        const enrichedMeta = {
          ...directData,
          width: directData.width || media.dims?.width,
          height: directData.height || media.dims?.height,
          thumbBlob
        };
        sent = await uploadVideoMultipart(
          token,
          chatId,
          media.blob,
          safeTitle,
          botTag,
          data.id || directData.id,
          enrichedMeta,
          replyToMsgId
        );
        if (sent?.ok) {
          if (tracker) await tracker.update(100, true);
          return { sent, meta: enrichedMeta, tooLarge: false };
        }
      }
    }
  }

  if (originalUrl && data.source !== 'tikmate') {
    if (tracker) await tracker.update(90, false);
    const tmData = await extractFromTikMate(originalUrl);
    if (tmData) {
      for (const tmUrl of uniqueStrings([tmData.videoUrl, tmData.hdUrl])) {
        const [media, thumbBlob] = await Promise.all([
          fetchMediaStream(tmUrl, 'video/mp4', MIN_VIDEO_BYTES),
          fetchThumbnailBlob(tmData.thumbnail || data.thumbnail)
        ]);
        if (media?.tooLarge) sawTooLarge = true;
        if (media?.blob) {
          if (!data.id && tmData.id) data.id = tmData.id;
          const enrichedMeta = {
            ...tmData,
            width: tmData.width || media.dims?.width,
            height: tmData.height || media.dims?.height,
            thumbBlob
          };
          sent = await uploadVideoMultipart(
            token,
            chatId,
            media.blob,
            safeTitle,
            botTag,
            data.id || tmData.id,
            enrichedMeta,
            replyToMsgId
          );
          if (sent?.ok) {
            if (tracker) await tracker.update(100, true);
            return { sent, meta: enrichedMeta, tooLarge: false };
          }
        }
      }
    }
  }

  return { sent, meta: data, tooLarge: sawTooLarge };
}

async function sendVideoByIdOrUrl(token, chatId, videoRef, safeTitle, botTag, videoId, meta = {}, replyToMsgId = null) {
  const { html: htmlCaption, plain: plainCaption } = buildMediaCaption(safeTitle, meta.author || meta.authorHandle, botTag);
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
    ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
    ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {})
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

async function uploadVideoMultipart(token, chatId, videoBlob, safeTitle, botTag, videoId, meta = {}, replyToMsgId = null) {
  const { html: htmlCaption, plain: plainCaption } = buildMediaCaption(safeTitle, meta.author || meta.authorHandle, botTag);
  const replyMarkup = videoId
    ? JSON.stringify({ inline_keyboard: [[{ text: '🎵 Download Audio', callback_data: `audio_${videoId}` }]] })
    : null;
  const thumbBlob = meta.thumbBlob || (meta.thumbnail ? await fetchThumbnailBlob(meta.thumbnail, meta.cookies) : null);

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
      if (thumbBlob) fd.append('thumbnail', thumbBlob, 'thumb.jpg');
    }
    if (replyMarkup) fd.append('reply_markup', replyMarkup);
    if (replyToMsgId) {
      fd.append('reply_to_message_id', String(replyToMsgId));
      fd.append('allow_sending_without_reply', 'true');
    }
    return fd;
  };

  let sent = await tgCallMultipart(token, 'sendVideo', buildForm('video', htmlCaption, true));
  if (!sent?.ok && sent?.description && sent.description.includes('parse')) {
    sent = await tgCallMultipart(token, 'sendVideo', buildForm('video', plainCaption, false));
  }

  if (!sent?.ok && !/too large|Entity Too Large|413/i.test(String(sent?.description || ''))) {
    sent = await tgCallMultipart(token, 'sendDocument', buildForm('document', plainCaption, false));
  }
  return sent;
}

/**
 * Deliver TikTok Photo / Slideshow Carousel Posts + extract Telegram photo file_id hashes for instant caching!
 */
async function deliverPhotoPost(token, chatId, data, safeTitle, botTag, replyToMsgId = null) {
  const images = data.images.filter(Boolean);
  if (images.length === 0) return { delivered: false, photoFileIds: [] };

  const { html: htmlCaption, plain: plainCaption } = buildMediaCaption(safeTitle, data.author, botTag);
  
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
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {})
    });

    if (!sent?.ok && /^https?:\/\//i.test(images[0])) {
      const imgBlob = await fetchMediaBlob(images[0], 'image/jpeg', MIN_IMAGE_BYTES, data.cookies);
      if (imgBlob) {
        const fd = new FormData();
        fd.append('chat_id', String(chatId));
        fd.append('photo', imgBlob, 'photo.jpg');
        fd.append('caption', plainCaption);
        if (inlineKeyboard) fd.append('reply_markup', JSON.stringify({ inline_keyboard: inlineKeyboard }));
        if (replyToMsgId) {
          fd.append('reply_to_message_id', String(replyToMsgId));
          fd.append('allow_sending_without_reply', 'true');
        }
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
      media: mediaPayload,
      ...(replyToMsgId ? { reply_to_message_id: replyToMsgId, allow_sending_without_reply: true } : {})
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
        if (replyToMsgId) {
          fd.append('reply_to_message_id', String(replyToMsgId));
          fd.append('allow_sending_without_reply', 'true');
        }
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
 * Handle Callbacks (Audio extraction + Force-sub verification)
 */
async function handleCallback(cb, token, env = {}, ctx = null) {
  const botTag = await getBotTag(token);
  const data = cb.data;
  if (!data) return;
  if (data.startsWith('fsub_add:') || data.startsWith('fsub_skip:')) {
    const { adminId } = getBotConfig(env);
    const userId = cb.from?.id;
    const isAdmin = userId && (userId === adminId || String(userId) === String(adminId));
    if (!isAdmin) {
      return tgCall(token, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'Admins only',
        show_alert: true
      });
    }
    const [action, cid] = data.split(':');
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;

    if (action === 'fsub_skip') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Skipped' });
      let title = cid;
      try {
        const ch = await tgCall(token, 'getChat', { chat_id: cid });
        if (ch?.ok && ch.result) {
          title = ch.result.title || (ch.result.username ? `@${ch.result.username}` : cid);
        }
      } catch {}
      return tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `✖️ <b>Skipped:</b> ${escapeHtml(title)}\n\n<blockquote>Not used for Join Verification.</blockquote>`,
        parse_mode: 'HTML'
      });
    }

    // fsub_add:
    await tgCall(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Verifying...' });
    const res = await connectChatCore(token, env, cid);
    const channels = await db.getConnectedChats(env);
    return tgCall(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: res.text,
      parse_mode: 'HTML',
      reply_markup: res.ok ? getAdminPanelKeyboard(channels) : null
    });
  }

  if (data === 'verify_sub' || data === 'check_sub') {
    const userId = cb.from?.id;
    const chat = cb.message?.chat;
    const chatId = chat?.id;
    const isGroupMsg = chat && ['group', 'supergroup'].includes(chat.type);

    const pendingInfo = db.getPendingLink(userId);

    // In groups, prevent other members from clicking someone else's verification prompt
    if (isGroupMsg && pendingInfo && pendingInfo.chatId && pendingInfo.chatId !== chatId) {
      return tgCall(token, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'ℹ️ This verification is for the user who requested the download.',
        show_alert: true
      });
    }

    const currentChatId = chat ? chat.id : null;
    const currentChatUname = chat?.username ? `@${chat.username}` : null;
    const missing = await getUnjoinedChannels(token, userId, currentChatId, currentChatUname, env);

    if (missing.length > 0) {
      const { text: promptText, reply_markup: markup } = buildForceSubPrompt(missing);
      if (cb.message?.message_id) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: promptText,
          parse_mode: 'HTML',
          reply_markup: markup
        }).catch(() => {});
      }
      return tgCall(token, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'ℹ️ Join channel first',
        show_alert: true
      });
    }

    db.setUserVerifiedMemory(userId);
    await tgCall(token, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text: 'Verified!'
    });

    const pendingUrl = typeof pendingInfo === 'string' ? pendingInfo : pendingInfo?.url;
    const pendingReplyId = typeof pendingInfo === 'object' ? pendingInfo?.replyToMsgId : null;
    db.clearPendingLink(userId);

    if (pendingUrl) {
      if (cb.message?.message_id) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: '░░░░░░░░░░ <b>0%</b>',
          parse_mode: 'HTML'
        }).catch(() => {});
      }
      return processTikTokDownload(pendingUrl, chatId, cb.from, token, env, ctx, cb.message?.message_id, pendingReplyId);
    } else {
      if (cb.message?.message_id) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: '✅ Verified! Send a link to download.',
          parse_mode: 'HTML'
        }).catch(() => {});
      }
      return;
    }
  }

  if (!data.startsWith('audio_')) return;

  const videoId = data.replace('audio_', '');
  // 1. Silent answerCallbackQuery (NO toast popup)
  await tgCall(token, 'answerCallbackQuery', { callback_query_id: cb.id });

  const chatId = cb.message?.chat?.id;
  if (!chatId) return;

  // 2. Send 0% Progress Bar Status Message immediately
  let audioStatusId = null;
  try {
    const sm = await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text: '░░░░░░░░░░ <b>0%</b>',
      parse_mode: 'HTML'
    });
    audioStatusId = sm?.result?.message_id || null;
  } catch {}

  const tracker = new ProgressBarTracker(chatId, audioStatusId, token);
  await tgCall(token, 'sendChatAction', { chat_id: chatId, action: 'upload_document' });

  if (inFlightAudioJobs.has(videoId)) {
    await inFlightAudioJobs.get(videoId).catch(() => {});
  }

  let releaseAudioLock = null;

  try {
    // 3. Instant delivery if audio_file_id hash is already cached
    const cached = await db.getCachedVideo(videoId, env);
    if (cached && cached.audio_file_id) {
      await tracker.update(100, true);
      const effectiveTitle = resolveMediaTitle(cached.title, cached.music_title, 'TikTok Audio');
      const effectiveAuthor = cached.author || cached.author_handle || null;
      const cleanTitle = safeUnicodeSlice(formatCaptionTitle(effectiveTitle, effectiveAuthor, 50) || effectiveTitle, 50) || 'TikTok Audio';
      const { html: safeCaption } = buildMediaCaption(effectiveTitle, effectiveAuthor, botTag);

      const cachedRes = await tgCall(token, 'sendAudio', {
        chat_id: chatId,
        audio: cached.audio_file_id,
        title: cleanTitle,
        performer: botTag,
        caption: safeCaption,
        parse_mode: 'HTML'
      });

      if (cachedRes?.ok) {
        if (audioStatusId) {
          await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: audioStatusId }).catch(() => {});
        }
        return;
      }

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

    // 4. Progress 50% while extracting fresh/candidate audio streams
    await tracker.update(50, true);
    let audioCandidates = [];
    let cookies = null;
    let displayTitle = cached?.title || '';
    let musicTitle = cached?.music_title || '';

    if (cached?.audio_url) {
      audioCandidates.push(cached.audio_url);
    }

    let meta = null;
    if (audioCandidates.length === 0) {
      meta = await extractTikTokData(`https://www.tiktok.com/@a/video/${videoId}`).catch(() => null);
      if (meta) {
        if (meta.audioUrl) audioCandidates.push(meta.audioUrl);
        cookies = meta.cookies || null;
        displayTitle = displayTitle || meta.title || '';
        musicTitle = musicTitle || meta.musicTitle || '';
      }
    }

    // Fallback: If no audioCandidates or cached URL failed, pull from Direct TikTok or TikMate
    if (audioCandidates.length === 0) {
      const dtData = await extractFromTikTokDirect(`https://www.tiktok.com/@a/video/${videoId}`).catch(() => null);
      if (dtData?.audioUrl) {
        audioCandidates.push(dtData.audioUrl);
        cookies = dtData.cookies || cookies;
        displayTitle = displayTitle || dtData.title || '';
        musicTitle = musicTitle || dtData.musicTitle || '';
      }
    }

    if (audioCandidates.length === 0) {
      const tmData = await extractFromTikMate(`https://www.tiktok.com/@a/video/${videoId}`).catch(() => null);
      if (tmData?.audioUrl) {
        audioCandidates.push(tmData.audioUrl);
        displayTitle = displayTitle || tmData.title || '';
        musicTitle = musicTitle || tmData.musicTitle || '';
      }
    }

    const effectiveTitle = resolveMediaTitle(cached?.title || displayTitle || meta?.title, musicTitle, 'TikTok Audio');
    const effectiveAuthor = meta?.author || meta?.authorHandle || cached?.author || null;
    const cleanTitle = safeUnicodeSlice(formatCaptionTitle(effectiveTitle, effectiveAuthor, 50) || effectiveTitle, 50) || 'TikTok Audio';
    const { html: htmlCaption, plain: plainCaption } = buildMediaCaption(effectiveTitle, effectiveAuthor, botTag);

    let sentAudio = null;

    // 5. Try candidate audio URLs
    for (const audioUrl of uniqueStrings(audioCandidates)) {
      await tracker.update(70, false);
      if (!cookies) {
        await tracker.update(100, true);
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

      // Worker Binary Fetch + Multipart FormData Upload fallback (for cookie-locked or hotlink-rejected audio)
      const audioBlob = await fetchMediaBlob(audioUrl, 'audio/mpeg', MIN_AUDIO_BYTES, cookies);
      if (audioBlob) {
        await tracker.update(100, true);
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

    // 6. If cached audio_url expired, fetch fresh stream once and upload
    if (!sentAudio?.ok && cached?.audio_url && !meta) {
      await tracker.update(70, false);
      meta = await extractTikTokData(`https://www.tiktok.com/@a/video/${videoId}`).catch(() => null);
      if (meta?.audioUrl) {
        const freshBlob = await fetchMediaBlob(meta.audioUrl, 'audio/mpeg', MIN_AUDIO_BYTES, meta.cookies);
        if (freshBlob) {
          await tracker.update(100, true);
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
      if (audioStatusId) {
        await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: audioStatusId }).catch(() => {});
      }
      const audioObj = sentAudio.result?.audio || sentAudio.result?.document;
      const audioFileId = audioObj?.file_id;
      const audioUniqueId = audioObj?.file_unique_id;
      if (audioFileId) {
        await db.setCachedAudio(videoId, audioFileId, env, cleanTitle, audioUniqueId);
      }
    } else {
      if (audioStatusId) {
        await tgCall(token, 'editMessageText', {
          chat_id: chatId,
          message_id: audioStatusId,
          text: '🎵 Audio not available for this video.',
          parse_mode: 'HTML'
        });
      } else {
        await tgCall(token, 'sendMessage', {
          chat_id: chatId,
          text: '🎵 Audio not available for this video.',
          parse_mode: 'HTML'
        });
      }
      await db.logServerError(
        cb.from?.id || 0,
        cb.from?.username ? `@${cb.from.username}` : 'User',
        `https://www.tiktok.com/@a/video/${videoId}`,
        'AudioExtractionError',
        `${cleanTitle} | Audio stream could not be resolved`,
        'Telegram Audio',
        env
      );
    }
  } catch (e) {
    console.error('Audio callback error:', e);
    if (audioStatusId) {
      await tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: audioStatusId,
        text: '🎵 Audio not available for this video.',
        parse_mode: 'HTML'
      });
    } else {
      await tgCall(token, 'sendMessage', {
        chat_id: chatId,
        text: '🎵 Audio not available for this video.',
        parse_mode: 'HTML'
      });
    }
    await db.logServerError(
      cb.from?.id || 0,
      cb.from?.username ? `@${cb.from.username}` : 'User',
      `https://www.tiktok.com/@a/video/${videoId}`,
      'AudioExtractionError',
      String(e.message || e).slice(0, 100),
      'Telegram Audio',
      env
    );
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
async function handleInlineQuery(iq, token, env = {}, ctx = null) {
  const rawQ = String(iq.query || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  const q = rawQ.trim();
  const userId = iq.from?.id;
  const { adminId } = getBotConfig(env);
  const botTag = await getBotTag(token);

  // 0. Instant response for empty query (0ms delay when user first types @bot)
  if (!q) {
    return tgCall(token, 'answerInlineQuery', {
      inline_query_id: iq.id,
      button: { text: '🔗 Paste TikTok link...', start_parameter: 'guide' },
      switch_pm_text: '🔗 Paste TikTok link...',
      switch_pm_parameter: 'guide',
      results: [],
      cache_time: 1,
      is_personal: true
    });
  }

  // 1. Force-Subscribe Verification Gate for Inline Queries (uses fast memory cache first)
  if (userId && userId !== adminId && !db.isUserVerifiedMemory(userId)) {
    const missing = await getUnjoinedChannels(token, userId, null, null, env);
    if (missing.length > 0) {
      return tgCall(token, 'answerInlineQuery', {
        inline_query_id: iq.id,
        button: { text: '🔒 Click to Join and Download Video', start_parameter: 'verify' },
        switch_pm_text: '🔒 Click to Join and Download Video',
        switch_pm_parameter: 'verify',
        results: [],
        cache_time: 1,
        is_personal: true
      });
    }
    db.setUserVerifiedMemory(userId);
  }

  // 2. Extract and Validate TikTok Link (All non-TikTok inputs show '🔗 Paste TikTok link...')
  const tiktokUrl = extractTikTokUrl(q);
  if (!tiktokUrl) {
    return tgCall(token, 'answerInlineQuery', {
      inline_query_id: iq.id,
      button: { text: '🔗 Paste TikTok link...', start_parameter: 'guide' },
      switch_pm_text: '🔗 Paste TikTok link...',
      switch_pm_parameter: 'guide',
      results: [],
      cache_time: 1,
      is_personal: true
    });
  }

  let cachedVidId = null;
  try {
    // 4. Fast Cache Check (Single-hop redirect, mapping, or direct video ID)
    const directMatch = tiktokUrl.match(/\/(?:video|photo|v|embed\/v2|share\/(?:video|photo)|post)\/([0-9]+)/i);
    cachedVidId = directMatch ? directMatch[1] : await db.getCachedShortLink(tiktokUrl, env);
    if (!cachedVidId) {
      cachedVidId = await resolveShortLinkIdFast(tiktokUrl, 1200);
      if (cachedVidId) {
        bgTask(db.setCachedShortLink(tiktokUrl, cachedVidId, env), ctx);
      }
    }

    if (cachedVidId) {
      const cached = await db.getCachedVideo(cachedVidId, env);
      if (cached?.file_id) {
        const { html: htmlCaption } = buildMediaCaption(cached.title, cached.author, botTag);
        return tgCall(token, 'answerInlineQuery', {
          inline_query_id: iq.id,
          results: [
            {
              type: 'video',
              id: String(cachedVidId),
              video_file_id: cached.file_id,
              title: '🎬 TikTok Video',
              description: 'Tap to share video',
              caption: htmlCaption,
              parse_mode: 'HTML'
            }
          ],
          cache_time: 300,
          is_personal: false
        });
      }
    }
  } catch (cacheErr) {
    console.warn('Inline cache lookup warning:', cacheErr?.message || cacheErr);
  }

  // 5. Uncached Link: Sleek 1-click blue bar to Process & Download Video in Bot
  let tokenKey = 'dl_' + Math.random().toString(36).slice(2, 14);
  if (cachedVidId && /^\d+$/.test(cachedVidId)) {
    tokenKey = `dl_${cachedVidId}`;
  } else {
    const vtMatch = tiktokUrl.match(/vt\.tiktok\.com\/([a-zA-Z0-9_-]+)/i);
    const vmMatch = tiktokUrl.match(/vm\.tiktok\.com\/([a-zA-Z0-9_-]+)/i);
    const tMatch = tiktokUrl.match(/tiktok\.com\/t\/([a-zA-Z0-9_-]+)/i);
    const vidMatch = tiktokUrl.match(/\/(?:video|photo|v|post)\/([0-9]+)/i);
    if (vidMatch) {
      tokenKey = `dl_${vidMatch[1]}`;
    } else if (vtMatch) {
      tokenKey = `dl_vt_${vtMatch[1]}`;
    } else if (vmMatch) {
      tokenKey = `dl_vm_${vmMatch[1]}`;
    } else if (tMatch) {
      tokenKey = `dl_t_${tMatch[1]}`;
    } else if (tiktokUrl.length <= 44) {
      try {
        const b64 = btoa(tiktokUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (b64.length <= 59) {
          tokenKey = `dl_u_${b64}`;
        }
      } catch (e) {}
    }
  }
  inlinePendingDownloads.set(tokenKey, tiktokUrl);
  bgTask(db.setCachedShortLink(tokenKey, tiktokUrl, env), ctx);

  return tgCall(token, 'answerInlineQuery', {
    inline_query_id: iq.id,
    button: { text: '🎬 Process & Download Video', start_parameter: tokenKey },
    switch_pm_text: '🎬 Process & Download Video',
    switch_pm_parameter: tokenKey,
    results: [],
    cache_time: 1,
    is_personal: true
  });
}

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
          thumbnail: normalizeTikwmUrl(d.cover || d.origin_cover || d.ai_dynamic_cover),
          width: Number(d.width || 0) || undefined,
          height: Number(d.height || 0) || undefined,
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
    let res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(9000)
    });

    if (!res.ok) return null;

    const extractCookies = (response) => {
      let cHdr = '';
      if (typeof response.headers.getSetCookie === 'function') {
        const list = response.headers.getSetCookie();
        if (Array.isArray(list) && list.length > 0) {
          cHdr = list.map((c) => c.split(';')[0]).join('; ');
        }
      }
      if (!cHdr) {
        const rawCookie = response.headers.get('set-cookie');
        if (rawCookie) {
          cHdr = rawCookie
            .split(/,(?=\s*[a-zA-Z0-9_-]+=)/)
            .map((c) => c.split(';')[0].trim())
            .join('; ');
        }
      }
      return cHdr;
    };

    let cookieHeader = extractCookies(res);
    let html = await res.text();
    let match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);

    // If short link redirected to a minimal stub page without rehydration script, re-fetch clean canonical URL
    if (!match) {
      const resolvedUrl = res.url || url;
      const vidMatch =
        resolvedUrl.match(/\/(?:video|photo|v|post)\/([0-9]+)/i) ||
        resolvedUrl.match(/[?&](?:item_id|share_item_id)=([0-9]+)/i) ||
        html.match(/\/(?:video|photo)\/([0-9]{15,22})/i);
      if (vidMatch) {
        const cleanUrl = `https://www.tiktok.com/@a/video/${vidMatch[1]}`;
        const res2 = await fetch(cleanUrl, {
          redirect: 'follow',
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          },
          signal: AbortSignal.timeout(8000)
        });
        if (res2.ok) {
          const c2 = extractCookies(res2);
          if (c2) cookieHeader = cookieHeader ? `${cookieHeader}; ${c2}` : c2;
          html = await res2.text();
          match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
        }
      }
    }

    if (!match) return null;

    const effectiveCookies = cookieHeader || 'ttwid=1; tt_csrf_token=1';

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
          cookies: effectiveCookies,
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
      thumbnail: item.video?.zoomCover?.['240'] || item.video?.zoomCover?.['480'] || item.video?.cover || item.video?.originCover || null,
      width: Number(item.video?.width || 0) || undefined,
      height: Number(item.video?.height || 0) || undefined,
      duration: Number(item.video?.duration || 0) || undefined,
      sizeBytes: bestSize,
      cookies: effectiveCookies,
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
 * Fetch a Telegram-compliant JPEG thumbnail (< 200KB, <= 320px width & height)
 * Required by Telegram Bot API when uploading videos via multipart/form-data so InlineQueryResultCachedVideo displays a preview image!
 */
async function fetchThumbnailBlob(thumbUrl, cookies = null) {
  if (!thumbUrl || typeof thumbUrl !== 'string' || !thumbUrl.startsWith('http')) return null;

  // 1. Primary: Resize & transcode to 240x320 JPEG (< 200KB) via wsrv.nl edge proxy (handles WebP/HEIC/large covers)
  try {
    const proxyUrl = `https://wsrv.nl/?url=${encodeURIComponent(thumbUrl)}&w=240&h=320&fit=cover&output=jpg&q=80`;
    const res = await fetch(proxyUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'image/jpeg,*/*' },
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (buf.byteLength >= 500 && buf.byteLength <= 200000 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        return new Blob([buf], { type: 'image/jpeg' });
      }
    }
  } catch {}

  // 2. Fallback: Direct fetch if origin already serves a small JPEG (< 200KB)
  try {
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept': 'image/jpeg,*/*',
      'Referer': 'https://www.tiktok.com/'
    };
    if (cookies) headers['Cookie'] = cookies;
    const res2 = await fetch(thumbUrl, {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(3500)
    });
    if (res2.ok) {
      const buf2 = await res2.arrayBuffer();
      const bytes2 = new Uint8Array(buf2);
      if (buf2.byteLength >= 500 && buf2.byteLength <= 200000 && bytes2[0] === 0xff && bytes2[1] === 0xd8) {
        return new Blob([buf2], { type: 'image/jpeg' });
      }
    }
  } catch {}

  return null;
}

/**
 * URL Extractor, Validator & Sanitizer
 * Supports schemeless links (vt.tiktok.com/...), strips attached emojis/punctuation, and rejects non-media profile/discover pages
 */
export function extractAllTikTokUrls(text, limit = 1) {
  if (!text || typeof text !== "string") return [];
  const cleaned = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "");
  const regex = /(?:https?:\/\/|(?:^|[\s(])(?=(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/))(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[a-zA-Z0-9_./?=&%@#+-]+/gi;
  const matches = cleaned.match(regex);
  if (!matches) return [];

  const found = [];
  const seen = new Set();
  for (const m of matches) {
    const single = extractTikTokUrl(m);
    if (single && !seen.has(single)) {
      seen.add(single);
      found.push(single);
      if (found.length >= limit) break;
    }
  }
  return found;
}

function extractTikTokUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');

  // Match full https://...tiktok.com/... OR schemeless (vt|vm|www|m).tiktok.com/...
  const match = cleaned.match(
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

    // Standard tiktok.com hosts: accept video, photo, post, /t/<code>, /v/<id>, /embed/..., /share/video|photo/...
    const isMediaPath =
      /\/(?:video|photo|post)\/[0-9]+/i.test(path) ||
      /^\/t\/[a-zA-Z0-9_-]+/i.test(path) ||
      /^\/v\/[0-9]+/i.test(path) ||
      /\/embed\/(?:v2\/)?[0-9]+/i.test(path) ||
      /\/share\/(?:video|photo)\/[0-9]+/i.test(path);

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
