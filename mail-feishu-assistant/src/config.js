const path = require('node:path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function listFromEnv(name, fallback) {
  const raw = process.env[name] || fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请先在 .env 中填写。`);
  }
  return value;
}

function jsonObjectFromEnv(name, fallback = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    throw new Error(`${name} 必须是完整的 JSON 请求头对象。`);
  }
}

const rootDir = path.resolve(__dirname, '..');

module.exports = {
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  logsDir: path.join(rootDir, 'logs'),
  appId: required('FEISHU_APP_ID'),
  appSecret: required('FEISHU_APP_SECRET'),
  redirectUri: process.env.FEISHU_REDIRECT_URI || 'http://127.0.0.1:3456/callback',
  scopes: (process.env.FEISHU_SCOPES || '').split(/\s+/).filter(Boolean),
  mailboxId: process.env.FEISHU_MAILBOX_ID || '',
  checkCron: process.env.CHECK_CRON || '0 8-22 * * *',
  timezone: process.env.TIMEZONE || 'Asia/Shanghai',
  scanPageSize: Number.parseInt(process.env.SCAN_PAGE_SIZE || '50', 10),
  actionKeywords: listFromEnv(
    'ACTION_KEYWORDS',
    '请谭总,谭总,审批,请审批,同意,请同意,请处理,请确认,确认,申请,批准,续期',
  ),
  noiseKeywords: listFromEnv(
    'NOISE_KEYWORDS',
    '数据详见附件,每日汇总,数据统计,数据日报,验证码,安全提醒,sign up code',
  ),
  notifyReceiveId: process.env.FEISHU_NOTIFY_RECEIVE_ID || '',
  notifyReceiveIdType: process.env.FEISHU_NOTIFY_RECEIVE_ID_TYPE || 'chat_id',
  allowSendEmail: (process.env.ALLOW_SEND_EMAIL || 'true').toLowerCase() === 'true',
  churnSyncCron: process.env.MAIL_CHURN_CRON || '5,15,25,35,45,55 9 * * *',
  churnOutputPath: path.resolve(process.env.MAIL_CHURN_OUTPUT_PATH || path.join(rootDir, '..', 'data', 'private', 'mail-churn-dashboard.json')),
  churnLocalSyncUrl: process.env.MAIL_CHURN_LOCAL_SYNC_URL || 'http://127.0.0.1:8791/api/mail-churn-sync',
  churnServerSyncUrl: process.env.MAIL_CHURN_SERVER_SYNC_URL || '',
  churnServerRequestHeaders: jsonObjectFromEnv('MAIL_CHURN_SERVER_REQUEST_HEADERS'),
};
