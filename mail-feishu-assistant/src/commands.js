const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, appendLog } = require('./store');
const { saveNotifyTarget, saveUserBinding, getUserBinding, sendText, sendCard, updateCard } = require('./feishuMessages');
const { sendReply, sendNewMail, uploadMailInlineImages } = require('./mail');
const config = require('./config');
const { getUserContactByOpenId, verifyMailboxBelongsToUser, findUsersByName } = require('./contact');
const { createAuthUrl } = require('./oauth');
const { getUserAuthStatus } = require('./tokens');
const { client } = require('./larkClient');
const { parseScheduleWindows, scheduleWindowsForBinding, scheduleWindowsText } = require('./schedule');
const {
  buildMailNoticeCards,
  buildMailWaitingCard,
  buildMailHandledCard,
  buildScanSummaryCard,
  buildPendingListCard,
  buildInfoCard,
  buildConfigCard,
} = require('./cards');

function extractText(event) {
  const content = event.message?.content;
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    return parsed.text || '';
  } catch {
    return content;
  }
}

function parseContent(event) {
  const content = event.message?.content;
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function parseCommand(text) {
  const cleaned = text.trim().replace(/^#/, '');
  const match = cleaned.match(/^(?:(M\d{8}-\d{3})\s+)?(回复全部|回复|忽略)(?:\s+|\n|$)([\s\S]*)$/);
  if (!match) return null;
  return {
    code: match[1] || '',
    action: match[2],
    body: (match[3] || '').trim(),
  };
}

function getPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://ipv4.icanhazip.com', { timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const ip = body.trim();
        resolve(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ? ip : '');
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
    req.on('error', () => resolve(''));
  });
}

function getSenderKey(data) {
  const senderId = data.sender?.sender_id || {};
  return senderId.open_id || senderId.user_id || senderId.union_id || data.message?.chat_id;
}

function mailboxFromContactUser(user) {
  return user?.enterprise_email || user?.email || '';
}

function splitKeywords(raw) {
  return raw
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitRecipientText(raw) {
  return (raw || '')
    .replace(/[，、；;]/g, ',')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSendMailCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('发送')) return null;
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines.shift() || '';
  let recipientsText = firstLine.replace(/^发送\s*/, '').trim();
  let subject = '';
  let body = '';
  const restLines = lines;

  for (let index = 0; index < restLines.length; index += 1) {
    const line = restLines[index];
    const recipientMatch = line.match(/^收件人[:：]\s*(.+)$/);
    if (recipientMatch && !recipientsText) {
      recipientsText = recipientMatch[1].trim();
      continue;
    }
    const subjectMatch = line.match(/^主题[:：]\s*(.*)$/);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
      continue;
    }
    const bodyMatch = line.match(/^内容[:：]\s*(.*)$/);
    if (bodyMatch) {
      body = [bodyMatch[1], ...restLines.slice(index + 1)].join('\n').trim();
      break;
    }
  }

  if (!subject && !body) {
    const contentLines = restLines
      .filter((line) => !/^收件人[:：]/.test(line))
      .map((line) => line.trimEnd());
    subject = (contentLines.shift() || '').trim();
    body = contentLines.join('\n').trim();
  }

  return { recipientsText, subject, body };
}

function parseConfirmSendCommand(text) {
  const trimmed = text.trim();
  if (trimmed === '确认发送') return 'latest';
  return trimmed.match(/^确认发送\s+(S\d{8}-\d{3})$/)?.[1] || '';
}

function nextOutboundCode(state) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replaceAll('-', '');
  state.outboundSequence = state.outboundSequence || {};
  state.outboundSequence[date] = (state.outboundSequence[date] || 0) + 1;
  return `S${date}-${String(state.outboundSequence[date]).padStart(3, '0')}`;
}

function extractEmails(raw) {
  const emails = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(emails.map((email) => email.toLowerCase()))];
}

function getMessageMentions(data) {
  return data.message?.mentions || [];
}

function sanitizeFilename(value) {
  return (value || 'attachment')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'attachment';
}

