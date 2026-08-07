const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { readSheet } = require('read-excel-file/node');
const config = require('./config');
const { listInboxMessages, downloadAttachmentBuffer } = require('./mail');
const { appendLog } = require('./store');

const MAIL_SUBJECT_PREFIX = '外卖业务订单推广统计 - ';
const PLATFORM_FILES = [
  { key: 'meituan', name: '美团外卖', pattern: /^美团订单-数据统计-\d{10}\.xlsx$/ },
  { key: 'taobao', name: '淘宝闪购', pattern: /^淘宝闪购订单-数据统计-\d{10}\.xlsx$/ },
  { key: 'jd', name: '京东外卖', pattern: /^京东订单-数据统计-\d{10}\.xlsx$/ },
];

function textValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return String(value).trim();
}

function numberValue(value) {
  const parsed = Number(String(value ?? 0).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = textValue(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
}

function dateOnly(value) {
  const key = dateKey(value);
  if (key) return key;
  if (typeof value === 'number' && value > 20000) {
    const utc = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    if (!Number.isNaN(utc.getTime())) return utc.toISOString().slice(0, 10);
  }
  return '-';
}

function maskPhone(value) {
  const digits = textValue(value).replace(/\D/g, '');
  return digits.length === 11 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : (digits || '-');
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function roundOne(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function platformMetrics(user, completeDates) {
  const recentDates = completeDates.slice(-7);
  const previousDates = completeDates.slice(-14, -7);
  const displayDates = completeDates.slice(-15);
  const monthDates = completeDates.slice(-30);
  const recentAverage = mean(recentDates.map((day) => numberValue(user.days[day])));
  const previousAverage = mean(previousDates.map((day) => numberValue(user.days[day])));
  const changePct = previousAverage > 0 ? (recentAverage - previousAverage) / previousAverage * 100 : null;
  const monthPoints = monthDates.map((day) => ({ date: day, value: numberValue(user.days[day]) }));
  const maximum = monthPoints.reduce((best, point) => !best || point.value > best.value ? point : best, null);
  const minimum = monthPoints.reduce((best, point) => !best || point.value < best.value ? point : best, null);
  return {
    recentAverage: roundOne(recentAverage),
    previousAverage: roundOne(previousAverage),
    changePct: changePct === null ? null : roundOne(changePct),
    impactOrders: roundOne(recentAverage - previousAverage),
    maximum30: maximum || { date: '', value: 0 },
    minimum30: minimum || { date: '', value: 0 },
    orders15: displayDates.map((day) => ({ date: day, value: numberValue(user.days[day]) })),
    orders30: monthDates.map((day) => ({ date: day, value: numberValue(user.days[day]) })),
  };
}

function parsePlatformRows(rows, platform, sourceFile, mailDay) {
  if (!rows?.length) throw new Error(`${sourceFile} 的“平台联盟”子表为空。`);
  const headerByColumn = new Map();
  const columnByHeader = new Map();
  (rows[0] || []).forEach((raw, index) => {
    const column = index + 1;
    const day = dateKey(raw);
    const header = day || textValue(raw);
    headerByColumn.set(column, header);
    if (header) columnByHeader.set(header, column);
  });
  const allDates = [...headerByColumn.values()].filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  const completeDates = allDates.filter((day) => day < mailDay).slice(-30);
  if (completeDates.length < 14) throw new Error(`${sourceFile} 只有 ${completeDates.length} 个完整日，无法计算两组近7日。`);

  const usersById = new Map();
  for (let rowIndex = 2; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const get = (header) => row[(columnByHeader.get(header) || 0) - 1];
    const id = textValue(get('用户ID'));
    if (!id || id === '0' || id === '合计') continue;
    const current = usersById.get(id) || {
      id,
      accountsId: textValue(get('accounts_id')),
      name: textValue(get('姓名')) || '未填写姓名',
      phone: maskPhone(get('手机号')),
      version: textValue(get('当前版本')) || '-',
      company: textValue(get('公司名称')) || '-',
      registeredAt: dateOnly(get('注册时间')),
      days: {},
    };
    for (const day of completeDates) current.days[day] = numberValue(current.days[day]) + numberValue(get(day));
    usersById.set(id, current);
  }

  const users = [...usersById.values()].map((user) => ({
    id: user.id,
    accountsId: user.accountsId,
    name: user.name,
    phone: user.phone,
    version: user.version,
    company: user.company,
    registeredAt: user.registeredAt,
    ...platformMetrics(user, completeDates),
  }));
  return {
    key: platform.key,
    name: platform.name,
    sourceFile,
    sheetName: '平台联盟',
    completeThrough: completeDates.at(-1),
    completeDates,
    userCount: users.length,
    users,
  };
}

async function parsePlatformWorkbook(buffer, platform, sourceFile, mailDay) {
  let rows;
  try {
    rows = await readSheet(buffer, '平台联盟');
  } catch (error) {
    throw new Error(`${sourceFile} 无法读取“平台联盟”子表：${error.message}`);
  }
  return parsePlatformRows(rows, platform, sourceFile, mailDay);
}

function latestMailDay(message) {
  const fromSubject = String(message?.subject || '').match(/(\d{4})(\d{2})(\d{2})\s*$/);
  if (fromSubject) return `${fromSubject[1]}-${fromSubject[2]}-${fromSubject[3]}`;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Number(message?.internal_date) || Date.now()));
}

function readExistingPayload() {
  try {
    return JSON.parse(fs.readFileSync(config.churnOutputPath, 'utf8'));
  } catch {
    return null;
  }
}

async function postPayload(url, payload) {
  if (!url) return { skipped: true };
  const headers = { ...config.churnServerRequestHeaders };
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  if (!headers['content-encoding']) headers['content-encoding'] = 'gzip';
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.error || `同步接口返回 HTTP ${response.status}`);
  return result;
}

async function pushPayload(payload) {
  const destinations = [...new Set([config.churnLocalSyncUrl, config.churnServerSyncUrl].filter(Boolean))];
  const syncResults = [];
  for (const url of destinations) {
    try {
      syncResults.push({ url, ok: true, result: await postPayload(url, payload) });
    } catch (error) {
      syncResults.push({ url, ok: false, error: error.message });
      appendLog('mail_churn_push_failed', { url, error: error.message });
    }
  }
  return syncResults;
}

async function syncMailChurn({ force = false } = {}) {
  const messages = await listInboxMessages({
    shouldContinue: (pageMessages) => !pageMessages.some((message) => String(message.subject || '').startsWith(MAIL_SUBJECT_PREFIX)),
  });
  const message = messages
    .filter((item) => String(item.subject || '').startsWith(MAIL_SUBJECT_PREFIX))
    .sort((a, b) => Number(b.internal_date || 0) - Number(a.internal_date || 0))[0];
  if (!message) throw new Error(`没有找到主题以“${MAIL_SUBJECT_PREFIX}”开头的邮件。`);

  const existing = readExistingPayload();
  if (!force && existing?.sourceMail?.messageId === message.message_id) {
    const syncResults = await pushPayload(existing);
    return { ok: true, cached: true, payload: existing, syncResults };
  }

  const mailDay = latestMailDay(message);
  const platforms = [];
  for (const platform of PLATFORM_FILES) {
    const attachment = (message.attachments || []).find((item) => platform.pattern.test(String(item.filename || '')));
    if (!attachment?.id) throw new Error(`${message.subject} 缺少“${platform.name}”目标附件。`);
    const buffer = await downloadAttachmentBuffer({
      mailboxId: message.mailboxId,
      messageId: message.message_id,
      attachmentId: attachment.id,
    });
    platforms.push(await parsePlatformWorkbook(buffer, platform, attachment.filename, mailDay));
  }

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    generatedAtText: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: config.timezone }),
    sourceMail: {
      messageId: message.message_id,
      subject: message.subject,
      receivedAt: new Date(Number(message.internal_date) || Date.now()).toISOString(),
      mailDay,
    },
    platforms,
  };
  fs.mkdirSync(path.dirname(config.churnOutputPath), { recursive: true });
  fs.writeFileSync(config.churnOutputPath, JSON.stringify(payload));

  const syncResults = await pushPayload(payload);
  appendLog('mail_churn_synced', {
    subject: message.subject,
    platforms: platforms.map((item) => ({ name: item.name, users: item.userCount, completeThrough: item.completeThrough })),
    destinations: syncResults.map((item) => ({ url: item.url, ok: item.ok })),
  });
  return { ok: true, cached: false, payload, syncResults };
}

module.exports = {
  PLATFORM_FILES,
  parsePlatformWorkbook,
  parsePlatformRows,
  syncMailChurn,
};
