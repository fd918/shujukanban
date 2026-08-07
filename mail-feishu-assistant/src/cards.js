const { mailAddress } = require('./mail');

function safeText(value, fallback = '') {
  return String(value || fallback).trim();
}

function truncateText(value, maxLength) {
  const text = safeText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n（内容较长，已显示前 ${maxLength} 字，后面还有 ${text.length - maxLength} 字未显示）`;
}

function splitText(value, maxLength) {
  const text = safeText(value);
  if (!text) return [''];
  const parts = [];
  for (let index = 0; index < text.length; index += maxLength) {
    parts.push(text.slice(index, index + maxLength));
  }
  return parts;
}

function parseMailDate(value) {
  if (!value) return new Date(NaN);
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const text = String(value);
  if (/^\d+$/.test(text)) return new Date(Number.parseInt(text, 10));
  return new Date(text);
}

function formatMailTime(dateString) {
  const date = parseMailDate(dateString);
  if (Number.isNaN(date.getTime())) return { sentAt: '未知', age: '未知' };
  const sentAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
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

function formatMailBody(message) {
  const rawBody = message.body_plain_text || message.body_preview || '';
  const body = rawBody
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return body || '(无正文内容)';
}

function baseCard({ title, subtitle, template = 'blue', elements = [] }) {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      subtitle
        ? {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: subtitle,
            },
          }
        : null,
      ...elements,
    ].filter(Boolean),
  };
}

function md(content) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content,
    },
  };
}

function divider() {
  return { tag: 'hr' };
}

function actionButtons(actions) {
  return {
    tag: 'action',
    actions: actions.map((item) => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: item.text,
      },
      type: item.type || 'default',
      value: item.value,
    })),
  };
}

function imageElements(images = []) {
  return images.map((image) => ({
    tag: 'img',
    img_key: image.imageKey,
    alt: {
      tag: 'plain_text',
      content: image.filename || '邮件图片',
    },
    title: {
      tag: 'plain_text',
      content: image.filename || '邮件图片',
    },
    mode: 'fit_horizontal',
    preview: true,
  }));
}

function attachmentSummary(message) {
  const attachments = message.attachments || [];
  if (attachments.length === 0) return '';
  const inline = attachments.filter((item) => item.is_inline).length;
  const normal = attachments.length - inline;
  const names = attachments
    .map((item) => item.filename)
    .filter(Boolean)
    .slice(0, 6)
    .join('、');
  return [
    `**附件/图片**：共 ${attachments.length} 个${inline ? `，其中内嵌图片 ${inline} 个` : ''}${normal ? `，普通附件 ${normal} 个` : ''}`,
    names ? `**文件名**：${names}${attachments.length > 6 ? ' 等' : ''}` : null,
  ].filter(Boolean).join('\n');
}

function buildMailNoticeCard(code, message, options = {}) {
  const timeInfo = formatMailTime(message.internal_date);
  const subject = safeText(message.subject, '(无主题)');
  const body = options.body || formatMailBody(message);
  const partText = options.partCount > 1 ? `（第 ${options.partIndex + 1}/${options.partCount} 部分）` : '';
  const summary = attachmentSummary(message);
  const images = options.images || [];
  return baseCard({
    title: `待处理邮件：${code}${partText}`,
    subtitle: `**${subject}**`,
    template: 'blue',
    elements: [
      md(`**发送时间**：${timeInfo.sentAt}（已过 ${timeInfo.age}）\n**发件人**：${mailAddress(message.head_from)}\n**主题**：${subject}`),
      summary ? md(summary) : null,
      divider(),
      md(`**正文全文${partText}**\n${body}`),
      options.partIndex === 0 && images.length > 0 ? divider() : null,
      ...(options.partIndex === 0 ? imageElements(images) : []),
      divider(),
      options.showActions === false ? null : actionButtons([
        { text: '回复全部', type: 'primary', value: { type: 'mail_action', action: '回复全部', code } },
        { text: '回复', value: { type: 'mail_action', action: '回复', code } },
        { text: '忽略', type: 'danger', value: { type: 'mail_action', action: '忽略', code } },
        { text: '查看待处理', value: { type: 'list_pending' } },
      ]),
      options.showActions === false ? null : md('点击 **回复全部** 或 **回复** 后，直接在聊天框输入回复内容。'),
    ].filter(Boolean),
  });
}

function buildMailNoticeCards(code, message, options = {}) {
  const parts = splitText(formatMailBody(message), 8000);
  return parts.map((body, index) => buildMailNoticeCard(code, message, {
    body,
    partIndex: index,
    partCount: parts.length,
    showActions: index === 0,
    images: options.images || [],
  }));
}

function buildMailWaitingCard(record, action) {
  return baseCard({
    title: `等待输入：${record.id}`,
    subtitle: `已选择 **${action}**。请直接在聊天框发送本次邮件回复内容。`,
    template: 'orange',
    elements: [
      md(`**主题**：${safeText(record.subject, '(无主题)')}\n**发件人**：${mailAddress(record.from)}`),
      divider(),
      md('示例：\n同意开通\n\n如果不想继续，请发送：取消回复'),
    ],
  });
}

function buildMailHandledCard(record, { action, body }) {
  const isIgnored = action === '忽略';
  return baseCard({
    title: `${record.id} ${isIgnored ? '已忽略' : `已${action}`}`,
    subtitle: `**${safeText(record.subject, '(无主题)')}**`,
    template: isIgnored ? 'grey' : 'green',
    elements: [
      md(`**发件人**：${mailAddress(record.from)}\n**处理结果**：${isIgnored ? '已标记忽略' : action}`),
      body ? divider() : null,
      body ? md(`**发送内容**\n${truncateText(body, 3000)}`) : null,
    ].filter(Boolean),
  });
}

function buildScanSummaryCard(label, mailboxId, result) {
  return baseCard({
    title: `已完成${label}巡检`,
    subtitle: mailboxId ? `检查邮箱：${mailboxId}` : '',
    template: result.candidates.length > 0 || result.pendingToday > 0 ? 'orange' : 'green',
    elements: [
      md([
        `**本次接口读取**：${result.fetchedTotal} 封`,
        `**其中今日邮件**：${result.checkedToday} 封`,
        `**今日已处理**：${result.processedToday} 封`,
        `**今日待处理**：${result.pendingToday} 封`,
        `**新发现待处理**：${result.candidates.length} 封`,
      ].join('\n')),
      result.pendingToday > 0 ? divider() : null,
      result.pendingToday > 0 ? actionButtons([
        { text: '查看待处理', type: 'primary', value: { type: 'list_pending' } },
      ]) : null,
    ],
  });
}

function buildPendingListCard(records) {
  const lines = records.length === 0
    ? ['当前没有待处理邮件。']
    : records.map((record, index) => `${index + 1}. **${record.id}** ${safeText(record.subject, '(无主题)')}`);
  const detailButtons = records.slice(0, 5).map((record, index) => ({
    text: `查看 ${index + 1}`,
    type: index === 0 ? 'primary' : 'default',
    value: { type: 'pending_detail', code: record.id },
  }));
  return baseCard({
    title: `当前待处理邮件：${records.length} 封`,
    template: records.length > 0 ? 'orange' : 'green',
    elements: [
      md(lines.join('\n')),
      records.length > 0 ? divider() : null,
      detailButtons.length > 0 ? actionButtons(detailButtons) : null,
      records.length > 0 ? md([
        '点击上方 **查看 1**、**查看 2** 可显示对应邮件详情。',
        '如果按钮暂时不可用，也可以直接发送编号，例如：`1` 或 `查看待处理 1`。',
        records.length > 5 ? '当前按钮只显示前 5 封，其余邮件请发送对应编号查看。' : null,
      ].filter(Boolean).join('\n')) : null,
    ].filter(Boolean),
  });
}

function buildInfoCard(title, lines, template = 'blue') {
  return baseCard({
    title,
    template,
    elements: [md(lines.filter(Boolean).join('\n'))],
  });
}

function buildConfigCard(binding, authStatus, keywordsText, scheduleText) {
  return baseCard({
    title: '当前配置',
    template: binding?.mailboxId && authStatus?.authorized ? 'green' : 'orange',
    elements: [
      md([
        `**绑定状态**：${binding?.mailboxId ? '已绑定' : '未绑定'}`,
        `**绑定邮箱**：${binding?.mailboxId || '未绑定'}`,
        `**授权状态**：${authStatus?.authorized ? `已授权${authStatus.mailboxId ? `（${authStatus.mailboxId}）` : ''}` : '未授权'}`,
        authStatus?.updatedAt ? `**授权更新时间**：${authStatus.updatedAt}` : null,
        authStatus?.error ? `**授权检查失败**：${authStatus.error}` : null,
        `**巡检关键词**：${keywordsText}`,
        `**定时巡检时间**：${scheduleText}`,
      ].filter(Boolean).join('\n')),
      divider(),
      md('可用指令：绑定我、授权我、查看配置、巡检、查看待处理、设置关键词、重置关键词、设置巡检时间、重置巡检时间'),
    ],
  });
}

module.exports = {
  buildMailNoticeCard,
  buildMailNoticeCards,
  buildMailWaitingCard,
  buildMailHandledCard,
  buildScanSummaryCard,
  buildPendingListCard,
  buildInfoCard,
  buildConfigCard,
  formatMailBody,
  formatMailTime,
};