function getAttachmentFromMessage(data) {
  const messageType = data.message?.message_type;
  const messageId = data.message?.message_id;
  const content = parseContent(data);
  if (messageType === 'image' && content.image_key && messageId) {
    return {
      kind: 'image',
      key: content.image_key,
      messageId,
      filename: `image-${Date.now()}.png`,
      contentType: 'image/png',
    };
  }
  if (messageType === 'file' && content.file_key && messageId) {
    return {
      kind: 'file',
      key: content.file_key,
      messageId,
      filename: sanitizeFilename(content.file_name || content.name || `file-${Date.now()}`),
      contentType: content.file_type?.includes('/') ? content.file_type : undefined,
    };
  }
  return null;
}

function bufferFromStream(stream) {
  const readable = typeof stream?.getReadableStream === 'function'
    ? stream.getReadableStream()
    : stream;
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

async function downloadMessageAttachment(attachment) {
  const res = await client.im.v1.messageResource.get({
    path: {
      message_id: attachment.messageId,
      file_key: attachment.key,
    },
    params: {
      type: attachment.kind,
    },
  });
  return bufferFromStream(res);
}

function latestPendingOutboundDraft(state, ownerKey) {
  const code = state.lastOutboundDraftByUser?.[ownerKey];
  if (code && state.pendingOutboundMails?.[code]?.status === 'pending') {
    return state.pendingOutboundMails[code];
  }
  return Object.values(state.pendingOutboundMails || {})
    .filter((draft) => draft.ownerKey === ownerKey && draft.status === 'pending')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

async function resolveMentionRecipients(data) {
  const recipients = [];
  for (const mention of getMessageMentions(data)) {
    const openId = mention.id?.open_id || mention.id?.user_id;
    if (!openId) continue;
    const user = await getUserContactByOpenId(openId);
    const mailboxId = mailboxFromContactUser(user);
    if (mailboxId) {
      recipients.push({ mail_address: mailboxId, name: user.name || mention.name });
    }
  }
  return recipients;
}

async function resolveNameRecipients(names) {
  const recipients = [];
  const errors = [];
  for (const name of names) {
    const matches = await findUsersByName(name);
    if (matches.length === 1) {
      recipients.push({
        mail_address: matches[0].enterprise_email || matches[0].email,
        name: matches[0].name,
      });
    } else if (matches.length === 0) {
      errors.push(`未找到：${name}`);
    } else {
      errors.push(`匹配到多人：${name}（请改用 @同事 或邮箱）`);
    }
  }
  return { recipients, errors };
}

function uniqueMailRecipients(recipients) {
  const seen = new Set();
  return recipients.filter((item) => {
    const key = item.mail_address?.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function keywordsText(keywords) {
  return (keywords?.length ? keywords : config.actionKeywords).join('、');
}

function formatDateTime(isoText) {
  if (!isoText) return '';
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildConfigText(binding, authStatus) {
  const authLines = authStatus?.authorized
    ? [
        `授权状态：已授权${authStatus.mailboxId ? `（${authStatus.mailboxId}）` : ''}`,
        authStatus.updatedAt ? `授权更新时间：${formatDateTime(authStatus.updatedAt)}` : null,
      ].filter(Boolean)
    : [
        '授权状态：未授权',
        authStatus?.error ? `授权检查失败：${authStatus.error}` : null,
        '如需自动回复邮件，请发送：授权我',
      ].filter(Boolean);

  return [
    '当前配置：',
    `绑定状态：${binding?.mailboxId ? '已绑定' : '未绑定'}`,
    `绑定邮箱：${binding?.mailboxId || '未绑定'}`,
    ...authLines,
    `巡检关键词：${keywordsText(binding?.actionKeywords)}`,
    `定时巡检时间：${scheduleWindowsText(scheduleWindowsForBinding(binding))}`,
    '',
    '可用指令：',
    '绑定我',
    '授权我',
    '设置关键词 关键词1、关键词2、关键词3',
    '重置关键词',
    '设置巡检时间 8-12,14-18,20-22',
    '重置巡检时间',
  ].join('\n');
}

function buildUnknownCommandText() {
  return [
    '无法识别指令，请按照以下格式发送：',
    '',
    '基础指令：',
    '绑定我',
    '授权我',
    '查看配置',
    '巡检',
    '查看待处理',
    '',
    '处理邮件：',
    '回复 邮件内容',
    '回复全部 邮件内容',
    '忽略',
    '',
    '也支持换行，例如：',
    '回复全部',
    '同意开通',
    '',
    '配置关键词：',
    '设置关键词 审批、请处理、同意',
    '重置关键词',
    '',
    '配置巡检时间：',
    '查看配置',
    '设置巡检时间 8-12,14-18,20-22',
    '重置巡检时间',
    '',
    '直接发邮件：',
    '发送 @同事 或 邮箱地址',
    '主题：邮件主题',
    '内容：邮件正文',
    '确认发送',
  ].join('\n');
}

function isReservedCommand(text) {
  return /^(巡检|查看待处理|查看配置|授权我|绑定我|绑定邮箱\s+|设置关键词|重置关键词|设置巡检时间|重置巡检时间|发送\s+|确认发送)(?:\s|$)/.test(text.trim());
}

function resolveRecord(state, command, chatId, ownerKey) {
  const records = state.mailRecords || {};
  if (command.code) {
    const record = records[command.code];
    if (record && record.ownerKey && record.ownerKey !== ownerKey) {
      return { code: command.code, record: null, forbidden: true };
    }
    return { code: command.code, record };
  }
  const userCode = state.lastPendingByUser?.[ownerKey];
  if (userCode && records[userCode]?.status === 'pending') {
    return { code: userCode, record: records[userCode] };
  }
  const lastCode = state.lastPendingByChat?.[chatId];
  if (lastCode && records[lastCode]?.status === 'pending' && records[lastCode]?.ownerKey === ownerKey) {
    return { code: lastCode, record: records[lastCode] };
  }
  const pending = Object.values(records)
    .filter((record) => record.status === 'pending' && record.ownerKey === ownerKey)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return { code: pending?.id || '', record: pending };
}

function pendingRecordsForUser(state, ownerKey, mailboxId) {
  return Object.values(state.mailRecords || {})
    .filter((record) => record.status === 'pending')
    .filter((record) => !ownerKey || record.ownerKey === ownerKey)
    .filter((record) => !mailboxId || record.mailboxId === mailboxId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function sendPendingRecords({ state, senderKey, chatId, mailboxId }) {
  const records = pendingRecordsForUser(state, senderKey, mailboxId);
  const target = { receive_id: chatId, receive_id_type: 'chat_id' };
  state.lastPendingListByUser = state.lastPendingListByUser || {};
  state.lastPendingListByUser[senderKey] = {
    chatId,
    mailboxId,
    codes: records.map((record) => record.id),
    updatedAt: new Date().toISOString(),
  };
  writeJson('state.json', state);
  await sendCard(buildPendingListCard(records), target);
}

async function sendPendingRecordDetail({ state, senderKey, chatId, code }) {
  const record = state.mailRecords?.[code];
  const targetChatId = chatId || record?.chatId;
  if (!record || record.status !== 'pending' || record.ownerKey !== senderKey) {
    await sendCard(buildInfoCard('没有找到这封待处理邮件', [
      '这封邮件可能已处理，或不属于你的绑定邮箱。',
      '请发送：查看待处理',
    ], 'orange'), { receive_id: targetChatId, receive_id_type: 'chat_id' });
    return;
  }
  let images = [];
  try {
    images = await uploadMailInlineImages(record.message || {});
  } catch (error) {
    appendLog('mail_inline_image_upload_failed', { code: record.id, error: error.response?.data || error.message });
  }
  const cards = buildMailNoticeCards(record.id, record.message || {}, { images });
  for (let index = 0; index < cards.length; index += 1) {
    const sent = await sendCard(cards[index], { receive_id: targetChatId, receive_id_type: 'chat_id' });
    if (index === 0 && sent?.message_id) {
      record.cardMessageId = sent.message_id;
    }
  }
  state.lastPendingByUser = state.lastPendingByUser || {};
  state.lastPendingByUser[senderKey] = record.id;
  record.cardPartCount = cards.length;
  writeJson('state.json', state);
}

function resolvePendingListCode(state, senderKey, text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:查看待处理\s*)?(?:第\s*)?(\d+)(?:\s*封)?$/);
  if (!match) return '';
  const index = Number.parseInt(match[1], 10) - 1;
  if (index < 0) return '';
  const list = state.lastPendingListByUser?.[senderKey]?.codes || [];
  return list[index] || '';
}

async function updateRecordCard(record, card) {
  if (!record?.cardMessageId) return;
  try {
    await updateCard(record.cardMessageId, card);
  } catch (error) {
    appendLog('card_update_failed', {
      code: record.id,
      messageId: record.cardMessageId,
      error: error.response?.data || error.message,
    });
  }
}

async function executeMailCommand({ state, code, record, action, body, chatId, senderKey }) {
  if (record.status === 'replied') {
    await sendCard(buildInfoCard('邮件已处理', [`${code} 已经回复过，避免重复发送。`], 'green'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }
  if (record.status === 'ignored') {
    await sendCard(buildInfoCard('邮件已忽略', [`${code} 已经标记为忽略。`], 'grey'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }
  if (action === '忽略') {
    record.status = 'ignored';
    record.ignoredAt = new Date().toISOString();
    delete state.pendingReplyByUser?.[senderKey];
    writeJson('state.json', state);
    const card = buildMailHandledCard(record, { action });
    await updateRecordCard(record, card);
    await sendCard(card, { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }
  if (!body) {
    state.pendingReplyByUser = state.pendingReplyByUser || {};
    state.pendingReplyByUser[senderKey] = {
      code,
      action,
      chatId,
      createdAt: new Date().toISOString(),
    };
    writeJson('state.json', state);
    const card = buildMailWaitingCard(record, action);
    await updateRecordCard(record, card);
    await sendCard(card, { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  if (!config.allowSendEmail) {
    await sendCard(buildInfoCard('当前未真正发送邮件', [
      '当前 ALLOW_SEND_EMAIL=false。',
      `邮件编号：${code}`,
      `动作：${action}`,
      '',
      '拟发送内容：',
      body,
    ], 'orange'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  let result;
  try {
    result = await sendReply(record, body, action === '回复全部');
  } catch (error) {
    await sendCard(buildInfoCard(`${code} 发送失败`, [
      `错误信息：${error.response?.data?.msg || error.message || error}`,
      '如果提示没有用户授权，请先发送“授权我”。',
    ], 'red'), { receive_id: chatId, receive_id_type: 'chat_id' });
    appendLog('mail_reply_failed', { code, action, error: error.response?.data || error.message });
    return;
  }
  record.status = 'replied';
  record.repliedAt = new Date().toISOString();
  record.replyAction = action;
  record.replyBody = body;
  record.sentMessageId = result?.message_id;
  record.sentThreadId = result?.thread_id;
  delete state.pendingReplyByUser?.[senderKey];
  writeJson('state.json', state);
  appendLog('mail_replied', { code, action });
  const card = buildMailHandledCard(record, { action, body });
  await updateRecordCard(record, card);
  await sendCard(card, { receive_id: chatId, receive_id_type: 'chat_id' });
}

function extractCardAction(data) {
  const event = data.event || data;
  const action = event.action || data.action || {};
  const value = action.value || {};
  const operator = event.operator || data.operator || {};
  const operatorId = operator.operator_id || operator.id || {};
  const context = event.context || data.context || {};
  return {
    value,
    openId: operator.open_id || operator.openId || operatorId.open_id || operatorId.openId || operator.user_id || operatorId.user_id,
    chatId: context.open_chat_id || context.chat_id || event.chat_id || data.chat_id,
    messageId: context.open_message_id || context.message_id || event.message_id || data.message_id,
  };
}

async function handleCardActionEvent(data) {
  const { value, openId, chatId, messageId } = extractCardAction(data);
  const state = readJson('state.json', {});
  if (value.type === 'list_pending') {
    const binding = getUserBinding(openId);
    await sendPendingRecords({
      state,
      senderKey: openId,
      chatId: chatId || binding?.chatId,
      mailboxId: binding?.mailboxId,
    });
    return;
  }
  if (value.type === 'pending_detail') {
    await sendPendingRecordDetail({
      state,
      senderKey: openId,
      chatId,
      code: value.code,
    });
    return;
  }
  if (value.type !== 'mail_action') return;
  const record = state.mailRecords?.[value.code];
  if (!record || record.ownerKey !== openId) {
    await sendCard(buildInfoCard('不能处理这封邮件', [
      '这封邮件不是绑定给你的，不能由你处理。',
    ], 'red'), { receive_id: chatId || record?.chatId, receive_id_type: 'chat_id' });
    return;
  }
  if (messageId && !record.cardMessageId) {
    record.cardMessageId = messageId;
  }
  await executeMailCommand({
    state,
    code: value.code,
    record,
    action: value.action,
    body: '',
    chatId: chatId || record.chatId,
    senderKey: openId,
  });
}

async function handleMessageEvent(data) {
  const text = extractText(data);
  const chatId = data.message?.chat_id;
  const messageId = data.message?.message_id;
  const senderKey = getSenderKey(data);
  const state = readJson('state.json', {});

  if (messageId) {
    state.processedFeishuMessageIds = state.processedFeishuMessageIds || {};
    if (state.processedFeishuMessageIds[messageId]) {
      return;
    }
    state.processedFeishuMessageIds[messageId] = new Date().toISOString();
    writeJson('state.json', state);
  }

  const incomingAttachment = getAttachmentFromMessage(data);
  if (incomingAttachment) {
    const draft = latestPendingOutboundDraft(state, senderKey);
    if (!draft) {
      await sendText('收到附件，但没有找到待发送邮件草稿。请先发送“发送 ...”创建草稿，再发送附件。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    try {
      const buffer = await downloadMessageAttachment(incomingAttachment);
      const dir = path.join(config.dataDir, 'outbound-attachments', draft.id);
      fs.mkdirSync(dir, { recursive: true });
      const filename = sanitizeFilename(incomingAttachment.filename);
      const filePath = path.join(dir, `${Date.now()}-${filename}`);
      fs.writeFileSync(filePath, buffer);
      draft.attachments = draft.attachments || [];
      draft.attachments.push({
        filename,
        path: filePath,
        contentType: incomingAttachment.contentType,
        size: buffer.length,
      });
      writeJson('state.json', state);
      await sendText([
        `已添加附件到草稿 ${draft.id}：${filename}`,
        `当前附件数：${draft.attachments.length}`,
        `确认无误后发送：确认发送 ${draft.id}`,
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    } catch (error) {
      appendLog('attachment_download_failed', {
        kind: incomingAttachment.kind,
        messageId: incomingAttachment.messageId,
        error: error.response?.data || error.message,
      });
      await sendText([
        '附件下载失败，暂未添加到邮件草稿。',
        `错误信息：${error.response?.data?.msg || error.message || error}`,
        '如果提示无权限，需要在飞书后台增加读取消息图片/文件资源的权限。',
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    }
    return;
  }

  const pendingReply = state.pendingReplyByUser?.[senderKey];
  if (pendingReply && text.trim()) {
    if (/^取消回复$/.test(text.trim())) {
      delete state.pendingReplyByUser[senderKey];
      writeJson('state.json', state);
      await sendCard(buildInfoCard('已取消回复', [
        `邮件编号：${pendingReply.code}`,
        '如需处理，请重新点击卡片按钮或发送回复指令。',
      ], 'grey'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    if (isReservedCommand(text)) {
      await sendCard(buildInfoCard('正在等待邮件回复内容', [
        `当前等待处理：${pendingReply.code} ${pendingReply.action}`,
        '如果要执行其他指令，请先发送：取消回复',
      ], 'orange'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const record = state.mailRecords?.[pendingReply.code];
    if (!record || record.status !== 'pending') {
      delete state.pendingReplyByUser[senderKey];
      writeJson('state.json', state);
      await sendCard(buildInfoCard('待回复状态已失效', [
        `邮件编号：${pendingReply.code}`,
        '这封邮件可能已被处理，请重新巡检后再操作。',
      ], 'orange'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    await executeMailCommand({
      state,
      code: pendingReply.code,
      record,
      action: pendingReply.action,
      body: text.trim(),
      chatId,
      senderKey,
    });
    return;
  }

  const bindMailboxMatch = text.trim().match(/^绑定邮箱\s+([^\s@]+@[^\s@]+)$/);
  if (bindMailboxMatch) {
    const mailboxId = bindMailboxMatch[1];
    let verifyResult;
    try {
      verifyResult = await verifyMailboxBelongsToUser(senderKey, mailboxId);
    } catch (error) {
      await sendText([
        '绑定失败：无法读取你的飞书通讯录邮箱。',
        '请检查应用是否开通并发布了通讯录应用身份权限：',
        'contact:contact.base:readonly',
        `错误信息：${error.message}`,
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    if (!verifyResult.ok) {
      await sendText([
        '绑定失败：你只能绑定自己的飞书企业邮箱。',
        verifyResult.allowedEmails.length
          ? `你当前通讯录邮箱：${verifyResult.allowedEmails.join('、')}`
          : '没有从通讯录读取到你的企业邮箱，请联系管理员检查通讯录权限。',
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    saveUserBinding(senderKey, { chatId, mailboxId });
    await sendText(`已绑定邮箱：${mailboxId}\n后续你发送“巡检”会检查这个邮箱。`, { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  if (/^绑定我$/.test(text.trim())) {
    saveNotifyTarget(chatId, 'chat_id');
    let user;
    try {
      user = await getUserContactByOpenId(senderKey);
    } catch (error) {
      await sendText([
        '绑定失败：无法读取你的飞书通讯录邮箱。',
        '请检查应用是否开通并发布了通讯录应用身份权限：',
        'contact:contact.base:readonly',
        `错误信息：${error.message}`,
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const mailboxId = mailboxFromContactUser(user);
    if (mailboxId) {
      saveUserBinding(senderKey, { chatId, mailboxId });
      await sendText(`已绑定当前聊天和邮箱：${mailboxId}\n后续你发送“巡检”会检查这个邮箱。`, { receive_id: chatId, receive_id_type: 'chat_id' });
    } else {
      await sendText('绑定失败：没有从飞书通讯录读取到你的企业邮箱，请联系管理员检查通讯录资料。', { receive_id: chatId, receive_id_type: 'chat_id' });
    }
    return;
  }

  if (/^巡检$/.test(text.trim())) {
    const { scanOnce } = require('./scanner');
    const binding = getUserBinding(senderKey);
    if (!binding?.mailboxId) {
      await sendText('请先绑定邮箱，例如：\n绑定邮箱 name@yunzhanxinxi.cn', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const result = await scanOnce({
      notify: true,
      mailboxId: binding.mailboxId,
      ownerKey: senderKey,
      target: { receive_id: binding.chatId || chatId, receive_id_type: 'chat_id' },
    });
    await sendCard(buildScanSummaryCard('手动', binding.mailboxId, result), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  if (/^查看待处理$/.test(text.trim())) {
    const binding = getUserBinding(senderKey);
    if (!binding?.mailboxId) {
      await sendCard(buildInfoCard('请先绑定邮箱', ['请先发送：绑定我'], 'orange'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    await sendPendingRecords({
      state,
      senderKey,
      chatId,
      mailboxId: binding.mailboxId,
    });
    return;
  }

  const pendingListCode = resolvePendingListCode(state, senderKey, text);
  if (pendingListCode) {
    await sendPendingRecordDetail({
      state,
      senderKey,
      chatId,
      code: pendingListCode,
    });
    return;
  }

  if (/^授权我$/.test(text.trim())) {
    const authUrl = createAuthUrl(senderKey, chatId);
    const publicIp = await getPublicIp();
    await sendText([
      '请打开下面的链接完成飞书邮箱授权：',
      authUrl,
      '',
      '如果打开后出现 localtunnel 安全确认页，请在页面的 IP Address 输入框里填写页面上显示的 IP，然后点 Continue。',
      publicIp ? `当前可尝试填写：${publicIp}` : '如果这里没有显示 IP，就填写网页上 “This tunnel is hosted by” 后面的 IP。',
      '',
      '授权成功后，你就可以用自己的邮箱自动回复邮件。',
    ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  if (/^查看配置$/.test(text.trim())) {
    const binding = getUserBinding(senderKey);
    const authStatus = await getUserAuthStatus(senderKey, { validate: true });
    await sendCard(buildConfigCard(
      binding,
      authStatus,
      keywordsText(binding?.actionKeywords),
      scheduleWindowsText(scheduleWindowsForBinding(binding)),
    ), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  const confirmCode = parseConfirmSendCommand(text);
  if (confirmCode) {
    const draft = confirmCode === 'latest'
      ? latestPendingOutboundDraft(state, senderKey)
      : state.pendingOutboundMails?.[confirmCode];
    if (!draft || draft.ownerKey !== senderKey || draft.status !== 'pending') {
      await sendText('没有找到可确认发送的邮件草稿，请重新发送邮件内容。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const draftCode = draft.id;
    if (!config.allowSendEmail) {
      await sendText([
        '当前 ALLOW_SEND_EMAIL=false，没有真正发送邮件。',
        `草稿编号：${draftCode}`,
        `收件人：${draft.to.map((item) => item.mail_address).join('、')}`,
        `主题：${draft.subject}`,
        `内容：${draft.body}`,
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    let result;
    try {
      result = await sendNewMail({
        ownerKey: senderKey,
        mailboxId: draft.mailboxId,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        draftId: draftCode,
        attachments: draft.attachments || [],
      });
    } catch (error) {
      await sendText([
        `${draftCode} 发送失败，没有发出邮件。`,
        `错误信息：${error.response?.data?.msg || error.message || error}`,
        '如果提示没有用户授权，请先发送“授权我”。',
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      appendLog('new_mail_failed', { code: draftCode, error: error.response?.data || error.message });
      return;
    }
    draft.status = 'sent';
    draft.sentAt = new Date().toISOString();
    draft.sentMessageId = result?.message_id;
    draft.sentThreadId = result?.thread_id;
    writeJson('state.json', state);
    appendLog('new_mail_sent', { code: draftCode, to: draft.to.map((item) => item.mail_address) });
    await sendText([
      `${draftCode} 已发送。`,
      `收件人：${draft.to.map((item) => item.mail_address).join('、')}`,
      `主题：${draft.subject}`,
      draft.attachments?.length ? `附件：${draft.attachments.length} 个` : null,
    ].filter(Boolean).join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  const sendMailCommand = parseSendMailCommand(text);
  if (sendMailCommand) {
    const binding = getUserBinding(senderKey);
    if (!binding?.mailboxId) {
      await sendText('请先发送“绑定我”，再直接发送邮件。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const authStatus = await getUserAuthStatus(senderKey, { validate: true });
    if (!authStatus.authorized) {
      await sendText('请先发送“授权我”，完成邮箱授权后再直接发送邮件。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    if (!sendMailCommand.recipientsText && getMessageMentions(data).length === 0) {
      await sendText([
        '请写收件人，例如：',
        '发送 @同事',
        '主题：测试',
        '内容：这里写正文',
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    if (!sendMailCommand.subject || !sendMailCommand.body) {
      await sendText([
        '请同时写主题和内容，例如：',
        '发送 @同事',
        '主题：测试',
        '内容：这里写正文',
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    let mentionRecipients = [];
    try {
      mentionRecipients = await resolveMentionRecipients(data);
    } catch (error) {
      await sendText([
        '读取 @同事 的企业邮箱失败。',
        '可以改用邮箱地址发送，例如：发送 name@yunzhanxinxi.cn',
        `错误信息：${error.message}`,
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const emailRecipients = extractEmails(sendMailCommand.recipientsText)
      .map((email) => ({ mail_address: email }));
    const hasRealMentions = getMessageMentions(data).length > 0;
    const nameTokens = splitRecipientText(sendMailCommand.recipientsText)
      .filter((item) => !extractEmails(item).length)
      .map((item) => item.replace(/^@/, '').trim())
      .filter((item) => !(hasRealMentions && /^_?user_\d+$/i.test(item)))
      .filter(Boolean);
    const { recipients: nameRecipients, errors: nameErrors } = await resolveNameRecipients(nameTokens);
    if (nameErrors.length > 0) {
      await sendText([
        '部分收件人无法唯一匹配：',
        ...nameErrors,
        '请改用飞书 @同事，或者直接写邮箱地址。',
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const to = uniqueMailRecipients([...mentionRecipients, ...emailRecipients, ...nameRecipients]);
    if (to.length === 0) {
      await sendText('没有识别到有效收件人。请用飞书 @同事，或者直接写邮箱地址。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const code = nextOutboundCode(state);
    state.pendingOutboundMails = state.pendingOutboundMails || {};
    state.pendingOutboundMails[code] = {
      id: code,
      ownerKey: senderKey,
      mailboxId: binding.mailboxId,
      to,
      subject: sendMailCommand.subject,
      body: sendMailCommand.body,
      status: 'pending',
      createdAt: new Date().toISOString(),
      attachments: [],
    };
    state.lastOutboundDraftByUser = state.lastOutboundDraftByUser || {};
    state.lastOutboundDraftByUser[senderKey] = code;
    writeJson('state.json', state);
    await sendText([
      `已生成待发送邮件草稿：${code}`,
      `发件邮箱：${binding.mailboxId}`,
      `收件人：${to.map((item) => item.name ? `${item.name} <${item.mail_address}>` : item.mail_address).join('、')}`,
      `主题：${sendMailCommand.subject}`,
      '',
      '正文：',
      sendMailCommand.body,
      '',
      '如需附件，请现在直接把图片、文档或表格发给机器人，机器人会添加到这个草稿。',
      '确认无误后发送：确认发送',
    ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  const setKeywordsMatch = text.trim().match(/^设置关键词\s+([\s\S]+)$/);
  if (setKeywordsMatch) {
    const keywords = splitKeywords(setKeywordsMatch[1]);
    if (keywords.length === 0) {
      await sendText('没有识别到关键词。示例：\n设置关键词 审批、同意、请处理', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    if (keywords.length > 30) {
      await sendText('关键词太多了，最多设置 30 个。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const binding = getUserBinding(senderKey);
    if (!binding?.mailboxId) {
      await sendText('请先发送“绑定我”，再设置关键词。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    saveUserBinding(senderKey, { ...binding, actionKeywords: keywords });
    await sendText([
      '已更新巡检关键词：',
      keywords.join('、'),
      '',
      '后续“巡检”和定时巡检都会使用这组关键词。',
    ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  const setScheduleMatch = text.trim().match(/^设置巡检时间\s+([\s\S]+)$/);
  if (setScheduleMatch) {
    const windows = parseScheduleWindows(setScheduleMatch[1]);
    if (windows.length === 0) {
      await sendText([
        '没有识别到有效巡检时间。',
        '示例：设置巡检时间 8-12,14-18,20-22',
        '也可以只设单个小时：设置巡检时间 9,14,19,22',
        '小时范围只能是 0 到 23，结束时间不能早于开始时间。',
      ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    const binding = getUserBinding(senderKey);
    if (!binding?.mailboxId) {
      await sendText('请先发送“绑定我”，再设置巡检时间。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    saveUserBinding(senderKey, { ...binding, scheduleWindows: windows });
    await sendText([
      '已更新定时巡检时间：',
      scheduleWindowsText(windows),
      '',
      '后续定时巡检只会在这些时间段内每小时执行一次。',
      '手动发送“巡检”不受时间段限制。',
    ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  if (/^重置巡检时间$/.test(text.trim())) {
    const binding = getUserBinding(senderKey);
    if (!binding?.mailboxId) {
      await sendText('请先发送“绑定我”，再重置巡检时间。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    saveUserBinding(senderKey, { ...binding, scheduleWindows: undefined });
    await sendText([
      '已重置为默认定时巡检时间：',
      scheduleWindowsText(scheduleWindowsForBinding(null)),
    ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  if (/^重置关键词$/.test(text.trim())) {
    const binding = getUserBinding(senderKey);
    if (!binding?.mailboxId) {
      await sendText('请先发送“绑定我”，再重置关键词。', { receive_id: chatId, receive_id_type: 'chat_id' });
      return;
    }
    saveUserBinding(senderKey, { ...binding, actionKeywords: undefined });
    await sendText([
      '已重置为默认巡检关键词：',
      config.actionKeywords.join('、'),
    ].join('\n'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }

  const command = parseCommand(text);
  if (!command) {
    if (text.trim()) {
      await sendCard(buildInfoCard('无法识别指令', [buildUnknownCommandText()], 'orange'), { receive_id: chatId, receive_id_type: 'chat_id' });
    }
    return;
  }

  const { code, record, forbidden } = resolveRecord(state, command, chatId, senderKey);
  if (forbidden) {
    await sendCard(buildInfoCard('不能处理这封邮件', ['这封邮件不是绑定给你的，不能由你回复。'], 'red'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }
  if (!record) {
    await sendCard(buildInfoCard('没有找到待处理邮件', ['请先发送“巡检”，或带上邮件编号再回复。'], 'orange'), { receive_id: chatId, receive_id_type: 'chat_id' });
    return;
  }
  await executeMailCommand({
    state,
    code,
    record,
    action: command.action,
    body: command.body,
    chatId,
    senderKey,
  });
}

module.exports = {
  handleMessageEvent,
  handleCardActionEvent,
  parseCommand,
};
