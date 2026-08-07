const config = require('./config');
const { listInboxMessages, mailAddress, uploadMailInlineImages } = require('./mail');
const { readJson, writeJson, appendLog } = require('./store');
const { getNotifyTarget, sendText, sendCard } = require('./feishuMessages');
const { buildMailNoticeCards } = require('./cards');

function parseMailDate(value) {
  if (!value) return new Date(NaN);
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const text = String(value);
  if (/^\d+$/.test(text)) return new Date(Number.parseInt(text, 10));
  return new Date(text);
}

function sameLocalDate(dateString, now = new Date()) {
  const date = parseMailDate(dateString);
  if (Number.isNaN(date.getTime())) return false;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date) === new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function textOf(message) {
  return [
    message.subject,
    mailAddress(message.head_from),
    message.body_preview,
    message.body_plain_text,
  ].filter(Boolean).join('\n');
}

function scoreMessage(message, keywordConfig = {}) {
  const text = textOf(message);
  let score = 0;
  const hits = [];
  const actionKeywords = keywordConfig.actionKeywords?.length ? keywordConfig.actionKeywords : config.actionKeywords;
  const noiseKeywords = keywordConfig.noiseKeywords?.length ? keywordConfig.noiseKeywords : config.noiseKeywords;
  const hasCustomActionKeywords = Boolean(keywordConfig.actionKeywords?.length);

  for (const keyword of actionKeywords) {
    if (text.includes(keyword)) {
      score += hasCustomActionKeywords || keyword.includes('谭总') || keyword.includes('审批') ? 2 : 1;
      hits.push(keyword);
    }
  }
  for (const keyword of noiseKeywords) {
    if (text.includes(keyword)) {
      score -= 2;
    }
  }
  if (/请.{0,8}(审批|确认|处理|同意|批准)/.test(text)) score += 2;
  if (/(申请|续期|开通|授权)/.test(message.subject || '')) score += 1;

  return { score, hits: [...new Set(hits)] };
}

function nextMailCode(state) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replaceAll('-', '');
  state.sequence = state.sequence || {};
  state.sequence[date] = (state.sequence[date] || 0) + 1;
  return `M${date}-${String(state.sequence[date]).padStart(3, '0')}`;
}

function formatMailTime(dateString) {
  const date = parseMailDate(dateString);
  if (Number.isNaN(date.getTime())) return { sentAt: '未知', age: '未知' };
  const sentAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  const diffMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 60) return { sentAt, age: `${diffMinutes} 分钟` };
  const diffHours = Math.floor(diffMinutes / 60);
  const restMinutes = diffMinutes % 60;
  if (diffHours < 24) return { sentAt, age: restMinutes ? `${diffHours} 小时 ${restMinutes} 分钟` : `${diffHours} 小时` };
  const diffDays = Math.floor(diffHours / 24);
  return { sentAt, age: `${diffDays} 天 ${diffHours % 24} 小时` };
}

function localDateKey(dateString) {
  const date = parseMailDate(dateString);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function todayProcessedCount(state, ownerKey, mailboxId) {
  const today = localDateKey(new Date().toISOString());
  return Object.values(state.mailRecords || {}).filter((record) => {
    if (ownerKey && record.ownerKey !== ownerKey) return false;
    if (mailboxId && record.mailboxId !== mailboxId) return false;
    if (!['replied', 'ignored'].includes(record.status)) return false;
    const handledAt = record.repliedAt || record.ignoredAt;
    return localDateKey(handledAt) === today;
  }).length;
}

function todayPendingCount(state, ownerKey, mailboxId) {
  const today = localDateKey(new Date().toISOString());
  return Object.values(state.mailRecords || {}).filter((record) => {
    if (ownerKey && record.ownerKey !== ownerKey) return false;
    if (mailboxId && record.mailboxId !== mailboxId) return false;
    if (record.status !== 'pending') return false;
    return localDateKey(record.message?.internal_date || record.createdAt) === today;
  }).length;
}

function formatMailBody(message) {
  const rawBody = message.body_plain_text || message.body_preview || '';
  const body = rawBody
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!body) return '(无正文内容)';

  const maxLength = 12000;
  if (body.length <= maxLength) return body;
  return [
    body.slice(0, maxLength),
    '',
    `（正文较长，已显示前 ${maxLength} 字，后面还有 ${body.length - maxLength} 字未显示）`,
  ].join('\n');
}

