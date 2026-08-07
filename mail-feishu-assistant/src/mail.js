const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const config = require('./config');
const { client, userTokenOption } = require('./larkClient');
const { getSavedTokens, getUserAccessToken } = require('./tokens');

function mailboxIdFromToken() {
  const tokens = getSavedTokens();
  return config.mailboxId || tokens.enterprise_email || tokens.email;
}

async function getMailboxId(mailboxId) {
  const resolvedMailboxId = mailboxId || mailboxIdFromToken();
  if (!resolvedMailboxId) {
    throw new Error('无法确定飞书邮箱地址。请在 .env 填写 FEISHU_MAILBOX_ID，或重新执行 npm run auth。');
  }
  return resolvedMailboxId;
}

async function withUserToken(useUserToken) {
  if (!useUserToken) {
    return undefined;
  }
  const accessToken = await getUserAccessToken();
  return userTokenOption(accessToken);
}

async function withOwnerToken(ownerKey) {
  const accessToken = await getUserAccessToken(ownerKey);
  return userTokenOption(accessToken);
}

async function getInboxFolderId(mailboxId, options) {
  const res = await client.mail.userMailboxFolder.list({
    path: { user_mailbox_id: mailboxId },
  }, options);
  if (res.code !== 0) {
    throw new Error(`获取邮箱文件夹失败：${res.code} ${res.msg}`);
  }

  const folders = res.data?.items || [];
  const inbox = folders.find((item) => item.folder_type === 1)
    || folders.find((item) => item.name === '收件箱' || item.name?.toLowerCase() === 'inbox')
    || folders[0];
  if (!inbox?.id) {
    throw new Error('没有找到收件箱文件夹。');
  }
  return inbox.id;
}

async function listMessageDetails(mailboxId, options, ids) {
  if (ids.length === 0) {
    return [];
  }
  const detailRes = await client.mail.userMailboxMessage.batchGet({
    path: { user_mailbox_id: mailboxId },
    data: {
      format: 'full',
      message_ids: ids,
    },
  }, options);
  if (detailRes.code !== 0) {
    throw new Error(`拉取邮件详情失败：${detailRes.code} ${detailRes.msg}`);
  }

  return (detailRes.data?.messages || []).map((message) => ({ ...normalizeMessage(message), mailboxId }));
}