function buildNotice(code, message) {
  const timeInfo = formatMailTime(message.internal_date);
  const body = formatMailBody(message);
  return [
    `发现一封可能需要你处理的邮件：${code}`,
    `发送时间：${timeInfo.sentAt}（已过 ${timeInfo.age}）`,
    `发件人：${mailAddress(message.head_from)}`,
    `主题：${message.subject || '(无主题)'}`,
    '',
    '正文全文：',
    body,
    '',
    '你可以直接回复：',
    '回复 你的邮件内容',
    '回复全部 你的邮件内容',
    '忽略',
    '',
    '也支持换行，例如：',
    '回复全部',
    '同意开通',
  ].join('\n');
}

async function scanOnce({ notify = true, mailboxId, target, ownerKey, useUserToken = false } = {}) {
  const state = readJson('state.json', {});
  state.mailRecords = state.mailRecords || {};
  state.notifiedMessageIds = state.notifiedMessageIds || {};
  const notifyTarget = notify ? (target || getNotifyTarget()) : null;
  const binding = ownerKey ? state.userBindings?.[ownerKey] : null;
  const keywordConfig = {
    actionKeywords: binding?.actionKeywords,
    noiseKeywords: binding?.noiseKeywords,
  };

  const messages = await listInboxMessages({
    mailboxId,
    useUserToken,
    shouldContinue: (pageMessages) => pageMessages.some((message) => sameLocalDate(message.internal_date)),
  });
  const candidates = [];
  let checkedToday = 0;

  for (const message of messages) {
    if (!message.message_id) continue;
    if (!sameLocalDate(message.internal_date)) continue;
    checkedToday += 1;
    const notificationKey = `${message.mailboxId}:${message.message_id}`;
    if (state.notifiedMessageIds[notificationKey]) continue;

    const result = scoreMessage(message, keywordConfig);
    if (result.score >= 2) {
      const code = nextMailCode(state);
      const record = {
        id: code,
        mailboxId: message.mailboxId,
        messageId: message.message_id,
        threadId: message.thread_id,
        ownerKey: ownerKey || notifyTarget?.receive_id || 'default',
        chatId: notifyTarget?.receive_id || '',
        subject: message.subject || '',
        from: message.head_from || null,
        createdAt: new Date().toISOString(),
        status: 'pending',
        message,
      };
      if (!notify || notifyTarget) {
        state.mailRecords[code] = record;
        state.notifiedMessageIds[notificationKey] = code;
      }
      if (notifyTarget) {
        state.lastPendingByChat = state.lastPendingByChat || {};
        state.lastPendingByChat[notifyTarget.receive_id] = code;
        if (ownerKey) {
          state.lastPendingByUser = state.lastPendingByUser || {};
          state.lastPendingByUser[ownerKey] = code;
        }
      }
      candidates.push({ code, message, record });
    }
  }

  writeJson('state.json', state);

  if (notify) {
    for (const item of candidates) {
      try {
        let images = [];
        try {
          images = await uploadMailInlineImages(item.message);
        } catch (error) {
          appendLog('mail_inline_image_upload_failed', { code: item.code, error: error.response?.data || error.message });
        }
        const cards = buildMailNoticeCards(item.code, item.message, { images });
        for (let index = 0; index < cards.length; index += 1) {
          const sent = await sendCard(cards[index], notifyTarget);
          if (index === 0 && sent?.message_id && state.mailRecords?.[item.code]) {
            state.mailRecords[item.code].cardMessageId = sent.message_id;
          }
        }
        if (state.mailRecords?.[item.code]) {
          state.mailRecords[item.code].cardPartCount = cards.length;
          writeJson('state.json', state);
        }
      } catch (error) {
        appendLog('mail_notice_card_failed', { code: item.code, error: error.response?.data || error.message });
        await sendText(buildNotice(item.code, item.message), notifyTarget);
      }
    }
  }

  const result = {
    candidates,
    checkedToday,
    fetchedTotal: messages.length,
    processedToday: todayProcessedCount(state, ownerKey, mailboxId),
    pendingToday: todayPendingCount(state, ownerKey, mailboxId),
  };
  appendLog('scan_once_done', {
    candidates: candidates.length,
    checkedToday,
    fetchedTotal: messages.length,
    processedToday: result.processedToday,
    pendingToday: result.pendingToday,
  });
  return result;
}

module.exports = {
  scanOnce,
  buildNotice,
};