async function listInboxMessagePage(mailboxId, options, folderId, pageToken) {
  const listRes = await client.mail.userMailboxMessage.list({
    path: { user_mailbox_id: mailboxId },
    params: {
      page_size: config.scanPageSize,
      folder_id: folderId,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  }, options);
  if (listRes.code !== 0) {
    throw new Error(`拉取收件箱邮件列表失败：${listRes.code} ${listRes.msg}`);
  }

  return listRes.data || {};
}

async function listInboxMessages({ mailboxId, shouldContinue, useUserToken = false } = {}) {
  const resolvedMailboxId = await getMailboxId(mailboxId);
  const options = await withUserToken(useUserToken);
  const folderId = await getInboxFolderId(resolvedMailboxId, options);
  const messages = [];
  let pageToken = undefined;

  for (let page = 0; page < 30; page += 1) {
    const data = await listInboxMessagePage(resolvedMailboxId, options, folderId, pageToken);
    const ids = data.items || [];
    const details = await listMessageDetails(resolvedMailboxId, options, ids);
    messages.push(...details);

    if (shouldContinue && !shouldContinue(details)) {
      break;
    }
    if (!data.has_more || !data.page_token) {
      break;
    }
    pageToken = data.page_token;
  }

  return messages;
}

function isImageAttachment(attachment) {
  return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(attachment.filename || '');
}

function downloadUrlBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('附件下载重定向次数过多。'));
      return;
    }
    const clientModule = url.startsWith('http://') ? http : https;
    const req = clientModule.get(url, { timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        downloadUrlBuffer(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`附件下载失败：HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) {
          req.destroy(new Error('附件超过 10MB，跳过卡片内展示。'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('附件下载超时。')));
    req.on('error', reject);
  });
}

async function downloadAttachmentBuffer({ mailboxId, messageId, attachmentId }) {
  const res = await client.mail.userMailboxMessageAttachment.downloadUrl({
    path: {
      user_mailbox_id: mailboxId,
      message_id: messageId,
    },
    params: {
      attachment_ids: [attachmentId],
    },
  });
  if (res.code !== 0) {
    throw new Error(`获取邮件附件下载链接失败：${res.code} ${res.msg}`);
  }
  const item = res.data?.download_urls?.[0];
  if (!item?.download_url) {
    throw new Error('没有获取到邮件附件下载链接。');
  }
  return downloadUrlBuffer(item.download_url);
}

async function uploadMailInlineImages(message, { maxImages = 6 } = {}) {
  const attachments = (message.attachments || [])
    .filter((item) => item.id && item.is_inline && isImageAttachment(item))
    .slice(0, maxImages);
  const images = [];
  for (const attachment of attachments) {
    const buffer = await downloadAttachmentBuffer({
      mailboxId: message.mailboxId,
      messageId: message.message_id,
      attachmentId: attachment.id,
    });
    const uploaded = await client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: buffer,
      },
    });
    const imageKey = uploaded?.image_key || uploaded?.data?.image_key;
    if (imageKey) {
      images.push({
        imageKey,
        filename: attachment.filename,
      });
    }
  }
  return images;
}

function mailAddress(address) {
  if (!address) return '';
  return address.name ? `${address.name} <${address.mail_address}>` : address.mail_address;
}

function decodeMaybeBase64Url(value) {
  if (!value || typeof value !== 'string') return value;
  const compact = value.replace(/\s/g, '');
  if (compact.length < 16 || !/^[A-Za-z0-9_-]+={0,2}$/.test(compact)) {
    return value;
  }
  try {
    const decoded = Buffer.from(compact, 'base64url').toString('utf8');
    const readableChars = decoded.replace(/[\s\p{P}\p{S}]/gu, '');
    if (readableChars.length >= 4) {
      return decoded;
    }
  } catch {
    return value;
  }
  return value;
}

function normalizeMessage(message) {
  return {
    ...message,
    body_html: decodeMaybeBase64Url(message.body_html),
    body_plain_text: decodeMaybeBase64Url(message.body_plain_text),
    body_preview: decodeMaybeBase64Url(message.body_preview),
  };
}

function normalizeRecipients(items) {
  return (items || [])
    .filter((item) => item?.mail_address)
    .map((item) => ({ mail_address: item.mail_address, name: item.name || undefined }));
}

function uniqueRecipients(items, mailboxId) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.mail_address.toLowerCase();
    if (key === mailboxId.toLowerCase() || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function encodeHeader(value) {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatAddress(item) {
  if (!item?.name || item.name === item.mail_address) {
    return item.mail_address;
  }
  return `${encodeHeader(item.name)} <${item.mail_address}>`;
}

function displayAddress(item) {
  if (!item?.mail_address) return '';
  return item.name && item.name !== item.mail_address
    ? `${item.name} <${item.mail_address}>`
    : item.mail_address;
}

function displayAddressList(items) {
  return normalizeRecipients(items).map(displayAddress).filter(Boolean).join('、');
}

function formatOriginalDate(value) {
  if (!value) return '';
  const date = new Date(/^\d+$/.test(String(value)) ? Number(value) : value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function quotedText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToHtml(value) {
  return escapeHtml(value).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
}

function regularAttachmentNames(message) {
  return (message.attachments || [])
    .filter((attachment) => !attachment.is_inline && attachment.filename)
    .map((attachment) => attachment.filename);
}

function originalHtmlContent(message) {
  const html = String(message.body_html || '').trim();
  if (!html) {
    return textToHtml(message.body_plain_text || message.body_preview || '(无正文内容)');
  }
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return (bodyMatch ? bodyMatch[1] : html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

function buildQuotedOriginalText(message) {
  const originalBody = message.body_plain_text || message.body_preview || '';
  const attachmentNames = regularAttachmentNames(message);
  const lines = [
    '----- 原始邮件 -----',
    `发件人：${displayAddress(message.head_from) || ''}`,
    `发送时间：${formatOriginalDate(message.internal_date) || ''}`,
    `收件人：${displayAddressList(message.to) || ''}`,
    displayAddressList(message.cc) ? `抄送：${displayAddressList(message.cc)}` : '',
    `主题：${message.subject || '(无主题)'}`,
    '',
    quotedText(originalBody || '(无正文内容)'),
    attachmentNames.length ? '' : null,
    attachmentNames.length ? `附件：${attachmentNames.join('、')}（请在原邮件会话中查看）` : null,
  ].filter((line) => line !== '' && line !== null);
  return lines.join('\n');
}

function buildQuotedOriginalHtml(message) {
  const ccText = displayAddressList(message.cc);
  const attachmentNames = regularAttachmentNames(message);
  return [
    '<div style="margin-top:16px;border-top:1px solid #d9d9d9;padding-top:12px;color:#1f2329;">',
    '<div style="margin-bottom:8px;color:#646a73;">----- 原始邮件 -----</div>',
    '<div style="background:#f5f6f7;border-left:3px solid #c9cdd4;padding:10px 12px;margin-bottom:12px;">',
    `<div><strong>发件人：</strong>${escapeHtml(displayAddress(message.head_from) || '')}</div>`,
    `<div><strong>发送时间：</strong>${escapeHtml(formatOriginalDate(message.internal_date) || '')}</div>`,
    `<div><strong>收件人：</strong>${escapeHtml(displayAddressList(message.to) || '')}</div>`,
    ccText ? `<div><strong>抄送：</strong>${escapeHtml(ccText)}</div>` : '',
    `<div><strong>主题：</strong>${escapeHtml(message.subject || '(无主题)')}</div>`,
    '</div>',
    `<blockquote style="margin:0;padding-left:12px;border-left:3px solid #d9d9d9;color:#333;">${originalHtmlContent(message)}</blockquote>`,
    attachmentNames.length
      ? `<div style="margin-top:12px;color:#646a73;"><strong>附件：</strong>${escapeHtml(attachmentNames.join('、'))}（请在原邮件会话中查看）</div>`
      : '',
    '</div>',
  ].filter(Boolean).join('');
}

function wrapBase64(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return buffer
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trimEnd();
}

function mimeTypeFromFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
  };
  return types[ext] || 'application/octet-stream';
}

function normalizeMessageId(value) {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed}>`;
}

function inlineAttachments(message) {
  return (message.attachments || []).filter((attachment) => (
    attachment.is_inline
    && attachment.body
    && attachment.cid
  ));
}

function attachmentBodyBuffer(body) {
  const compact = String(body || '').replace(/\s/g, '');
  return Buffer.from(compact, 'base64url');
}

async function hydrateInlineAttachmentBodies(message, mailboxId) {
  const attachments = await Promise.all((message.attachments || []).map(async (attachment) => {
    if (!attachment.is_inline || !attachment.cid || attachment.body || !attachment.id) {
      return attachment;
    }
    const content = await downloadAttachmentBuffer({
      mailboxId,
      messageId: message.message_id,
      attachmentId: attachment.id,
    });
    return {
      ...attachment,
      body: content.toString('base64'),
    };
  }));
  return {
    ...message,
    attachments,
  };
}

function buildReplyRaw({ message, mailboxId, replyAll, body }) {
  const subject = message.subject?.startsWith('Re:') ? message.subject : `Re: ${message.subject || ''}`;
  const to = normalizeRecipients([message.reply_to ? { mail_address: message.reply_to } : message.head_from]);
  const cc = replyAll
    ? uniqueRecipients([
      ...normalizeRecipients(message.to),
      ...normalizeRecipients(message.cc),
    ], mailboxId)
    : [];
  const inReplyTo = normalizeMessageId(message.smtp_message_id);
  const references = [message.references, inReplyTo].filter(Boolean).join(' ');
  const replyTextBody = [body.trim(), '', buildQuotedOriginalText(message)].join('\n');
  const replyHtmlBody = [
    '<!doctype html><html><body>',
    `<div>${textToHtml(body.trim())}</div>`,
    buildQuotedOriginalHtml(message),
    '</body></html>',
  ].join('');
  const relatedBoundary = `mail-feishu-related-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const alternativeBoundary = `mail-feishu-alternative-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inlineImages = inlineAttachments(message);
  const headers = [
    `From: ${mailboxId}`,
    `To: ${to.map(formatAddress).join(', ')}`,
    cc.length ? `Cc: ${cc.map(formatAddress).join(', ')}` : '',
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(16).slice(2)}@mail-feishu-assistant.local>`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    references ? `References: ${references}` : '',
    'MIME-Version: 1.0',
    inlineImages.length
      ? `Content-Type: multipart/related; boundary="${relatedBoundary}"`
      : `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
  ].filter(Boolean);
  const alternativeParts = [
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(replyTextBody),
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(replyHtmlBody),
    `--${alternativeBoundary}--`,
    '',
  ];
  if (inlineImages.length === 0) {
    return `${headers.join('\r\n')}\r\n\r\n${alternativeParts.join('\r\n')}`;
  }

  const parts = [
    `--${relatedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    ...alternativeParts,
  ];
  for (const attachment of inlineImages) {
    const filename = attachment.filename || 'inline-image';
    parts.push(
      `--${relatedBoundary}`,
      `Content-Type: ${mimeTypeFromFilename(filename)}; name="${encodeHeader(filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${attachment.cid.replace(/^<|>$/g, '')}>`,
      `Content-Disposition: inline; filename="${encodeHeader(filename)}"`,
      '',
      wrapBase64(attachmentBodyBuffer(attachment.body)),
    );
  }
  parts.push(`--${relatedBoundary}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

function buildNewMailRaw({ mailboxId, to, subject, body, attachments = [] }) {
  const baseHeaders = [
    `From: ${mailboxId}`,
    `To: ${to.map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeader(subject || '(无主题)')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(16).slice(2)}@mail-feishu-assistant.local>`,
    'MIME-Version: 1.0',
  ];
  if (attachments.length === 0) {
    const headers = [
      ...baseHeaders,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].filter(Boolean);
    return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(body)}\r\n`;
  }

  const boundary = `mail-feishu-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const headers = [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(body),
  ];
  for (const attachment of attachments) {
    const filename = attachment.filename || path.basename(attachment.path || 'attachment');
    const content = attachment.content || fs.readFileSync(attachment.path);
    const contentType = attachment.contentType || mimeTypeFromFilename(filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${encodeHeader(filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(filename)}"`,
      '',
      wrapBase64(content),
    );
  }
  parts.push(`--${boundary}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

function encodeRawMessage(raw) {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

async function sendReply(record, body, replyAll) {
  const mailboxId = record.mailboxId || await getMailboxId();
  const options = await withOwnerToken(record.ownerKey);
  const message = await hydrateInlineAttachmentBodies(record.message, mailboxId);
  const raw = buildReplyRaw({ message, mailboxId, replyAll, body });
  const res = await client.mail.userMailboxMessage.send({
    path: { user_mailbox_id: mailboxId },
    data: {
      raw: encodeRawMessage(raw),
      dedupe_key: `${record.id}-${replyAll ? 'all' : 'one'}-${Date.now()}`,
    },
  }, options);
  if (res.code !== 0) {
    throw new Error(`发送邮件失败：${res.code} ${res.msg}`);
  }
  return res.data;
}

async function sendNewMail({ ownerKey, mailboxId, to, subject, body, draftId, attachments = [] }) {
  const resolvedMailboxId = await getMailboxId(mailboxId);
  const options = await withOwnerToken(ownerKey);
  const raw = buildNewMailRaw({ mailboxId: resolvedMailboxId, to, subject, body, attachments });
  const res = await client.mail.userMailboxMessage.send({
    path: { user_mailbox_id: resolvedMailboxId },
    data: {
      raw: encodeRawMessage(raw),
      dedupe_key: `${draftId || 'new'}-${Date.now()}`,
    },
  }, options);
  if (res.code !== 0) {
    throw new Error(`发送邮件失败：${res.code} ${res.msg}`);
  }
  return res.data;
}

module.exports = {
  listInboxMessages,
  downloadAttachmentBuffer,
  sendReply,
  sendNewMail,
  mailAddress,
  uploadMailInlineImages,
  buildReplyRaw,
  buildNewMailRaw,
  mimeTypeFromFilename,
};
