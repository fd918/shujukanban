import { createHash, createHmac, createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, appendFile, rename, copyFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const BASE_URL = "https://adminalliance.yunzhanxinxi.com";
const PORT = Number(process.env.DASHBOARD_PORT || 8791);
const HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, "data/business-dashboard-config.json");
const SNAPSHOT_PATH = join(ROOT, "data/business-dashboard-snapshots.jsonl");
const DASHBOARD_CACHE_PATH = join(ROOT, "data/business-dashboard-cache.json");
const USER_PHONE_INDEX_PATH = join(ROOT, "data/user-phone-index.json");
const USER_DETAIL_CACHE_PATH = join(ROOT, "data/business-user-detail-cache.json");
const FOCUS_USERS_PATH = join(ROOT, "data/business-focus-users.json");
const FOCUS_USERS_BACKUP_PATH = join(ROOT, "data/business-focus-users.pre-global-backup.json");
const USER_ALIASES_PATH = join(ROOT, "data/business-user-aliases.json");
const USER_REFRESH_STATE_PATH = join(ROOT, "data/business-user-refresh-state.json");
const API_REQUEST_STATS_PATH = join(ROOT, "data/business-api-request-stats.json");
const PUBLIC_DASHBOARD_PATH = join(ROOT, "data/business-dashboard-public.enc.json");
const PUBLIC_FOCUS_NOTES_PATH = join(ROOT, "data/business-focus-notes-public.enc.json");
const PUBLIC_GLOBAL_USER_INDEX_PATH = join(ROOT, "data/business-global-user-index.enc.json");
const PUBLIC_USER_DETAIL_DIR = join(ROOT, "data/business-public-users");
const USER_SERVICE = "com.tanwenjie.yunzhan-business-dashboard.username";
const PASS_SERVICE = "com.tanwenjie.yunzhan-business-dashboard.password";
const FEISHU_WEBHOOK_SERVICE = "com.tanwenjie.business-dashboard.feishu.webhook";
const FEISHU_SECRET_SERVICE = "com.tanwenjie.business-dashboard.feishu.secret";
const PUBLIC_PASSWORD_SERVICE = "com.tanwenjie.business-dashboard.public.password";
const SNAPSHOT_RETENTION_DAYS = 8;
const PUBLIC_KDF_ITERATIONS = 60000;
const T1_USER_BUSINESS_IDS = new Set(["2410"]);

let token = process.env.YZ_DASHBOARD_TOKEN || "";
let tokenExpiresAt = 0;
let snapshotTimer = null;
let snapshotScheduleVersion = 0;
let snapshotRecordQueue = Promise.resolve();
let lastSnapshotAt = 0;
let lastSnapshotSlotKey = "";
let lastSnapshotPruneDay = "";
let lastGood = { businesses: [], users: [], summary: null, hourlyTrend: [] };
const userDetailCache = new Map();
let userDetailCacheSavedAtText = "";
const userPhoneCache = new Map();
const userProfileCache = new Map();
let userPhoneIndexLoadedAt = 0;
let userPhoneIndexPromise = null;
let userPhoneIndexComplete = false;
let userPhoneIndexTotal = 0;
let lastOperationalAlert = { key: "", at: 0 };
let startupWarmupRunning = false;
let publicHistoryWarmupRunning = false;
let detailCacheSaveTimer = null;
let requestStatsSaveTimer = null;
let requestStats = { day: dayKey(), total: 0, byPath: {}, byName: {}, updatedAt: "" };
let userRefreshState = { scheduledRuns: {}, top100: {} };
let publicPublishQueue = Promise.resolve();

const defaultConfig = {
  rules: {
    minorPct: 15,
    minorOrders: 50,
    majorPct: 25,
    majorOrders: 200,
    criticalPct: 40,
    criticalOrders: 500,
    upPct: 50,
    upOrders: 500
  },
  refreshSeconds: 60,
  snapshotMinutes: 30,
  userRefreshTimes: ["12:00", "17:00", "22:00"],
  fastUserBusinessIds: [],
  notification: {
    mode: "immediate",
    criticalImmediate: true,
    enabled: false,
    snapshotAlert: true,
    events: {
      startupWarmupFailed: true,
      snapshotRecordFailed: true,
      apiDataMissing: true,
      businessEmpty: true,
      ordersZero: true,
      businessDataStale: true,
      publicPublishFailed: true
    }
  },
  public: {
    autoPush: true
  }
};

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function json(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true"
  });
  res.end(JSON.stringify(data));
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = type => parts.find(item => item.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseDay(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return dayKey();
}

function dateFromDay(value) {
  const [year, month, day] = parseDay(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftDay(value, days) {
  return dayKey(addDays(dateFromDay(value), days));
}

function daysBetweenInclusive(startDate, endDate) {
  return Math.max(1, Math.round((dateFromDay(endDate) - dateFromDay(startDate)) / 86400000) + 1);
}

function dayList(startDate, endDate) {
  const days = daysBetweenInclusive(startDate, endDate);
  return Array.from({ length: days }, (_, index) => dayKey(addDays(dateFromDay(startDate), index)));
}

function rangeFromQuery(query = {}) {
  const preset = query.preset || "today";
  const today = dayKey();
  const build = (startDate, endDate, label) => {
    const days = daysBetweenInclusive(startDate, endDate);
    const previousEndDate = shiftDay(startDate, -1);
    const previousStartDate = shiftDay(previousEndDate, -(days - 1));
    const isTodaySingleDay = days === 1 && endDate === today;
    return {
      preset,
      startDate,
      endDate,
      label,
      previousStartDate,
      previousEndDate,
      baselineLabel: days === 1 ? (isTodaySingleDay ? "前一日同时刻" : "前一日整天") : "上一周期",
      days
    };
  };
  if (query.start_date || query.startDate || query.end_date || query.endDate) {
    const startDate = parseDay(query.start_date || query.startDate || today);
    const endDate = parseDay(query.end_date || query.endDate || startDate);
    let label = startDate === endDate ? startDate : `${startDate} 至 ${endDate}`;
    if (preset === "today") label = "今日";
    if (preset === "yesterday") label = "昨日";
    if (preset === "7") label = "近7日";
    return build(startDate, endDate, label);
  }
  if (preset === "yesterday") {
    const yesterday = shiftDay(today, -1);
    return build(yesterday, yesterday, "昨日");
  }
  if (preset === "7") return build(shiftDay(today, -6), today, "近7日");
  const startDate = parseDay(query.start_date || query.startDate || today);
  const endDate = parseDay(query.end_date || query.endDate || startDate);
  return build(startDate, endDate, startDate === endDate ? startDate : `${startDate} 至 ${endDate}`);
}

function minuteOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  return Number(parts.find(item => item.type === "hour")?.value || 0) * 60 + Number(parts.find(item => item.type === "minute")?.value || 0);
}

function snapshotSlot(date = new Date(), intervalMinutes = 30) {
  const interval = Math.max(1, Number(intervalMinutes || 30));
  const minute = Math.floor(minuteOfDay(date) / interval) * interval;
  const hourText = String(Math.floor(minute / 60)).padStart(2, "0");
  const minuteText = String(minute % 60).padStart(2, "0");
  const day = dayKey(date);
  return {
    day,
    minuteOfDay: minute,
    key: `${day}-${String(minute).padStart(4, "0")}`,
    label: `${day} ${hourText}:${minuteText}`
  };
}

function nextSnapshotDelayMs(intervalMinutes = 30) {
  const interval = Math.max(1, Number(intervalMinutes || 30));
  const now = new Date();
  const minute = minuteOfDay(now);
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();
  let nextMinute = (Math.floor(minute / interval) + 1) * interval;
  if (minute % interval === 0 && seconds < 10) nextMinute = minute;
  const next = new Date(now);
  if (nextMinute >= 1440) {
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 1, 0);
  } else {
    next.setHours(Math.floor(nextMinute / 60), nextMinute % 60, nextMinute === minute ? Math.max(seconds + 1, 1) : 1, 0);
  }
  return Math.max(1000, next.getTime() - now.getTime() - milliseconds);
}

function expectedSnapshotSlots(day = dayKey(), intervalMinutes = 30) {
  const interval = Math.max(1, Number(intervalMinutes || 30));
  return Array.from({ length: Math.ceil(1440 / interval) }, (_, index) => {
    const minute = index * interval;
    const hourText = String(Math.floor(minute / 60)).padStart(2, "0");
    const minuteText = String(minute % 60).padStart(2, "0");
    return {
      day,
      minuteOfDay: minute,
      key: `${day}-${String(minute).padStart(4, "0")}`,
      label: `${day} ${hourText}:${minuteText}`
    };
  });
}

function manualSnapshotSlot(date = new Date()) {
  const minute = minuteOfDay(date);
  const hourText = String(Math.floor(minute / 60)).padStart(2, "0");
  const minuteText = String(minute % 60).padStart(2, "0");
  const day = dayKey(date);
  return {
    day,
    minuteOfDay: minute,
    key: `${day}-manual-${Date.now()}`,
    label: `${day} 手动 ${hourText}:${minuteText}`
  };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function number(value) {
  const n = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function pickArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function readSecret(service) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-a", "default", "-s", service, "-w"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function writeSecret(service, value) {
  if (!value) return;
  await execFileAsync("/usr/bin/security", ["add-generic-password", "-U", "-a", "default", "-s", service, "-w", value]);
}

async function loginWithCredentials(user, pass) {
  if (!user || !pass) throw new Error("请填写中台账号和密码。");
  const response = await fetchWithTimeout(`${BASE_URL}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "origin": "https://adminpub.yunzhanxinxi.com",
      "referer": "https://adminpub.yunzhanxinxi.com/"
    },
    body: new URLSearchParams({ usrName: user, passWord: md5(`YZ_ADMIN_${pass}`) })
  }, 10000);
  const payload = await response.json().catch(() => ({}));
  if (payload.code !== 200 || !payload.data?.access_token) throw new Error(payload.message || "中台登录失败，请检查账号密码。");
  return payload.data.access_token;
}

async function readConfig() {
  try {
    const saved = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    const savedNotification = saved.notification || {};
    const config = {
      ...defaultConfig,
      ...saved,
      rules: { ...defaultConfig.rules, ...(saved.rules || {}) },
      notification: {
        ...defaultConfig.notification,
        ...savedNotification,
        events: { ...defaultConfig.notification.events, ...(savedNotification.events || {}) }
      },
      public: { ...defaultConfig.public, ...(saved.public || {}) }
    };
    const refreshTimes = normalizeRefreshTimes(config.userRefreshTimes);
    config.userRefreshTimes = refreshTimes.length ? refreshTimes : [...defaultConfig.userRefreshTimes];
    return config;
  } catch {
    return defaultConfig;
  }
}

async function writeConfig(nextConfig) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  const nextNotification = nextConfig.notification || {};
  const config = {
    ...defaultConfig,
    ...nextConfig,
    rules: { ...defaultConfig.rules, ...(nextConfig.rules || {}) },
    notification: {
      ...defaultConfig.notification,
      ...nextNotification,
      events: { ...defaultConfig.notification.events, ...(nextNotification.events || {}) }
    },
    public: { ...defaultConfig.public, ...(nextConfig.public || {}) }
  };
  const refreshTimes = normalizeRefreshTimes(config.userRefreshTimes);
  config.userRefreshTimes = refreshTimes.length ? refreshTimes : [...defaultConfig.userRefreshTimes];
  config.fastUserBusinessIds = Array.from(new Set((config.fastUserBusinessIds || []).map(String).filter(Boolean)));
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  scheduleSnapshots();
  return config;
}

function normalizeRefreshTimes(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,，\s]+/);
  return Array.from(new Set(source.map(item => String(item).trim()).filter(item => /^([01]\d|2[0-3]):[0-5]\d$/.test(item)))).sort();
}

function scheduleJsonWrite(path, getValue, timerName) {
  if (timerName === "requests" && requestStatsSaveTimer) return;
  if (timerName === "requests") requestStatsSaveTimer = setTimeout(async () => {
    requestStatsSaveTimer = null;
    await mkdir(join(ROOT, "data"), { recursive: true });
    await writeFile(path, JSON.stringify(getValue(), null, 2));
  }, 1000);
}

function recordApiRequest(name, path) {
  const today = dayKey();
  if (requestStats.day !== today) requestStats = { day: today, total: 0, byPath: {}, byName: {}, updatedAt: "" };
  requestStats.total += 1;
  requestStats.byPath[path] = number(requestStats.byPath[path]) + 1;
  requestStats.byName[name] = number(requestStats.byName[name]) + 1;
  requestStats.updatedAt = nowText();
  scheduleJsonWrite(API_REQUEST_STATS_PATH, () => requestStats, "requests");
}

async function loadRequestStats() {
  try {
    const saved = JSON.parse(await readFile(API_REQUEST_STATS_PATH, "utf8"));
    if (saved.day === dayKey()) requestStats = saved;
  } catch {}
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function login() {
  if (token && Date.now() < tokenExpiresAt) return token;
  const user = process.env.YZ_DASHBOARD_USER || await readSecret(USER_SERVICE);
  const pass = process.env.YZ_DASHBOARD_PASS || await readSecret(PASS_SERVICE);
  if (!user || !pass) throw new Error("本地服务缺少中台账号密码，请在桌面入口写入钥匙串账号。");
  token = await loginWithCredentials(user, pass);
  tokenExpiresAt = Date.now() + 20 * 60 * 1000;
  return token;
}

async function apiCall(name, method, path, data, timeoutMs = 12000) {
  const startedAt = Date.now();
  recordApiRequest(name, path);
  try {
    const auth = await login();
    const url = new URL(`${BASE_URL}${path}`);
    const options = {
      method,
      headers: {
        "authorization": `Bearer ${auth}`,
        "origin": "https://adminpub.yunzhanxinxi.com",
        "referer": "https://adminpub.yunzhanxinxi.com/"
      }
    };
    if (method === "GET") {
      Object.entries(data || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
      });
    } else {
      options.headers["content-type"] = "application/json;charset=UTF-8";
      options.body = JSON.stringify(data || {});
    }
    const response = await fetchWithTimeout(url, options, timeoutMs);
    const payload = await response.json();
    const ok = response.ok && payload.code === 200;
    return { name, ok, status: response.status, code: payload.code, message: payload.message || (ok ? "成功" : "接口返回异常"), durationMs: Date.now() - startedAt, data: payload.data };
  } catch (error) {
    return { name, ok: false, message: error.name === "AbortError" ? "接口超时" : error.message, durationMs: Date.now() - startedAt, data: null };
  }
}

function normalizeBusiness(row) {
  return {
    platform: row.platform || "未分类",
    name: row.business_name || `业务 ${row.business_id || ""}`.trim(),
    businessId: row.business_id || "",
    platformBusinessId: row.platform_business_id || "",
    users: number(row.promotion_users),
    todayOrders: number(row.today_orders),
    yesterdayOrders: number(row.yesterday_orders),
    sevenDaysOrders: number(row.seven_days_orders),
    thirtyDaysOrders: number(row.thirty_days_orders),
    totalOrders: number(row.total_orders),
    yesterdayRatio: row.yesterday_ratio || "",
    sevenDaysRatio: row.seven_days_ratio || ""
  };
}

function normalizeBusinessCatalog(row, dateRange) {
  return {
    platform: row.platform || "未分类",
    name: row.business_name || `业务 ${row.business_id || ""}`.trim(),
    businessId: String(row.business_type || row.order_type || row.business_id || ""),
    platformBusinessId: String(row.business_id || row.platform_business_id || ""),
    users: number(row.promotion_users),
    userIds: [],
    currentLabel: dateRange.label,
    currentDateKey: dateRange.startDate === dateRange.endDate ? dateRange.endDate : "period_total",
    todayOrders: number(row.today_orders),
    yesterdayOrders: number(row.yesterday_orders),
    yesterdaySameTimeOrders: 0,
    totalOrders: number(row.total_orders),
    todayCommission: 0,
    yesterdayCommission: 0,
    yesterdaySameTimeCommission: 0,
    todayAmount: 0,
    source: "中台业务列表"
  };
}

function normalizeUser(row, dateKeyValue = "") {
  const current = dateKeyValue && row[dateKeyValue] !== undefined ? row[dateKeyValue] : row.period_total;
  return {
    name: row.nickname || "未填写昵称",
    id: String(row.uid || row.promotion_id || row.accounts_id || ""),
    accountsId: String(row.accounts_id || ""),
    phone: row.phone || row.telephone || "-",
    version: row.packages_name || row.packages || "-",
    expireAt: row.package_exp_time || "-",
    registeredAt: row.register_time || "-",
    company: row.real_name || "-",
    paid: number(row.withdraw_amount || row.balance_amount),
    todayAmount: number(row.today_amount),
    yesterdayAmount: number(row.yesterday_amount),
    todayCommission: number(row.today_amount),
    yesterdayCommission: number(row.yesterday_amount),
    todayOrders: number(current ?? row.today_order_num),
    yesterdayOrders: number(row.yesterday_order_num),
    beforeYesterdayOrders: number(row.before_yesterday_order_num),
    last7dOrders: number(row.last7d_order_num),
    prev7dOrders: number(row.prev7d_order_num),
    commission: number(row.last7d_amount || row.today_amount),
    source: "中台用户数据"
  };
}

function userCompareLevel(row, rules) {
  const today = number(row.todayOrders);
  const base = number(row.yesterdayOrders);
  const diff = today - base;
  const impact = Math.abs(diff);
  const ratio = base ? diff / base * 100 : today ? 100 : 0;
  if (!base && !today) return "missing";
  if (diff > 0 && ratio >= rules.upPct && impact >= rules.upOrders) return "up";
  if (diff < 0) {
    const drop = Math.abs(ratio);
    if (today === 0 && base > 0) return "critical";
    if (drop >= rules.criticalPct || impact >= rules.criticalOrders) return "critical";
    if (drop >= rules.majorPct && impact >= rules.majorOrders) return "major";
    if (drop >= rules.minorPct && impact >= rules.minorOrders) return "minor";
  }
  return "normal";
}

async function fetchPlainPhone(uid) {
  const id = String(uid || "");
  if (!id) return "";
  if (userPhoneCache.has(id)) return userPhoneCache.get(id);
  await ensureUserPhoneIndex();
  return userPhoneCache.get(id) || "";
}

function plainPhoneValue(userId, ...candidates) {
  const indexed = String(userPhoneCache.get(String(userId || "")) || "");
  if (/^1\d{10}$/.test(indexed)) return indexed;
  const candidate = candidates.map(value => String(value || "")).find(value => /^1\d{10}$/.test(value));
  return candidate || "-";
}

function attachPlainPhone(row) {
  return { ...row, phone: plainPhoneValue(row?.id, row?.phone) };
}

function refreshCachedPlainPhones() {
  let changed = false;
  for (const payload of userDetailCache.values()) {
    if (!Array.isArray(payload?.rows)) continue;
    payload.rows = payload.rows.map(row => {
      const phone = plainPhoneValue(row.id, row.phone);
      if (phone !== row.phone) changed = true;
      return { ...row, phone };
    });
  }
  if (changed) scheduleUserDetailCacheSave();
}

async function loadUserPhoneIndexFromDisk() {
  if (!existsSync(USER_PHONE_INDEX_PATH)) return false;
  try {
    const saved = JSON.parse(await readFile(USER_PHONE_INDEX_PATH, "utf8"));
    const phones = saved.phones || {};
    Object.entries(phones).forEach(([id, phone]) => {
      if (/^1\d{10}$/.test(String(phone))) userPhoneCache.set(String(id), String(phone));
    });
    const profiles = saved.profiles || {};
    Object.entries(profiles).forEach(([id, profile]) => {
      userProfileCache.set(String(id), {
        name: String(profile.name || ""),
        phone: plainPhoneValue(id, profile.phone, phones[id])
      });
    });
    userPhoneIndexComplete = saved.complete === true;
    userPhoneIndexTotal = number(saved.indexedTotal || saved.total || userPhoneCache.size);
    userPhoneIndexLoadedAt = userPhoneCache.size && userProfileCache.size ? Date.now() : 0;
    return userPhoneCache.size > 0 && userProfileCache.size > 0;
  } catch {
    return false;
  }
}

async function writeUserPhoneIndexToDisk() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(USER_PHONE_INDEX_PATH, JSON.stringify({
    savedAt: new Date().toISOString(),
    savedAtText: nowText(),
    complete: userPhoneIndexComplete,
    indexedTotal: userPhoneIndexTotal,
    source: "/api/v2/dashboard/summary/index",
    phones: Object.fromEntries(userPhoneCache),
    profiles: Object.fromEntries(userProfileCache)
  }, null, 2));
}

async function loadUserDetailCacheFromDisk() {
  if (!existsSync(USER_DETAIL_CACHE_PATH)) return false;
  try {
    const saved = JSON.parse(await readFile(USER_DETAIL_CACHE_PATH, "utf8"));
    Object.entries(saved.items || {}).forEach(([key, value]) => {
      if (Array.isArray(value?.rows)) userDetailCache.set(key, value);
    });
    userDetailCacheSavedAtText = saved.savedAtText || "";
    return userDetailCache.size > 0;
  } catch {
    return false;
  }
}

async function writeUserDetailCacheToDisk() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  const entries = Array.from(userDetailCache.entries()).slice(-300);
  userDetailCacheSavedAtText = nowText();
  await writeFile(USER_DETAIL_CACHE_PATH, JSON.stringify({
    savedAt: new Date().toISOString(),
    savedAtText: userDetailCacheSavedAtText,
    items: Object.fromEntries(entries)
  }, null, 2));
}

function scheduleUserDetailCacheSave() {
  if (detailCacheSaveTimer) clearTimeout(detailCacheSaveTimer);
  detailCacheSaveTimer = setTimeout(() => {
    writeUserDetailCacheToDisk().catch(error => console.error(`[${nowText()}] 保存用户明细缓存失败：${error.message}`));
  }, 1500);
}

async function ensureUserPhoneIndex(statuses = []) {
  if (userPhoneIndexComplete && userPhoneCache.size && userProfileCache.size && Date.now() - userPhoneIndexLoadedAt < 24 * 60 * 60 * 1000) return;
  if (!userPhoneCache.size && await loadUserPhoneIndexFromDisk()) {
    refreshCachedPlainPhones();
    if (userPhoneIndexComplete) {
      statuses.push({ name: "用户明文手机号索引", ok: true, message: `使用完整本地索引：${userPhoneCache.size} 个手机号`, durationMs: 0 });
      return;
    }
  }
  if (userPhoneIndexPromise) return userPhoneIndexPromise;
  userPhoneIndexPromise = (async () => {
    const startedAt = Date.now();
    const first = await apiCall("完整用户手机号索引第1页", "POST", "/api/v2/dashboard/summary/index", { page: 1 }, 25000);
    if (!first.ok) {
      statuses.push(first);
      return;
    }
    const firstRows = asList(first.data);
    const total = number(first.data?.total);
    const pageSize = Math.max(1, number(first.data?.pageSize) || firstRows.length || 30);
    const totalPages = Math.min(1200, Math.max(1, Math.ceil(total / pageSize)));
    const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    const rest = await mapLimit(pages, 8, page => apiCall(`完整用户手机号索引第${page}页`, "POST", "/api/v2/dashboard/summary/index", { page }, 25000));
    const rows = firstRows.concat(...rest.filter(item => item.ok).map(item => asList(item.data)));
    rows.forEach(row => {
      const id = String(row.promotion_id || row.uid || row.accounts_id || "");
      const phone = String(row.telephone || row.phone || "");
      if (id && /^1\d{10}$/.test(phone)) userPhoneCache.set(id, phone);
      if (id) userProfileCache.set(id, { name: String(row.nickname || ""), phone: plainPhoneValue(id, phone) });
    });
    const failed = rest.filter(item => !item.ok).length;
    userPhoneIndexComplete = failed === 0 && rows.length >= total;
    userPhoneIndexTotal = total;
    userPhoneIndexLoadedAt = Date.now();
    refreshCachedPlainPhones();
    await writeUserPhoneIndexToDisk();
    statuses.push({
      name: "用户明文手机号索引",
      ok: userPhoneIndexComplete,
      message: `已从完整用户列表索引 ${userPhoneCache.size}/${total} 个手机号${failed ? `，${failed} 页失败` : ""}`,
      durationMs: Date.now() - startedAt
    });
  })().finally(() => {
    userPhoneIndexPromise = null;
  });
  return userPhoneIndexPromise;
}

function attachBusinessUserSearchText(businesses) {
  return businesses.map(row => {
    const searchText = (row.userIds || []).map(id => {
      const profile = userProfileCache.get(String(id));
      return profile ? `${id}${profile.name}${profile.phone}` : String(id);
    }).join(" ");
    return { ...row, userSearchText: searchText };
  });
}

function normalizeBusinessSummary(row, dateRange, metricRows = {}, previousRows = {}) {
  const dateKeyValue = dateRange.startDate === dateRange.endDate ? dateRange.endDate : "period_total";
  const currentOrders = number(row[dateKeyValue] ?? row.period_total ?? row.total);
  const id = String(row.order_type || row.business_id || row.subtitle || "");
  const metric = metricRows[id] || {};
  return {
    platform: row.title || row.platform || "未分类",
    name: row.subtitle || row.business_name || "未命名业务",
    businessId: id,
    platformBusinessId: String(row.order_category_id || row.platform_business_id || ""),
    users: number(row.users),
    userIds: Array.isArray(row.user_ids) ? row.user_ids : [],
    currentLabel: dateRange.label,
    currentDateKey: dateKeyValue,
    todayOrders: currentOrders,
    yesterdayOrders: number(previousRows.orders?.[id]),
    yesterdaySameTimeOrders: number(previousRows.sameTimeOrders?.[id]),
    totalOrders: number(row.total),
    todayCommission: number(metric.commission?.[dateKeyValue] ?? metric.commission?.period_total ?? metric.commission?.total),
    yesterdayCommission: number(previousRows.commission?.[id]),
    yesterdaySameTimeCommission: number(previousRows.sameTimeCommission?.[id]),
    todayAmount: number(metric.amount?.[dateKeyValue] ?? metric.amount?.period_total ?? metric.amount?.total),
    source: "中台业务数据总览"
  };
}

function dashboardCacheKey(dateRange) {
  return `${dateRange.startDate}_${dateRange.endDate}`;
}

async function readDashboardCache() {
  if (!existsSync(DASHBOARD_CACHE_PATH)) return {};
  try {
    return JSON.parse(await readFile(DASHBOARD_CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeDashboardCache(key, payload) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  const cache = await readDashboardCache();
  cache[key] = {
    savedAt: new Date().toISOString(),
    savedAtText: nowText(),
    payload
  };
  const entries = Object.entries(cache).slice(-30);
  await writeFile(DASHBOARD_CACHE_PATH, JSON.stringify(Object.fromEntries(entries), null, 2));
}

function latestValidDashboardCache(cache) {
  return Object.entries(cache)
    .filter(([, value]) => Array.isArray(value?.payload?.businesses) && value.payload.businesses.length)
    .sort((a, b) => String(b[1].savedAt || "").localeCompare(String(a[1].savedAt || "")))[0] || null;
}

function normalizeHourlyTrend(rows) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));
  for (const item of rows || []) {
    const hour = Number(String(item.paid_date || item.hour || "").slice(0, 2));
    if (Number.isFinite(hour) && hour >= 0 && hour < 24) buckets[hour].orders += number(item.value ?? item.orders);
  }
  return buckets;
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await task(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchBusinessPages(statuses) {
  const first = await apiCall("业务列表", "GET", "/api/v2/dashboard/business/list", { page: 1, pre_page: 100, order_type: "" }, 15000);
  statuses.push(first);
  if (!first.ok) return { rows: [], timePeriods: null };
  const rows = asList(first.data);
  const totalPages = Math.min(Number(first.data?.total_pages || 1), 30);
  const requests = [];
  for (let page = 2; page <= totalPages; page += 1) {
    requests.push(apiCall(`业务列表第${page}页`, "GET", "/api/v2/dashboard/business/list", { page, pre_page: 100, order_type: "" }, 15000));
  }
  const rest = await Promise.all(requests);
  rest.forEach(item => statuses.push(item));
  rest.filter(item => item.ok).forEach(item => rows.push(...asList(item.data)));
  return { rows, timePeriods: first.data?.time_periods || null };
}

async function fetchBusinessSummary(dateRange, statuses) {
  const payload = { platform: "", paid_date: [dateRange.startDate, dateRange.endDate] };
  const previousPayload = { platform: "", paid_date: [dateRange.previousStartDate, dateRange.previousEndDate] };
  const [orders, commission, amount, trend, previousOrders, previousCommission] = await Promise.all([
    apiCall("业务汇总-按订单", "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "order_valid" }, 20000),
    apiCall("业务汇总-按佣金", "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "settle_amount_valid" }, 20000),
    apiCall("业务汇总-按成交金额", "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "amount_valid" }, 20000),
    apiCall("业务小时趋势", "POST", "/api/v2/order-statistic/trend-new", { ...payload, filter_field: "order_count" }, 20000),
    apiCall("业务汇总-前一日订单", "POST", "/api/v2/order-statistic/summary-new", { ...previousPayload, filter_field: "order_valid" }, 20000),
    apiCall("业务汇总-前一日佣金", "POST", "/api/v2/order-statistic/summary-new", { ...previousPayload, filter_field: "settle_amount_valid" }, 20000)
  ]);
  statuses.push(orders, commission, amount, trend, previousOrders, previousCommission);

  const rows = pickArray(orders.data);
  const byId = {};
  for (const [key, result] of [["commission", commission], ["amount", amount]]) {
    pickArray(result.data).forEach(row => {
      const id = String(row.order_type || row.business_id || row.subtitle || "");
      byId[id] ||= {};
      byId[id][key] = row;
    });
  }
  const previousRows = { orders: {}, commission: {} };
  pickArray(previousOrders.data).forEach(row => {
    const key = dateRange.previousStartDate === dateRange.previousEndDate ? dateRange.previousEndDate : "period_total";
    previousRows.orders[String(row.order_type || row.business_id || row.subtitle || "")] = number(row[key] ?? row.period_total ?? row.total);
  });
  pickArray(previousCommission.data).forEach(row => {
    const key = dateRange.previousStartDate === dateRange.previousEndDate ? dateRange.previousEndDate : "period_total";
    previousRows.commission[String(row.order_type || row.business_id || row.subtitle || "")] = number(row[key] ?? row.period_total ?? row.total);
  });

  previousRows.sameTimeOrders = {};
  previousRows.sameTimeCommission = {};

  const businesses = rows.map(row => normalizeBusinessSummary(row, dateRange, byId, previousRows));
  const trendRows = Array.isArray(trend.data?.data) ? trend.data.data : [];
  const summaryRows = Array.isArray(trend.data?.summary) ? trend.data.summary : [];
  return {
    businesses,
    hourlyTrend: trendRows.map(item => ({ time: item.paid_date, orders: number(item.value), increaseRatio: number(item.increase_ratio) })),
    overview: Object.fromEntries(summaryRows.map(item => [item.key, number(item.value)])),
    columns: orders.data?.columns || []
  };
}

async function fetchBusinessDaily(statuses, query = {}) {
  const endDate = parseDay(query.daily_end || query.dailyEnd || dayKey());
  const startDate = parseDay(query.daily_start || query.dailyStart || shiftDay(endDate, -6));
  const dates = dayList(startDate, endDate);
  const rowsById = {};

  const dailyResults = await mapLimit(dates, 2, async date => {
    const payload = { platform: "", paid_date: [date, date] };
    const [orders, commission] = await Promise.all([
      apiCall(`业务每日订单-${date}`, "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "order_valid" }, 20000),
      apiCall(`业务每日佣金-${date}`, "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "settle_amount_valid" }, 20000)
    ]);
    statuses.push(orders, commission);
    return { date, orders, commission };
  });

  for (const { date, orders, commission } of dailyResults) {
    for (const row of pickArray(orders.data)) {
      const id = String(row.order_type || row.business_id || row.subtitle || "");
      rowsById[id] ||= {
        platform: row.title || row.platform || "未分类",
        name: row.subtitle || row.business_name || "未命名业务",
        businessId: id,
        platformBusinessId: String(row.order_category_id || row.platform_business_id || ""),
        days: {}
      };
      rowsById[id].days[date] ||= { orders: 0, commission: 0 };
      rowsById[id].days[date].orders = number(row[date] ?? row.period_total ?? row.total);
    }

    for (const row of pickArray(commission.data)) {
      const id = String(row.order_type || row.business_id || row.subtitle || "");
      rowsById[id] ||= {
        platform: row.title || row.platform || "未分类",
        name: row.subtitle || row.business_name || "未命名业务",
        businessId: id,
        platformBusinessId: String(row.order_category_id || row.platform_business_id || ""),
        days: {}
      };
      rowsById[id].days[date] ||= { orders: 0, commission: 0 };
      rowsById[id].days[date].commission = number(row[date] ?? row.period_total ?? row.total);
    }
  }
  return {
    startDate,
    endDate,
    dates,
    rows: Object.values(rowsById).sort((a, b) => number(b.days[endDate]?.orders) - number(a.days[endDate]?.orders))
  };
}

async function fetchBusinessHourlyTrend({ platformBusinessId = "", currentDate = dayKey() }, statuses = []) {
  const platform = String(platformBusinessId || "");
  if (!platform) return { ok: false, currentDate, series: [], source: { statuses: [{ name: "业务小时趋势", ok: false, message: "缺少业务平台ID" }] } };
  const yesterday = shiftDay(currentDate, -1);
  const lastWeek = shiftDay(currentDate, -7);
  const requests = [
    ["今日", currentDate],
    ["昨日", yesterday],
    ["上周同期", lastWeek]
  ].map(([label, date]) => apiCall(`单业务小时趋势-${label}`, "POST", "/api/v2/order-statistic/trend-new", {
    platform,
    paid_date: [date, date],
    filter_field: "order_count"
  }, 15000).then(result => ({ label, date, result })));
  const results = await Promise.all(requests);
  results.forEach(item => statuses.push(item.result));
  return {
    ok: results.some(item => item.result.ok),
    currentDate,
    platformBusinessId: platform,
    series: results.map(item => ({
      label: item.label,
      date: item.date,
      points: normalizeHourlyTrend(item.result.data?.data || [])
    }))
  };
}

async function fetchBusinessUserHistory({ businessId = "", startDate, endDate, pageSize = 5000, refresh = false, enrichPhones = true }, statuses = []) {
  const cacheKey = JSON.stringify({ type: "history", businessId, startDate, endDate, pageSize, filterField: "order_valid" });
  if (!refresh && userDetailCache.has(cacheKey)) {
    const cached = userDetailCache.get(cacheKey);
    statuses.push({ name: "业务用户历史缓存", ok: true, message: `使用缓存：${cached.rows.length} 个用户`, durationMs: 0 });
    return { ...cached, rows: cached.rows.map(attachPlainPhone), cached: true };
  }
  if (!refresh) {
    const covering = [...userDetailCache.entries()]
      .map(([key, payload]) => {
        try {
          return { key: JSON.parse(key), payload };
        } catch {
          return null;
        }
      })
      .filter(item => item?.key?.type === "history"
        && String(item.key.businessId) === String(businessId)
        && item.key.startDate <= startDate
        && item.key.endDate >= endDate)
      .sort((a, b) => {
        const timeA = Date.parse(String(a.payload.savedAtText || "").replace(/\//g, "-")) || 0;
        const timeB = Date.parse(String(b.payload.savedAtText || "").replace(/\//g, "-")) || 0;
        return timeB - timeA || (a.payload.dates?.length || 0) - (b.payload.dates?.length || 0);
      })[0];
    if (covering) {
      const dates = (covering.payload.dates || []).filter(date => date >= startDate && date <= endDate);
      const rows = (covering.payload.rows || []).map(row => attachPlainPhone({
        ...row,
        days: Object.fromEntries(dates.map(date => [date, number(row.days?.[date])])),
        todayOrders: dates.reduce((sum, date) => sum + number(row.days?.[date]), 0)
      }));
      statuses.push({ name: "业务用户历史覆盖缓存", ok: true, message: `从已保存历史切片：${rows.length} 个用户、${dates.length} 天`, durationMs: 0 });
      return { ...covering.payload, dates, rows, total: rows.length, cached: true };
    }
  }
  const dates = dayList(startDate, endDate);
  const params = { order_type: businessId, page: 1, pre_page: pageSize, start_date: startDate, end_date: endDate, filter_field: "order_valid" };
  const result = await apiCall("业务用户历史", "GET", "/api/v2/dashboard/business/user-order-statistics", params, 30000);
  statuses.push(result);
  const firstRows = asList(result.data);
  const total = number(result.data?.total);
  const perPage = Math.max(1, number(result.data?.per_page) || firstRows.length || 10);
  const totalPages = Math.max(1, number(result.data?.total_pages) || Math.ceil(total / perPage));
  let allRows = firstRows;
  if (result.ok && totalPages > 1) {
    const restPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    const rest = await mapLimit(restPages, 8, currentPage => apiCall(`业务用户历史第${currentPage}页`, "GET", "/api/v2/dashboard/business/user-order-statistics", {
      ...params,
      page: currentPage
    }, 30000));
    const failed = rest.filter(item => !item.ok).length;
    statuses.push({ name: "业务用户历史翻页", ok: failed === 0, message: failed ? `${failed} 页加载失败` : `已加载 ${totalPages} 页`, durationMs: rest.reduce((sum, item) => sum + number(item.durationMs), 0) });
    allRows = allRows.concat(...rest.filter(item => item.ok).map(item => asList(item.data)));
  }
  const rows = allRows.map(row => {
    const normalized = normalizeUser(row, startDate === endDate ? endDate : "period_total");
    normalized.days = Object.fromEntries(dates.map(date => [date, number(row[date])]));
    return normalized;
  });
  if (enrichPhones) {
    await mapLimit(rows, 8, async row => {
      const plainPhone = await fetchPlainPhone(row.id);
      if (plainPhone) row.phone = plainPhone;
    });
  }
  const payload = { ok: result.ok, savedAtText: nowText(), total, dates, rows };
  userDetailCache.set(cacheKey, payload);
  scheduleUserDetailCacheSave();
  return payload;
}

function deduplicateBusinessUsers(rows = []) {
  const users = new Map();
  for (const row of rows) {
    const id = String(row.id || "");
    if (!id) continue;
    const current = users.get(id);
    if (!current) {
      users.set(id, { ...attachPlainPhone(row), days: { ...(row.days || {}) } });
      continue;
    }
    const days = { ...(current.days || {}) };
    for (const [date, value] of Object.entries(row.days || {})) days[date] = number(days[date]) + number(value);
    users.set(id, {
      ...current,
      ...row,
      phone: plainPhoneValue(id, current.phone, row.phone),
      version: current.version || row.version,
      todayOrders: number(current.todayOrders) + number(row.todayOrders),
      yesterdayOrders: number(current.yesterdayOrders) + number(row.yesterdayOrders),
      days
    });
  }
  return [...users.values()];
}

function buildT1BusinessUserDetail(history, businessId) {
  if (!T1_USER_BUSINESS_IDS.has(String(businessId))) return null;
  const rows = deduplicateBusinessUsers(history?.rows || []);
  const dates = [...new Set(history?.dates || [])].sort();
  const latestAllowedDate = shiftDay(dayKey(), -1);
  const orderSum = date => rows.reduce((sum, row) => sum + number(row.days?.[date]), 0);
  const currentBusinessDate = [...dates].reverse().find(date => date <= latestAllowedDate && orderSum(date) > 0);
  if (!currentBusinessDate) return null;
  const comparisonBusinessDate = [...dates].reverse().find(date => date < currentBusinessDate) || "";
  const lastWeekBusinessDate = shiftDay(currentBusinessDate, -7);
  const latestDataTime = history?.savedAtText || history?.latestDataTime || "-";
  const users = rows.map(row => {
    const currentOrders = number(row.days?.[currentBusinessDate]);
    const comparisonOrders = comparisonBusinessDate ? number(row.days?.[comparisonBusinessDate]) : null;
    const hasLastWeek = Object.prototype.hasOwnProperty.call(row.days || {}, lastWeekBusinessDate);
    return {
      ...row,
      todayOrders: currentOrders,
      yesterdayOrders: comparisonOrders,
      currentDataTime: latestDataTime,
      currentBusinessDate,
      comparisonBusinessDate,
      realtimeToday: true,
      sameTime: {
        yesterday: comparisonOrders === null ? null : { orders: comparisonOrders, commission: 0 },
        lastWeek: hasLastWeek ? { orders: number(row.days?.[lastWeekBusinessDate]), commission: 0 } : null,
        comparisonSlotLabel: "",
        comparisonTargetMinute: null,
        comparisonMinute: null,
        comparisonOffsetMinutes: null,
        comparisonExact: true,
        comparisonQuality: "complete_day",
        yesterdayReference: { comparisonQuality: "complete_day" },
        lastWeekReference: { comparisonQuality: hasLastWeek ? "complete_day" : "missing" },
        hasSnapshot: false,
        hasApiBaseline: comparisonOrders !== null,
        t1CompleteDay: true
      }
    };
  });
  return {
    reportingMode: "t1",
    currentBusinessDate,
    comparisonBusinessDate,
    lastWeekBusinessDate,
    latestDataTime,
    currentLatestDataTime: latestDataTime,
    fullCurrentLatestDataTime: latestDataTime,
    historyLatestDataTime: latestDataTime,
    realtimeUserCount: users.length,
    total: rows.length,
    userOrderSum: users.reduce((sum, row) => sum + number(row.todayOrders), 0),
    comparisonOrderSum: users.reduce((sum, row) => sum + number(row.yesterdayOrders), 0),
    users
  };
}

function latestFastBusinessUsers(businessId, date = dayKey()) {
  let latest = null;
  let latestAt = 0;
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      if (String(key.businessId) !== String(businessId)) continue;
      if (key.startDate !== date || key.endDate !== date || key.includePrevious !== false) continue;
      if (key.filterField !== "order_valid") continue;
      if (number(key.pageSize) > 100) continue;
      const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
      if (!latest || savedAt > latestAt) {
        latest = payload;
        latestAt = savedAt;
      }
    } catch {}
  }
  return latest;
}

function latestFullBusinessUsers(businessId, date = dayKey()) {
  let latest = null;
  let latestAt = 0;
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      if (String(key.businessId) !== String(businessId)) continue;
      if (key.startDate !== date || key.endDate !== date || key.includePrevious !== false) continue;
      if (key.filterField !== "order_valid") continue;
      if (number(key.pageSize) < 5000) continue;
      const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
      if (!latest || savedAt > latestAt) {
        latest = payload;
        latestAt = savedAt;
      }
    } catch {}
  }
  return latest;
}

async function fetchSynchronizedBusinessUsers({ businessId = "", startDate, endDate, pageSize = 5000, refresh = false }, statuses = []) {
  const isT1Business = T1_USER_BUSINESS_IDS.has(String(businessId));
  const history = await fetchBusinessUserHistory({
    businessId,
    startDate,
    endDate,
    pageSize,
    refresh: isT1Business && refresh,
    enrichPhones: true
  }, statuses);
  const historyRows = deduplicateBusinessUsers(history.rows || []).map(row => ({ ...row, currentDataTime: history.savedAtText || "" }));
  const t1Detail = buildT1BusinessUserDetail({ ...history, rows: historyRows }, businessId);
  if (t1Detail) {
    return {
      ok: history.ok,
      message: history.ok ? "" : "中台业务用户历史接口未返回有效数据",
      cached: Boolean(history.cached),
      ...t1Detail,
      history: {
        ok: history.ok,
        cached: Boolean(history.cached),
        latestDataTime: history.savedAtText || "-",
        dates: history.dates,
        rows: historyRows,
        total: history.total
      }
    };
  }
  const snapshots = await readSnapshots();
  const refreshedFull = refresh && endDate === dayKey() ? await fetchBusinessUsers({
    businessId,
    startDate: endDate,
    endDate,
    page: 1,
    pageSize,
    sortField: endDate,
    sortOrder: "desc",
    refresh: true,
    includePrevious: false
  }, statuses) : null;
  const full = refreshedFull || (endDate === dayKey() ? latestFullBusinessUsers(businessId, endDate) : null);
  const fast = endDate === dayKey() ? latestFastBusinessUsers(businessId, endDate) : null;
  const timeValue = value => Date.parse(String(value || "").replace(/\//g, "-")) || 0;
  const fullRows = deduplicateBusinessUsers(full?.rows || []).map(row => ({ ...row, currentDataTime: full?.savedAtText || "" }));
  const fullById = new Map(fullRows.map(row => [String(row.id || ""), row]));
  const fastIsNewer = timeValue(fast?.savedAtText) > timeValue(full?.savedAtText);
  const fastRows = deduplicateBusinessUsers(fastIsNewer ? fast?.rows || [] : []).map(row => ({ ...row, currentDataTime: fast?.savedAtText || "" }));
  const fastById = new Map(fastRows.map(row => [String(row.id || ""), row]));
  const currentById = new Map(fullById);
  fastById.forEach((row, id) => currentById.set(id, row));
  const todayRows = historyRows.map(row => {
    const current = currentById.get(String(row.id || ""));
    return {
      ...row,
      ...(current || {}),
      currentDataTime: current?.currentDataTime || (full ? full.savedAtText : row.currentDataTime),
      days: {
        ...(row.days || {}),
        ...(full ? { [endDate]: number(current?.todayOrders) } : {})
      },
      todayOrders: full ? number(current?.todayOrders) : number(fastById.get(String(row.id || ""))?.todayOrders ?? row.days?.[endDate]),
      yesterdayOrders: number(row.days?.[shiftDay(endDate, -1)]),
      // A complete current-day response also proves that omitted historical users have zero orders at this batch time.
      realtimeToday: Boolean(full || current)
    };
  });
  for (const currentRow of currentById.values()) {
    if (historyRows.some(row => String(row.id || "") === String(currentRow.id || ""))) continue;
    todayRows.push({ ...currentRow, days: { [endDate]: number(currentRow.todayOrders) }, realtimeToday: true });
  }
  const historyLatestDataTime = history.savedAtText || "-";
  const fullCurrentLatestDataTime = full?.savedAtText || "";
  const currentLatestDataTime = fastIsNewer ? fast.savedAtText : (fullCurrentLatestDataTime || historyLatestDataTime);
  const users = enrichBusinessUsersWithSnapshots(
    todayRows,
    snapshots,
    businessId,
    rangeFromQuery({ start_date: endDate, end_date: endDate }),
    comparisonMinuteFromText(currentLatestDataTime)
  );
  users.forEach(user => { user.phone = plainPhoneValue(user.id, user.phone); });
  historyRows.forEach(user => { user.phone = plainPhoneValue(user.id, user.phone); });
  const topState = userRefreshState.top100[String(businessId)] || {};
  users.forEach(user => { user.newTop100At = topState.entered?.[String(user.id)] || ""; });
  const failedStatus = [...statuses].reverse().find(item => !item.ok);
  return {
    ok: history.ok,
    message: history.ok ? "" : (failedStatus ? `${failedStatus.name}：${failedStatus.message}` : "中台业务用户历史接口未返回有效数据"),
    cached: Boolean(history.cached),
    latestDataTime: currentLatestDataTime,
    currentLatestDataTime,
    fullCurrentLatestDataTime: fullCurrentLatestDataTime || "-",
    historyLatestDataTime,
    realtimeUserCount: fastById.size,
    total: full?.total || history.total,
    userOrderSum: users.reduce((sum, row) => sum + number(row.todayOrders), 0),
    users,
    history: {
      ok: history.ok,
      cached: Boolean(history.cached),
      latestDataTime: historyLatestDataTime,
      dates: history.dates,
      rows: historyRows,
      total: history.total
    }
  };
}

function mergeBusinessCatalog(catalogRows, summaryRows, dateRange) {
  const byStatId = new Map(summaryRows.map(row => [String(row.businessId), row]));
  const merged = [];
  const seen = new Set();
  for (const catalog of catalogRows) {
    const base = normalizeBusinessCatalog(catalog, dateRange);
    const stat = byStatId.get(String(base.businessId));
    const row = stat ? {
      ...base,
      ...stat,
      platform: stat.platform || base.platform,
      name: stat.name || base.name,
      platformBusinessId: base.platformBusinessId || stat.platformBusinessId,
      users: Math.max(number(base.users), number(stat.users)),
      totalOrders: Math.max(number(base.totalOrders), number(stat.totalOrders)),
      source: "中台业务列表 + 业务统计"
    } : base;
    merged.push(row);
    seen.add(String(row.businessId));
  }
  for (const stat of summaryRows) {
    if (!seen.has(String(stat.businessId))) merged.push(stat);
  }
  return merged.sort((a, b) => number(b.todayOrders) - number(a.todayOrders) || String(a.platform).localeCompare(String(b.platform), "zh-CN") || String(a.name).localeCompare(String(b.name), "zh-CN"));
}

async function fetchBusinessUsers({ businessId = "", startDate, endDate, page = 1, pageSize = 100, sortField = "", sortOrder = "", refresh = false, includePrevious = true }, statuses = []) {
  const cacheKey = JSON.stringify({ businessId, startDate, endDate, page, pageSize, sortField, sortOrder, includePrevious, filterField: "order_valid" });
  if (!refresh && userDetailCache.has(cacheKey)) {
    const cached = userDetailCache.get(cacheKey);
    statuses.push({ name: "业务用户缓存", ok: true, message: `使用缓存：${cached.rows.length} 个用户`, durationMs: 0 });
    return { ...cached, rows: cached.rows.map(attachPlainPhone), cached: true };
  }
  const params = { order_type: businessId, page, pre_page: pageSize, start_date: startDate, end_date: endDate, filter_field: "order_valid" };
  if (sortField && sortOrder) {
    params.sort_field = sortField;
    params.sort_order = sortOrder;
  }
  const result = await apiCall("业务用户下钻", "GET", "/api/v2/dashboard/business/user-order-statistics", params, 25000);
  statuses.push(result);
  const firstRows = asList(result.data);
  const total = number(result.data?.total);
  const perPage = Math.max(1, number(result.data?.per_page) || firstRows.length || 10);
  const totalPages = Math.max(1, number(result.data?.total_pages) || Math.ceil(total / perPage));
  const needPages = Math.min(totalPages, Math.ceil(Math.max(pageSize, firstRows.length) / perPage));
  let allRows = firstRows;
  if (result.ok && needPages > 1) {
    const restPages = Array.from({ length: needPages - 1 }, (_, index) => index + 2);
    const rest = await mapLimit(restPages, 8, currentPage => apiCall(`业务用户下钻第${currentPage}页`, "GET", "/api/v2/dashboard/business/user-order-statistics", {
      ...params,
      page: currentPage
    }, 25000));
    const failed = rest.filter(item => !item.ok).length;
    statuses.push({ name: "业务用户下钻翻页", ok: failed === 0, message: failed ? `${failed} 页加载失败` : `已加载 ${needPages} 页`, durationMs: rest.reduce((sum, item) => sum + number(item.durationMs), 0) });
    allRows = allRows.concat(...rest.filter(item => item.ok).map(item => asList(item.data)));
  }
  let previousById = {};
  if (businessId && includePrevious) {
    const periodDays = dayList(startDate, endDate).length;
    const previousEnd = shiftDay(startDate, -1);
    const previousStart = shiftDay(previousEnd, -(periodDays - 1));
    const previousKey = previousStart === previousEnd ? previousEnd : "period_total";
    const previous = await apiCall("业务用户前一周期基准", "GET", "/api/v2/dashboard/business/user-order-statistics", {
      order_type: businessId,
      page: 1,
      pre_page: pageSize,
      start_date: previousStart,
      end_date: previousEnd,
      filter_field: "order_valid"
    }, 30000);
    statuses.push(previous);
    let previousRows = asList(previous.data);
    const previousTotal = number(previous.data?.total);
    const previousPerPage = Math.max(1, number(previous.data?.per_page) || previousRows.length || 10);
    const previousTotalPages = Math.max(1, number(previous.data?.total_pages) || Math.ceil(previousTotal / previousPerPage));
    const previousNeedPages = Math.min(previousTotalPages, Math.ceil(Math.max(pageSize, previousRows.length) / previousPerPage));
    if (previous.ok && previousNeedPages > 1) {
      const previousRestPages = Array.from({ length: previousNeedPages - 1 }, (_, index) => index + 2);
      const previousRest = await mapLimit(previousRestPages, 8, currentPage => apiCall(`业务用户前一周期基准第${currentPage}页`, "GET", "/api/v2/dashboard/business/user-order-statistics", {
        order_type: businessId,
        page: currentPage,
        pre_page: pageSize,
        start_date: previousStart,
        end_date: previousEnd,
        filter_field: "order_valid"
      }, 30000));
      previousRows = previousRows.concat(...previousRest.filter(item => item.ok).map(item => asList(item.data)));
    }
    previousById = {};
    previousRows.forEach(row => {
      const id = String(row.uid || row.promotion_id || row.accounts_id || "");
      previousById[id] = number(previousById[id]) + number(row[previousKey] ?? row.period_total);
    });
  }
  const rows = allRows.slice(0, pageSize).map(row => normalizeUser(row, startDate === endDate ? endDate : "period_total"));
  rows.forEach(row => {
    row.yesterdayOrders = previousById[row.id] || 0;
  });
  await mapLimit(rows, 8, async row => {
    const plainPhone = await fetchPlainPhone(row.id);
    row.phone = plainPhoneValue(row.id, plainPhone, row.phone);
  });
  const payload = {
    ok: result.ok,
    savedAtText: nowText(),
    total,
    page: number(result.data?.page || page),
    pageSize: perPage,
    columns: result.data?.columns || [],
    rows
  };
  userDetailCache.set(cacheKey, payload);
  scheduleUserDetailCacheSave();
  return payload;
}

async function warmBusinessUserDetails(businesses, dateRange, { refresh = false } = {}) {
  const rows = (businesses || []).filter(row => row.platformBusinessId || row.businessId);
  if (!rows.length) return;
  let warmed = 0;
  await mapLimit(rows, 4, async row => {
    const statuses = [];
    const pageSize = Math.min(5000, Math.max(500, number(row.users || row.userIds?.length || 0) + 50));
    try {
      await fetchBusinessUsers({
        businessId: row.platformBusinessId || row.businessId || "",
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        page: 1,
        pageSize,
        sortField: dateRange.startDate === dateRange.endDate ? dateRange.endDate : "period_total",
        sortOrder: "desc",
        refresh
      }, statuses);
      warmed += 1;
    } catch (error) {
      console.error(`[${nowText()}] 预热业务用户失败：${row.name} ${error.message}`);
    }
  });
  console.log(`[${nowText()}] 已预热业务用户明细缓存：${warmed}/${rows.length}`);
}

async function loadUserRefreshState() {
  try {
    userRefreshState = JSON.parse(await readFile(USER_REFRESH_STATE_PATH, "utf8"));
  } catch {
    userRefreshState = { scheduledRuns: {}, top100: {} };
  }
  userRefreshState.scheduledRuns ||= {};
  userRefreshState.top100 ||= {};
}

async function saveUserRefreshState() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(USER_REFRESH_STATE_PATH, JSON.stringify(userRefreshState, null, 2));
}

async function warmTopBusinessUsers(businesses, dateRange, config) {
  const enabled = new Set((config.fastUserBusinessIds || []).map(String));
  const rows = (businesses || []).filter(row => enabled.has(String(row.platformBusinessId || row.businessId || "")));
  if (!rows.length) return { businesses: 0, users: 0, newTop100: 0 };
  let users = 0;
  let newTop100 = 0;
  await mapLimit(rows, 3, async row => {
    const businessId = String(row.platformBusinessId || row.businessId || "");
    const statuses = [];
    const result = await fetchBusinessUsers({
      businessId,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      page: 1,
      pageSize: 100,
      sortField: dateRange.endDate,
      sortOrder: "desc",
      refresh: true,
      includePrevious: false
    }, statuses);
    const previousIds = new Set(userRefreshState.top100[businessId]?.ids || []);
    const entered = (result.rows || []).filter(user => !previousIds.has(String(user.id))).map(user => String(user.id));
    const enteredToday = { ...(userRefreshState.top100[businessId]?.entered || {}) };
    entered.forEach(id => { enteredToday[id] = nowText(); });
    userRefreshState.top100[businessId] = {
      ids: (result.rows || []).map(user => String(user.id)),
      entered: enteredToday,
      updatedAt: new Date().toISOString(),
      updatedAtText: nowText()
    };
    users += result.rows?.length || 0;
    newTop100 += previousIds.size ? entered.length : 0;
  });
  await saveUserRefreshState();
  console.log(`[${nowText()}] 已刷新高频业务用户前100：${rows.length} 个业务，${users} 个用户，新进 ${newTop100} 人。`);
  return { businesses: rows.length, users, newTop100 };
}

async function refreshFocusUserToday(item) {
  const today = dayKey();
  const result = await apiCall("重点用户今日订单", "GET", "/api/v2/dashboard/business/user-order-statistics", {
    order_type: item.businessId,
    page: 1,
    pre_page: 10,
    start_date: today,
    end_date: today,
    filter_field: "order_valid",
    keyword: item.userId
  }, 20000);
  if (!result.ok) return false;
  const matched = asList(result.data).find(row => String(row.uid || row.promotion_id || row.accounts_id || "") === String(item.userId));
  const row = matched ? normalizeUser(matched, today) : {
    id: String(item.userId),
    name: item.name || `用户 ${item.userId}`,
    phone: item.phone || "-",
    version: item.version || "-",
    todayOrders: 0,
    days: { [today]: 0 }
  };
  row.phone = plainPhoneValue(row.id, row.phone);
  const cacheKey = JSON.stringify({ type: "focus-current", businessId: String(item.businessId), userId: String(item.userId), date: today });
  userDetailCache.set(cacheKey, { ok: true, savedAtText: nowText(), total: 1, rows: [{ ...row, realtimeToday: true }] });
  scheduleUserDetailCacheSave();
  return true;
}

async function discoverFocusUserBusinesses(item) {
  const catalog = await focusBusinessCatalog();
  let refreshed = 0;
  await mapLimit(catalog, 4, async business => {
    if (await refreshFocusUserToday({ ...item, ...business })) refreshed += 1;
  });
  console.log(`[${nowText()}] 已完成重点用户全业务发现：${item.userId}，${refreshed}/${catalog.length} 个业务。`);
  return { refreshed, total: catalog.length };
}

async function refreshFocusUsersToday() {
  const saved = await readFocusUsers();
  const items = saved.items || [];
  if (!items.length) return { users: 0 };
  const catalog = await focusBusinessCatalog();
  const cacheIndex = focusUserCacheIndex(items.map(item => item.userId));
  const targets = [];
  const seen = new Set();
  for (const item of items) {
    const hinted = new Set((item.businessHints || []).flatMap(hint => [String(hint.businessId || ""), String(hint.catalogBusinessId || "")]).filter(Boolean));
    for (const business of catalog) {
      const cached = cacheIndex.get(`${business.businessId}:${item.userId}`);
      const recentOrders = cached ? Object.entries(cached.days || {}).some(([date, value]) => date >= shiftDay(dayKey(), -30) && number(value) > 0) : false;
      if (!recentOrders && !number(cached?.todayOrders) && !hinted.has(business.businessId) && !hinted.has(business.catalogBusinessId)) continue;
      const key = `${business.businessId}:${item.userId}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ ...item, ...business });
      }
    }
  }
  let users = 0;
  await mapLimit(targets, 4, async item => {
    if (await refreshFocusUserToday(item)) users += 1;
  });
  console.log(`[${nowText()}] 已同步全局重点用户今日订单：${users}/${targets.length} 条有单业务关系，${items.length} 位用户。`);
  return { users, targets: targets.length };
}

function publicHistoryRange() {
  const today = new Date();
  const start = addDays(today, -64);
  return { startDate: dayKey(start), endDate: dayKey(today) };
}

async function warmBusinessUserHistories(businesses, { refresh = false } = {}) {
  if (publicHistoryWarmupRunning) return;
  publicHistoryWarmupRunning = true;
  const rows = (businesses || []).filter(row => row.platformBusinessId || row.businessId);
  try {
    if (!rows.length) return;
    const range = publicHistoryRange();
    let warmed = 0;
    await mapLimit(rows, 4, async row => {
      const statuses = [];
      try {
        await fetchBusinessUserHistory({
          businessId: row.platformBusinessId || row.businessId || "",
          startDate: range.startDate,
          endDate: range.endDate,
          pageSize: 5000,
          enrichPhones: false,
          refresh
        }, statuses);
        warmed += 1;
      } catch (error) {
        console.error(`[${nowText()}] 预热业务用户历史失败：${row.name} ${error.message}`);
      }
    });
    console.log(`[${nowText()}] 已预热公网业务用户历史：${warmed}/${rows.length}`);
  } finally {
    publicHistoryWarmupRunning = false;
  }
}

async function warmStartupData() {
  if (startupWarmupRunning) return;
  startupWarmupRunning = true;
  try {
    console.log(`[${nowText()}] 开始启动预热：用户索引、今日业务和本地用户缓存`);
    const loadedDetailCache = await loadUserDetailCacheFromDisk();
    if (loadedDetailCache) console.log(`[${nowText()}] 已加载本地用户明细缓存：${userDetailCache.size} 条`);
    await loadUserRefreshState();
    await loadRequestStats();
    await ensureUserPhoneIndex();
    const dateRange = rangeFromQuery({ preset: "today", start_date: dayKey(), end_date: dayKey() });
    const data = await liveDashboard({ recordSnapshot: false, query: { preset: "today", start_date: dateRange.startDate, end_date: dateRange.endDate, force: "1" } });
    const config = await readConfig();
    await warmTopBusinessUsers(data.businesses, dateRange, config);
    await refreshFocusUsersToday();
    console.log(`[${nowText()}] 启动预热完成`);
  } catch (error) {
    console.error(`[${nowText()}] 启动预热失败：${error.message}`);
    readConfig()
      .then(config => notifyOperationalIssue("startupWarmupFailed", "启动预热失败", error.message, config))
      .catch(notifyError => console.error(`[${nowText()}] 飞书通知失败：${notifyError.message}`));
  } finally {
    startupWarmupRunning = false;
  }
}

async function readSnapshots(limit = 5000) {
  if (!existsSync(SNAPSHOT_PATH)) return [];
  const text = await readFile(SNAPSHOT_PATH, "utf8");
  const snapshots = [];
  for (const line of text.trim().split("\n").filter(Boolean).slice(-limit)) {
    try {
      snapshots.push(JSON.parse(line));
    } catch {
      // A partial final write must not make the whole dashboard unavailable.
    }
  }
  return snapshots;
}

function compactSnapshot(snapshot) {
  const compactValues = values => Object.fromEntries(Object.entries(values || {}).map(([id, value]) => [id, {
    orders: number(value?.orders),
    commission: number(value?.commission)
  }]));
  return {
    createdAt: snapshot.createdAt,
    createdAtText: snapshot.createdAtText,
    day: snapshot.day,
    minuteOfDay: number(snapshot.minuteOfDay),
    snapshotSlotKey: snapshot.snapshotSlotKey,
    snapshotSlotLabel: snapshot.snapshotSlotLabel,
    actualMinuteOfDay: number(snapshot.actualMinuteOfDay),
    userDataStrict: Boolean(snapshot.userDataStrict),
    business: Object.fromEntries(Object.entries(snapshot.business || {}).map(([id, value]) => [id, {
      name: value?.name || "",
      platform: value?.platform || "",
      orders: number(value?.orders),
      commission: number(value?.commission)
    }])),
    users: compactValues(snapshot.users),
    businessUsers: Object.fromEntries(Object.entries(snapshot.businessUsers || {}).map(([businessId, values]) => [businessId, compactValues(values)]))
  };
}

async function pruneSnapshots() {
  const today = dayKey();
  if (!existsSync(SNAPSHOT_PATH) || lastSnapshotPruneDay === today) return;
  const cutoff = shiftDay(today, -(SNAPSHOT_RETENTION_DAYS - 1));
  const tempPath = `${SNAPSHOT_PATH}.tmp`;
  const input = createInterface({ input: createReadStream(SNAPSHOT_PATH, { encoding: "utf8" }), crlfDelay: Infinity });
  const output = createWriteStream(tempPath, { encoding: "utf8" });
  let kept = 0;
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const snapshot = JSON.parse(line);
      if (String(snapshot.day || "") < cutoff) continue;
      if (!output.write(`${JSON.stringify(compactSnapshot(snapshot))}\n`)) await once(output, "drain");
      kept += 1;
    } catch {
      // Skip a damaged line without discarding the rest of the snapshot file.
    }
  }
  output.end();
  await once(output, "finish");
  await rename(tempPath, SNAPSHOT_PATH);
  lastSnapshotPruneDay = today;
  console.log(`[${nowText()}] 快照清理完成：保留 ${cutoff} 至 ${today}，共 ${kept} 条`);
}

function comparisonMinuteFromText(value) {
  const match = String(value || "").match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function exactSnapshot(snapshots, targetDay, targetMinute) {
  if (!Number.isFinite(Number(targetMinute))) return null;
  const candidates = snapshots.filter(item => item.day === targetDay && number(item.minuteOfDay) === number(targetMinute));
  return candidates.at(-1) || null;
}

function nearbySnapshotCandidates(snapshots, targetDay, targetMinute, maxOffsetMinutes = 20) {
  if (!Number.isFinite(Number(targetMinute))) return [];
  const minute = Number(targetMinute);
  return snapshots
    .map((snapshot, index) => ({
      snapshot,
      index,
      actualMinute: number(snapshot.minuteOfDay),
      offsetMinutes: number(snapshot.minuteOfDay) - minute
    }))
    .filter(item => item.snapshot.day === targetDay && Math.abs(item.offsetMinutes) <= maxOffsetMinutes)
    .sort((a, b) => Math.abs(a.offsetMinutes) - Math.abs(b.offsetMinutes) || b.index - a.index)
    .map(item => ({
      ...item,
      targetMinute: minute,
      exact: item.offsetMinutes === 0,
      quality: item.offsetMinutes === 0 ? "exact" : "nearby"
    }));
}

function nearestSnapshotMatch(snapshots, targetDay, targetMinute, maxOffsetMinutes = 20) {
  return nearbySnapshotCandidates(snapshots, targetDay, targetMinute, maxOffsetMinutes)[0] || null;
}

function snapshotReference(match, quality = match?.quality) {
  if (!match) return {
    comparisonSlotLabel: "",
    comparisonTargetMinute: null,
    comparisonMinute: null,
    comparisonOffsetMinutes: null,
    comparisonExact: false,
    comparisonQuality: "missing"
  };
  return {
    comparisonSlotLabel: match.snapshot?.snapshotSlotLabel || "",
    comparisonTargetMinute: match.targetMinute,
    comparisonMinute: match.actualMinute,
    comparisonOffsetMinutes: match.offsetMinutes,
    comparisonExact: match.offsetMinutes === 0 && quality !== "legacy",
    comparisonQuality: quality || (match.offsetMinutes === 0 ? "exact" : "nearby")
  };
}

function businessUserSnapshotMatch(snapshots, targetDay, targetMinute, businessId, userId, maxOffsetMinutes = 20) {
  const businessKey = String(businessId || "");
  const userKey = String(userId || "");
  const containsUser = match => Boolean(match.snapshot?.businessUsers?.[businessKey]?.[userKey]);
  const strict = nearbySnapshotCandidates(
    snapshots.filter(snapshot => snapshot.userDataStrict === true),
    targetDay,
    targetMinute,
    maxOffsetMinutes
  ).find(containsUser);
  if (strict) return strict;
  const legacy = nearbySnapshotCandidates(
    snapshots.filter(snapshot => snapshot.userDataStrict !== true),
    targetDay,
    targetMinute,
    maxOffsetMinutes
  ).find(containsUser);
  return legacy ? { ...legacy, quality: "legacy" } : null;
}

function enrichWithSnapshots(rows, snapshots, type, dateRange = rangeFromQuery(), comparisonMinute = minuteOfDay()) {
  const currentDate = dateFromDay(dateRange.endDate);
  const yesterdayMatch = nearestSnapshotMatch(snapshots, dayKey(addDays(currentDate, -1)), comparisonMinute);
  const lastWeekMatch = nearestSnapshotMatch(snapshots, dayKey(addDays(currentDate, -7)), comparisonMinute);
  const recentMatches = Array.from({ length: 7 }, (_, index) => nearestSnapshotMatch(snapshots, dayKey(addDays(currentDate, -(index + 1))), comparisonMinute)).filter(Boolean);
  const yesterday = yesterdayMatch?.snapshot || null;
  const lastWeek = lastWeekMatch?.snapshot || null;
  const recent = recentMatches.map(match => match.snapshot);

  return rows.map(row => {
    const id = String(type === "business" ? row.businessId : row.id);
    const pick = snap => snap?.[type]?.[id] || null;
    const snapshotYesterday = pick(yesterday);
    const sevenValues = recent.map(pick).filter(Boolean);
    const avg = sevenValues.length
      ? {
          orders: Math.round(sevenValues.reduce((sum, item) => sum + number(item.orders), 0) / sevenValues.length),
          commission: Math.round(sevenValues.reduce((sum, item) => sum + number(item.commission), 0) / sevenValues.length * 100) / 100
        }
      : null;
    return {
      ...row,
      sameTime: {
        yesterday: snapshotYesterday,
        lastWeek: pick(lastWeek),
        sevenDayAvg: avg,
        ...snapshotReference(yesterdayMatch),
        yesterdayReference: snapshotReference(yesterdayMatch),
        lastWeekReference: snapshotReference(lastWeekMatch),
        sevenDayReferenceQuality: recentMatches.some(match => !match.exact) ? "nearby" : recentMatches.length ? "exact" : "missing",
        yesterdaySource: snapshotYesterday ? (yesterdayMatch?.exact ? "严格同分钟槽快照" : "邻近分钟槽参考") : "",
        hasSnapshot: Boolean(snapshotYesterday || pick(lastWeek) || avg),
        hasApiBaseline: Boolean(row.yesterdayOrders)
      }
    };
  });
}

function enrichBusinessUsersWithSnapshots(rows, snapshots, businessId, dateRange = rangeFromQuery(), comparisonMinute = minuteOfDay()) {
  const currentDate = dateFromDay(dateRange.endDate);
  const businessKey = String(businessId || "");
  const strictSnapshots = snapshots.filter(snapshot => snapshot.userDataStrict === true && Object.keys(snapshot?.businessUsers?.[businessKey] || {}).length > 0);
  const legacySnapshots = snapshots.filter(snapshot => snapshot.userDataStrict !== true && Object.keys(snapshot?.businessUsers?.[businessKey] || {}).length > 0);
  const baselinesByMinute = new Map();
  const baselinesFor = targetMinute => {
    if (!Number.isFinite(Number(targetMinute))) return { yesterday: null, lastWeek: null, recent: [] };
    const key = Number(targetMinute);
    if (!baselinesByMinute.has(key)) {
      const candidatesFor = targetDay => ({
        strict: nearbySnapshotCandidates(strictSnapshots, targetDay, key),
        legacy: nearbySnapshotCandidates(legacySnapshots, targetDay, key)
      });
      baselinesByMinute.set(key, {
        yesterday: candidatesFor(dayKey(addDays(currentDate, -1))),
        lastWeek: candidatesFor(dayKey(addDays(currentDate, -7))),
        recent: Array.from({ length: 7 }, (_, index) => candidatesFor(dayKey(addDays(currentDate, -(index + 1)))))
      });
    }
    return baselinesByMinute.get(key);
  };

  const findUserMatch = (candidateSet, userId) => {
    const containsUser = match => Boolean(match.snapshot?.businessUsers?.[businessKey]?.[userId]);
    const strict = candidateSet?.strict?.find(containsUser);
    if (strict) return strict;
    const legacy = candidateSet?.legacy?.find(containsUser);
    return legacy ? { ...legacy, quality: "legacy" } : null;
  };

  return rows.map(row => {
    const rowMinute = comparisonMinuteFromText(row.currentDataTime || row.userDataTime) ?? comparisonMinute;
    const id = String(row.id || "");
    const baselineCandidates = baselinesFor(rowMinute);
    const yesterdayMatch = findUserMatch(baselineCandidates.yesterday, id);
    const lastWeekMatch = findUserMatch(baselineCandidates.lastWeek, id);
    const recentMatches = baselineCandidates.recent.map(candidateSet => findUserMatch(candidateSet, id)).filter(Boolean);
    const pick = match => match?.snapshot?.businessUsers?.[businessKey]?.[id] || null;
    const sevenValues = recentMatches.map(pick).filter(Boolean);
    const avg = sevenValues.length
      ? {
          orders: Math.round(sevenValues.reduce((sum, item) => sum + number(item.orders), 0) / sevenValues.length),
          commission: Math.round(sevenValues.reduce((sum, item) => sum + number(item.commission), 0) / sevenValues.length * 100) / 100
        }
      : null;
    return {
      ...row,
      sameTime: {
        yesterday: pick(yesterdayMatch),
        lastWeek: pick(lastWeekMatch),
        sevenDayAvg: avg,
        ...snapshotReference(yesterdayMatch, yesterdayMatch?.quality),
        yesterdayReference: snapshotReference(yesterdayMatch, yesterdayMatch?.quality),
        lastWeekReference: snapshotReference(lastWeekMatch, lastWeekMatch?.quality),
        sevenDayReferenceQuality: recentMatches.some(match => match.quality !== "exact") ? "nearby" : recentMatches.length ? "exact" : "missing",
        hasSnapshot: Boolean(pick(yesterdayMatch) || pick(lastWeekMatch) || avg),
        hasApiBaseline: Boolean(row.yesterdayOrders || row.yesterdayCommission)
      }
    };
  });
}

function cachedBusinessUsersSnapshot(dateRange, targetMinute = minuteOfDay()) {
  const targetDate = dateRange.endDate;
  const candidates = new Map();
  const focusCurrent = new Map();
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      const businessId = String(key.businessId);
      if (!businessId || !Array.isArray(payload.rows)) continue;
      const payloadMinute = comparisonMinuteFromText(payload.savedAtText);
      if (key.type === "focus-current") {
        if (key.date === targetDate && payloadMinute === Number(targetMinute)) {
          const rows = focusCurrent.get(businessId) || [];
          rows.push(...payload.rows);
          focusCurrent.set(businessId, rows);
        }
        continue;
      }
      const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
      const group = candidates.get(businessId) || { history: null, exact: null };
      if (key.type === "history" && key.startDate <= targetDate && key.endDate >= targetDate) {
        if (!group.history || savedAt > group.history.savedAt || (savedAt === group.history.savedAt && payload.rows.length > group.history.payload.rows.length)) {
          group.history = { payload, savedAt };
        }
      } else if (key.startDate === targetDate && key.endDate === targetDate) {
        if (!group.exact || savedAt > group.exact.savedAt || (savedAt === group.exact.savedAt && payload.rows.length > group.exact.payload.rows.length)) {
          group.exact = { payload, savedAt };
        }
      }
      candidates.set(businessId, group);
    } catch {
      // Ignore old cache keys that are not JSON.
    }
  }

  const details = {};
  for (const [businessId, group] of candidates.entries()) {
    const full = latestFullBusinessUsers(businessId, targetDate);
    if (full) {
      const fast = latestFastBusinessUsers(businessId, targetDate);
      const fullMatchesSlot = comparisonMinuteFromText(full.savedAtText) === Number(targetMinute);
      const fastMatchesSlot = comparisonMinuteFromText(fast?.savedAtText) === Number(targetMinute);
      const currentById = new Map((fullMatchesSlot ? deduplicateBusinessUsers(full.rows || []) : []).map(row => [String(row.id || ""), row]));
      if (fastMatchesSlot) {
        for (const row of deduplicateBusinessUsers(fast.rows || [])) currentById.set(String(row.id || ""), row);
      }
      if (currentById.size) details[businessId] = Object.fromEntries([...currentById.entries()].map(([userId, row]) => [userId, {
        name: row.name,
        phone: plainPhoneValue(userId, row.phone),
        version: row.version,
        orders: number(row.todayOrders),
        commission: number(row.todayCommission)
      }]));
      continue;
    }
    const historyRows = (comparisonMinuteFromText(group.history?.payload.savedAtText) === Number(targetMinute) ? group.history?.payload.rows || [] : []).map(row => ({
      ...row,
      todayOrders: number(row.days?.[targetDate]),
      todayCommission: 0
    }));
    const byUser = {};
    for (const row of deduplicateBusinessUsers(historyRows)) {
      const userId = String(row.id || "");
      if (!userId) continue;
      byUser[userId] = { name: row.name, phone: plainPhoneValue(userId, row.phone), version: row.version, orders: number(row.todayOrders), commission: number(row.todayCommission) };
    }
    if (comparisonMinuteFromText(group.exact?.payload.savedAtText) === Number(targetMinute)) {
      for (const row of deduplicateBusinessUsers(group.exact?.payload.rows || [])) {
        const userId = String(row.id || "");
        if (!userId) continue;
        byUser[userId] = { name: row.name, phone: plainPhoneValue(userId, row.phone), version: row.version, orders: number(row.todayOrders), commission: number(row.todayCommission) };
      }
    }
    if (Object.keys(byUser).length) details[businessId] = byUser;
  }
  for (const [businessId, rows] of focusCurrent.entries()) {
    const byUser = details[businessId] || {};
    for (const row of deduplicateBusinessUsers(rows)) {
      const userId = String(row.id || "");
      if (!userId) continue;
      byUser[userId] = {
        name: row.name,
        phone: plainPhoneValue(userId, row.phone),
        version: row.version,
        orders: number(row.todayOrders),
        commission: number(row.todayCommission)
      };
    }
    if (Object.keys(byUser).length) details[businessId] = byUser;
  }
  return details;
}

async function liveDashboard({ recordSnapshot = true, query = {} } = {}) {
  const config = await readConfig();
  const userAliases = await readUserAliases();
  const dateRange = rangeFromQuery(query);
  const cacheKey = dashboardCacheKey(dateRange);
  if (query.cache === "1" && query.force !== "1") {
    const cache = await readDashboardCache();
    const exact = cache[cacheKey];
    const fallback = exact || latestValidDashboardCache(cache)?.[1];
    if (fallback?.payload) {
      return {
        ...fallback.payload,
        ok: true,
        latestDataTime: fallback.savedAtText || fallback.payload.latestDataTime,
        config,
        userAliases: userAliases.aliases,
        refreshIntervalSeconds: Math.max(10, Number(config.refreshSeconds || 60)),
        source: {
          ...(fallback.payload.source || {}),
          cached: true,
          cacheFallback: !exact,
          requestedDateRange: dateRange,
          cacheSavedAt: fallback.savedAtText,
          statuses: [{ name: "本地缓存", ok: true, message: `使用 ${fallback.savedAtText} 保存的数据`, durationMs: 0 }]
        }
      };
    }
  }
  const statuses = [];
  const [userStats, userIndex, businessSummary, businessPages, businessDaily] = await Promise.all([
    apiCall("用户统计汇总", "POST", "/api/v2/dashboard/summary/statistics", {}, 12000),
    apiCall("用户列表", "POST", "/api/v2/dashboard/summary/index", { page: 1, size: 50 }, 25000),
    fetchBusinessSummary(dateRange, statuses),
    fetchBusinessPages(statuses),
    fetchBusinessDaily(statuses, query)
  ]);
  statuses.push(userStats, userIndex);

  let businesses = mergeBusinessCatalog(businessPages.rows, businessSummary.businesses, dateRange);
  let users = asList(userIndex.data).map(row => normalizeUser(row, dateRange.endDate));
  if (businesses.length) lastGood.businesses = businesses;
  if (users.length) lastGood.users = users;
  if (businessSummary.hourlyTrend.length) lastGood.hourlyTrend = businessSummary.hourlyTrend;

  const summary = {
    orders: number(businessSummary.overview.order_valid) || businesses.reduce((sum, row) => sum + number(row.todayOrders), 0),
    todayOrders: businesses.reduce((sum, row) => sum + number(row.todayOrders), 0),
    yesterdayOrders: businesses.reduce((sum, row) => sum + number(row.yesterdayOrders), 0),
    users: number(userStats.data?.user_count),
    commission: number(businessSummary.overview.settle_amount_valid),
    paidAmount: number(businessSummary.overview.amount_valid),
    invalidOrders: number(businessSummary.overview.order_invalid),
    totalOrderNum: number(userStats.data?.total_order_num),
    totalAmount: number(userStats.data?.total_amount)
  };
  if (summary.orders || summary.users) lastGood.summary = summary;

  if (recordSnapshot) await maybeRecordSnapshot(businesses, users, false, businessDaily, summary);
  const snapshots = await readSnapshots();
  await ensureUserPhoneIndex(statuses);
  const enrichedBusinesses = enrichWithSnapshots(businesses, snapshots, "business", dateRange);
  const enrichedUsers = enrichWithSnapshots(users, snapshots, "users", dateRange);
  const failed = statuses.filter(item => !item.ok);
  const missing = failed.map(item => `${item.name}：${item.message}`);
  if (!snapshots.length) missing.push("当前还没有历史快照；服务会按配置持续记录，之后自动补出昨日同时刻、上周同时刻和近7日同期均值。");

  const payload = {
    ok: statuses.some(item => item.ok),
    latestDataTime: nowText(),
    refreshIntervalSeconds: Math.max(10, Number(config.refreshSeconds || 60)),
    config,
    userAliases: userAliases.aliases,
    dateRange,
    source: {
      baseUrl: BASE_URL,
      statuses: statuses.map(({ name, ok, status, code, message, durationMs }) => ({ name, ok, status, code, message, durationMs })),
      missing,
      snapshotCount: snapshots.length,
      lastSnapshotAt: snapshots.at(-1)?.createdAt || null,
      dataSource: "中台 /api/v2/order-statistic/summary-new、trend-new"
    },
    summary,
    hourlyTrend: businessSummary.hourlyTrend,
    businesses: attachBusinessUserSearchText(enrichedBusinesses),
    users: enrichedUsers,
    businessDaily
  };
  if (payload.ok && enrichedBusinesses.length) await writeDashboardCache(cacheKey, payload);
  return payload;
}

async function maybeRecordSnapshot(...args) {
  const run = () => recordSnapshot(...args);
  const result = snapshotRecordQueue.then(run, run);
  snapshotRecordQueue = result.catch(() => {});
  return result;
}

async function recordSnapshot(businesses, users, force = false, businessDaily = null, summary = null, options = {}) {
  const config = await readConfig();
  const intervalMinutes = Math.max(1, Number(config.snapshotMinutes || 30));
  const interval = intervalMinutes * 60 * 1000;
  const slot = options.manual ? manualSnapshotSlot() : (options.slot || snapshotSlot(new Date(), intervalMinutes));
  if (!force && Date.now() - lastSnapshotAt < interval) return false;
  if (!options.manual && lastSnapshotSlotKey === slot.key) return false;
  const recentSnapshots = await readSnapshots(200);
  if (!options.manual && recentSnapshots.some(item => item.snapshotSlotKey === slot.key || (item.day === slot.day && item.minuteOfDay === slot.minuteOfDay))) {
    lastSnapshotSlotKey = slot.key;
    return false;
  }
  const dateRange = rangeFromQuery();
  const previousSnapshot = recentSnapshots.at(-1) || null;
  await mkdir(join(ROOT, "data"), { recursive: true });
  const snapshot = {
    createdAt: new Date().toISOString(),
    createdAtText: nowText(),
    day: slot.day,
    minuteOfDay: slot.minuteOfDay,
    snapshotSlotKey: slot.key,
    snapshotSlotLabel: slot.label,
    actualMinuteOfDay: minuteOfDay(),
    userDataStrict: true,
    business: Object.fromEntries(businesses.map(row => [String(row.businessId), { name: row.name, platform: row.platform, orders: row.todayOrders, commission: row.todayCommission }])),
    users: Object.fromEntries(users.map(row => [String(row.id), { name: row.name, phone: row.phone, orders: row.todayOrders, commission: row.todayCommission }])),
    businessUsers: cachedBusinessUsersSnapshot(dateRange, slot.minuteOfDay)
  };
  await checkSnapshotHealth(snapshot, previousSnapshot, config);
  await appendFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot)}\n`);
  await pruneSnapshots();
  lastSnapshotAt = Date.now();
  if (!options.manual) lastSnapshotSlotKey = slot.key;
  if (config.public?.autoPush) {
    await publishPublicDashboard({ businesses, users, businessDaily, summary, snapshot, config }).catch(error => {
      console.error(`[${nowText()}] 公开看板推送失败：${error.message}`);
      notifyOperationalIssue("publicPublishFailed", "公开看板推送失败", error.message, config).catch(notifyError => console.error(`[${nowText()}] 飞书通知失败：${notifyError.message}`));
    });
  }
  return true;
}

function currentRefreshTime(config, date = new Date()) {
  const minute = minuteOfDay(date);
  const width = Math.max(10, number(config.snapshotMinutes || 10));
  return normalizeRefreshTimes(config.userRefreshTimes).find(value => {
    const [hour, minutes] = value.split(":").map(Number);
    const target = hour * 60 + minutes;
    return minute >= target && minute < target + width;
  }) || "";
}

async function runScheduledUserRefresh(businesses, config) {
  const time = currentRefreshTime(config);
  if (!time) return false;
  const key = `${dayKey()} ${time}`;
  if (userRefreshState.scheduledRuns[key]) return false;
  console.log(`[${nowText()}] 开始固定时段全量用户更新：${time}`);
  await warmBusinessUserHistories(businesses, { refresh: true });
  userRefreshState.scheduledRuns = Object.fromEntries(Object.entries(userRefreshState.scheduledRuns).filter(([item]) => item.startsWith(dayKey())));
  userRefreshState.scheduledRuns[key] = nowText();
  await saveUserRefreshState();
  console.log(`[${nowText()}] 固定时段全量用户历史更新完成：${time}`);
  return true;
}

async function checkSnapshotHealth(snapshot, previousSnapshot, config = defaultConfig) {
  const businesses = Object.values(snapshot.business || {});
  const totalOrders = businesses.reduce((sum, item) => sum + number(item.orders), 0);
  if (!businesses.length) {
    await notifyOperationalIssue("businessEmpty", "快照异常：业务为空", "本次快照没有业务数据，请检查中台接口或本地服务。", config);
    return;
  }
  if (!totalOrders) {
    await notifyOperationalIssue("ordersZero", "快照异常：订单全为 0", "本次快照业务总订单为 0，可能是中台接口异常或数据尚未回传。", config);
    return;
  }
  if (!previousSnapshot?.business) return;
  const currentEntries = Object.entries(snapshot.business);
  const comparable = currentEntries.filter(([id, item]) => {
    const prev = previousSnapshot.business[id];
    return prev && (number(prev.orders) > 0 || number(item.orders) > 0);
  });
  if (comparable.length < 20) return;
  const focusComparable = focusSnapshotBusinesses(comparable);
  const changedFocus = focusComparable.filter(([id, item]) => number(previousSnapshot.business[id].orders) !== number(item.orders));
  if (changedFocus.length) return;
  const same = comparable.filter(([id, item]) => number(previousSnapshot.business[id].orders) === number(item.orders));
  const ratio = same.length / comparable.length;
  if (ratio >= 0.95 && snapshot.minuteOfDay !== previousSnapshot.minuteOfDay) {
    await notifyOperationalIssue(
      "businessDataStale",
      "快照异常：大量业务数据未变化",
      `本次有 ${same.length}/${comparable.length} 个活跃业务订单数与上一条快照完全一致，且重点业务也未变化。重点业务按“美团外卖节、闪购、当前订单量前 5”判断，可能是中台接口返回旧数据。`,
      config
    );
  }
}

function focusSnapshotBusinesses(comparable) {
  const keywordItems = comparable.filter(([, item]) => /美团外卖节|闪购/.test(String(item.name || "")));
  const topItems = [...comparable]
    .sort((a, b) => number(b[1].orders) - number(a[1].orders))
    .slice(0, 5);
  const picked = new Map();
  [...keywordItems, ...topItems].forEach(([id, item]) => picked.set(id, [id, item]));
  return [...picked.values()];
}

async function scheduleSnapshots() {
  const scheduleVersion = ++snapshotScheduleVersion;
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  const config = await readConfig();
  if (scheduleVersion !== snapshotScheduleVersion) return;
  const intervalMinutes = Math.max(1, Number(config.snapshotMinutes || 30));
  const run = async () => {
    if (scheduleVersion !== snapshotScheduleVersion) return;
    const slot = snapshotSlot(new Date(), intervalMinutes);
    try {
      const data = await liveDashboard({ recordSnapshot: false });
      const currentConfig = await readConfig();
      if (data.source?.missing?.length) {
        await notifyOperationalIssue("apiDataMissing", "快照异常：接口数据缺失", data.source.missing.join("；"), currentConfig);
      }
      const dateRange = rangeFromQuery({ preset: "today", start_date: dayKey(), end_date: dayKey() });
      await warmTopBusinessUsers(data.businesses, dateRange, currentConfig);
      await refreshFocusUsersToday();
      await runScheduledUserRefresh(data.businesses, currentConfig);
      const recorded = await maybeRecordSnapshot(data.businesses, data.users, true, data.businessDaily, data.summary, { slot });
      console.log(`[${nowText()}] ${recorded ? `已记录业务用户快照：${slot.label}` : `跳过重复快照：${slot.label}`}`);
    } catch (error) {
      console.error(`[${nowText()}] 记录快照失败：${error.message}`);
      readConfig()
        .then(config => notifyOperationalIssue("snapshotRecordFailed", "快照异常：记录失败", error.message, config))
        .catch(notifyError => console.error(`[${nowText()}] 飞书通知失败：${notifyError.message}`));
    } finally {
      if (scheduleVersion === snapshotScheduleVersion) {
        snapshotTimer = setTimeout(run, nextSnapshotDelayMs(intervalMinutes));
      }
    }
  };
  const delay = nextSnapshotDelayMs(intervalMinutes);
  if (scheduleVersion !== snapshotScheduleVersion) return;
  snapshotTimer = setTimeout(run, delay);
  console.log(`[${nowText()}] 快照调度已对齐自然时间槽：每 ${intervalMinutes} 分钟，约 ${Math.round(delay / 1000)} 秒后执行下一次。`);
}

async function getPublicConfig() {
  const config = await readConfig();
  return {
    ...config,
    credentials: {
      hasUsername: Boolean(await readSecret(USER_SERVICE)),
      hasPassword: Boolean(await readSecret(PASS_SERVICE))
    },
    notification: {
      ...config.notification,
      hasWebhook: Boolean(await readSecret(FEISHU_WEBHOOK_SERVICE)),
      hasSignSecret: Boolean(await readSecret(FEISHU_SECRET_SERVICE))
    }
  };
}

async function saveConfig(body) {
  if (body.credentials?.username || body.credentials?.password) {
    const username = String(body.credentials?.username || await readSecret(USER_SERVICE) || "").trim();
    const password = String(body.credentials?.password || await readSecret(PASS_SERVICE) || "");
    if (!username || !password) throw new Error("中台账号和密码必须同时配置完整。");
    const nextToken = await loginWithCredentials(username, password);
    await writeSecret(USER_SERVICE, username);
    await writeSecret(PASS_SERVICE, password);
    token = nextToken;
    tokenExpiresAt = Date.now() + 20 * 60 * 1000;
  }
  if (body.feishu?.webhookUrl) await writeSecret(FEISHU_WEBHOOK_SERVICE, body.feishu.webhookUrl);
  if (body.feishu?.signSecret) await writeSecret(FEISHU_SECRET_SERVICE, body.feishu.signSecret);
  const current = await readConfig();
  await writeConfig({
    ...current,
    rules: body.rules || current.rules,
    refreshSeconds: Number(body.refreshSeconds || current.refreshSeconds || defaultConfig.refreshSeconds),
    snapshotMinutes: body.snapshotMinutes || current.snapshotMinutes,
    userRefreshTimes: body.userRefreshTimes || current.userRefreshTimes,
    // 高频业务只允许由业务列表开关修改，避免设置中心的旧页面覆盖整组勾选。
    fastUserBusinessIds: current.fastUserBusinessIds,
    notification: {
      ...current.notification,
      ...(body.notification || {}),
      events: { ...current.notification.events, ...(body.notification?.events || {}) }
    },
    public: { ...current.public, ...(body.public || {}) }
  });
  return getPublicConfig();
}

function mergeFocusUserRecords(items = []) {
  const users = new Map();
  for (const source of items) {
    const userId = String(source?.userId || source?.id || "").trim();
    if (!userId) continue;
    const current = users.get(userId) || {
      userId,
      name: "",
      phone: "-",
      version: "-",
      pendingProfile: true,
      addedAt: "",
      addedAtText: "",
      note: "",
      notes: [],
      noteUpdatedAt: "",
      noteUpdatedAtText: "",
      pinned: false,
      pinnedAt: "",
      businessHints: []
    };
    const candidateName = String(source.name || "").trim();
    if (candidateName && !candidateName.startsWith("用户 ") && candidateName !== "未填写昵称") current.name = candidateName;
    const phone = plainPhoneValue(userId, source.phone, current.phone);
    if (phone !== "-") current.phone = phone;
    if (source.version && source.version !== "-") current.version = source.version;
    const sourceAddedAt = String(source.addedAt || "");
    if (sourceAddedAt && (!current.addedAt || sourceAddedAt < current.addedAt)) {
      current.addedAt = sourceAddedAt;
      current.addedAtText = source.addedAtText || current.addedAtText;
    }
    const incomingNotes = Array.isArray(source.notes)
      ? source.notes
      : String(source.note || "").split("\n").filter(Boolean).map(text => ({ text }));
    const notesByText = new Map(current.notes.map(note => [String(note?.text || note || "").trim(), note]));
    incomingNotes.forEach(note => {
      const text = String(note?.text || note || "").trim().slice(0, 200);
      if (text && !notesByText.has(text)) notesByText.set(text, typeof note === "object" ? { ...note, text } : { text });
    });
    current.notes = [...notesByText.values()].slice(0, 20);
    current.note = current.notes.map(note => note.text).join("\n");
    if (String(source.noteUpdatedAt || "") > current.noteUpdatedAt) {
      current.noteUpdatedAt = source.noteUpdatedAt || "";
      current.noteUpdatedAtText = source.noteUpdatedAtText || "";
    }
    if (source.pinned) current.pinned = true;
    if (String(source.pinnedAt || "") > current.pinnedAt) current.pinnedAt = source.pinnedAt || "";
    const hints = Array.isArray(source.businessHints) ? source.businessHints : [];
    if (source.businessId || source.businessName) {
      hints.push({
        platform: source.platform || "",
        businessName: source.businessName || "",
        businessId: String(source.businessId || ""),
        catalogBusinessId: String(source.catalogBusinessId || "")
      });
    }
    const hintMap = new Map(current.businessHints.map(hint => [String(hint.businessId || hint.catalogBusinessId || hint.businessName), hint]));
    hints.forEach(hint => {
      const key = String(hint?.businessId || hint?.catalogBusinessId || hint?.businessName || "");
      if (key) hintMap.set(key, {
        platform: hint.platform || "",
        businessName: hint.businessName || hint.name || "",
        businessId: String(hint.businessId || hint.platformBusinessId || ""),
        catalogBusinessId: String(hint.catalogBusinessId || "")
      });
    });
    current.businessHints = [...hintMap.values()];
    current.pendingProfile = !(current.name || userProfileCache.get(userId)?.name);
    users.set(userId, current);
  }
  return [...users.values()];
}

async function readFocusUsers() {
  try {
    const saved = JSON.parse(await readFile(FOCUS_USERS_PATH, "utf8"));
    const sourceItems = Array.isArray(saved.items) ? saved.items : [];
    const items = mergeFocusUserRecords(sourceItems);
    if (saved.schemaVersion !== 2 || items.length !== sourceItems.length) {
      if (!existsSync(FOCUS_USERS_BACKUP_PATH)) await copyFile(FOCUS_USERS_PATH, FOCUS_USERS_BACKUP_PATH);
      const payload = { schemaVersion: 2, items, updatedAt: saved.updatedAt || new Date().toISOString(), updatedAtText: saved.updatedAtText || nowText() };
      await writeFile(FOCUS_USERS_PATH, JSON.stringify(payload, null, 2));
      console.log(`[${nowText()}] 重点用户已迁移为全局用户：${sourceItems.length} 条业务记录合并为 ${items.length} 位用户。`);
      return payload;
    }
    return { schemaVersion: 2, items, updatedAt: saved.updatedAt || "", updatedAtText: saved.updatedAtText || "" };
  } catch {
    return { schemaVersion: 2, items: [], updatedAt: "", updatedAtText: "" };
  }
}

async function writeFocusUsers(items) {
  const payload = { schemaVersion: 2, items: mergeFocusUserRecords(items), updatedAt: new Date().toISOString(), updatedAtText: nowText() };
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(FOCUS_USERS_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

async function readUserAliases() {
  try {
    const saved = JSON.parse(await readFile(USER_ALIASES_PATH, "utf8"));
    return { aliases: saved.aliases && typeof saved.aliases === "object" ? saved.aliases : {}, updatedAt: saved.updatedAt || "", updatedAtText: saved.updatedAtText || "" };
  } catch {
    return { aliases: {}, updatedAt: "", updatedAtText: "" };
  }
}

async function saveUserAlias(body) {
  const userId = String(body.userId || "").trim();
  const name = String(body.name || "").trim().slice(0, 40);
  if (!userId) throw new Error("缺少用户ID。");
  const saved = await readUserAliases();
  if (name) saved.aliases[userId] = name;
  else delete saved.aliases[userId];
  const payload = { aliases: saved.aliases, updatedAt: new Date().toISOString(), updatedAtText: nowText() };
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(USER_ALIASES_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function cachedUserForBusiness(businessId, userId) {
  let found = null;
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      if (String(key.businessId) !== String(businessId)) continue;
      const row = (payload.rows || []).find(item => String(item.id) === String(userId));
      if (row) found = { ...found, ...row, days: { ...(found?.days || {}), ...(row.days || {}) }, cacheSavedAtText: payload.savedAtText || found?.cacheSavedAtText || "" };
    } catch {}
  }
  return found ? attachPlainPhone(found) : null;
}

function focusUserCacheIndex(userIds = []) {
  const wanted = new Set([...userIds].map(String));
  const index = new Map();
  if (!wanted.size) return index;
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    let businessId = "";
    try { businessId = String(JSON.parse(cacheKey).businessId || ""); } catch {}
    if (!businessId || !Array.isArray(payload?.rows)) continue;
    for (const row of payload.rows) {
      const userId = String(row.id || row.userId || "");
      if (!wanted.has(userId)) continue;
      const key = `${businessId}:${userId}`;
      const current = index.get(key) || {};
      const incomingTime = Date.parse(String(payload.savedAtText || "").replaceAll("/", "-")) || 0;
      const currentTime = Date.parse(String(current.cacheSavedAtText || "").replaceAll("/", "-")) || 0;
      const incomingIsNewer = incomingTime >= currentTime;
      const merged = incomingIsNewer ? { ...current, ...row } : { ...row, ...current };
      merged.days = incomingIsNewer
        ? { ...(current.days || {}), ...(row.days || {}) }
        : { ...(row.days || {}), ...(current.days || {}) };
      merged.cacheSavedAtText = incomingIsNewer ? (payload.savedAtText || current.cacheSavedAtText || "") : current.cacheSavedAtText;
      index.set(key, attachPlainPhone(merged));
    }
  }
  return index;
}

function globalUserRelationshipIndex() {
  const index = new Map();
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    let businessId = "";
    try { businessId = String(JSON.parse(cacheKey).businessId || ""); } catch {}
    if (!businessId || !Array.isArray(payload?.rows)) continue;
    for (const row of payload.rows) {
      const userId = String(row.id || row.userId || "");
      if (!userId) continue;
      const current = index.get(userId) || { businessIds: new Set(), name: "", phone: "", version: "-" };
      current.businessIds.add(businessId);
      if (row.name && !String(row.name).startsWith("用户 ")) current.name = String(row.name);
      const phone = plainPhoneValue(userId, row.phone);
      if (phone !== "-") current.phone = phone;
      if (row.version && row.version !== "-") current.version = String(row.version);
      index.set(userId, current);
    }
  }
  return index;
}

async function globalUserCandidates(keyword, limit = 20) {
  const query = String(keyword || "").trim().toLowerCase();
  if (!query) return [];
  const aliases = (await readUserAliases()).aliases || {};
  const relationships = globalUserRelationshipIndex();
  const ids = new Set([...userProfileCache.keys(), ...relationships.keys(), ...Object.keys(aliases)]);
  const candidates = [];
  for (const userId of ids) {
    const profile = userProfileCache.get(String(userId)) || {};
    const cached = relationships.get(String(userId)) || {};
    const alias = String(aliases[userId] || "");
    const sourceName = String(cached.name || profile.name || "");
    const name = alias || sourceName || `用户 ${userId}`;
    const phone = plainPhoneValue(userId, cached.phone, profile.phone);
    const haystack = `${userId} ${alias} ${sourceName} ${phone}`.toLowerCase();
    if (!haystack.includes(query)) continue;
    let score = 0;
    if (String(userId).toLowerCase() === query) score += 1000;
    if (alias.toLowerCase() === query || sourceName.toLowerCase() === query) score += 800;
    else if (alias.toLowerCase().startsWith(query) || sourceName.toLowerCase().startsWith(query)) score += 500;
    score += Math.min(100, cached.businessIds?.size || 0);
    candidates.push({ userId: String(userId), name, sourceName: sourceName || name, phone, version: cached.version || "-", businessCount: cached.businessIds?.size || 0, score });
  }
  return candidates.sort((a, b) => b.score - a.score || b.businessCount - a.businessCount || a.name.localeCompare(b.name, "zh-CN")).slice(0, limit).map(({ score, ...item }) => item);
}

async function buildGlobalUserSearch(query = {}) {
  const keyword = String(query.q || query.keyword || "").trim();
  const requestedId = String(query.user_id || "").trim();
  const candidates = await globalUserCandidates(requestedId || keyword, 20);
  const selectedId = requestedId || (candidates.length === 1 ? candidates[0].userId : (candidates.find(item => item.userId === keyword)?.userId || ""));
  if (!selectedId) return { ok: true, query: keyword, candidates, selectedUserId: "", businessRows: [], rows: [] };
  const selected = candidates.find(item => item.userId === selectedId) || (await globalUserCandidates(selectedId, 1))[0] || { userId: selectedId, name: `用户 ${selectedId}`, phone: "-", version: "-", businessCount: 0 };
  if (query.refresh === "1") await discoverFocusUserBusinesses({ userId: selectedId, name: selected.name, phone: selected.phone, version: selected.version, businessHints: [] });
  const range = focusRange(query);
  const dates = dayList(range.startDate, range.endDate);
  const previousDates = dayList(range.comparisonStartDate, range.comparisonEndDate);
  const snapshots = await readSnapshots();
  const catalog = await focusBusinessCatalog();
  const cacheIndex = focusUserCacheIndex([selectedId]);
  const item = { userId: selectedId, name: selected.name, phone: selected.phone, version: selected.version, businessHints: [] };
  const businessRows = catalog.map(business => focusBusinessRow(item, business, dates, previousDates, snapshots, cacheIndex)).filter(Boolean);
  const todayOrders = businessRows.reduce((sum, row) => sum + number(row.todayOrders), 0);
  const comparable = businessRows.filter(row => row.yesterdaySameTime !== null && row.yesterdaySameTime !== undefined);
  const yesterdaySameTime = comparable.length ? comparable.reduce((sum, row) => sum + number(row.yesterdaySameTime), 0) : null;
  const periodTotal = businessRows.reduce((sum, row) => sum + number(row.periodTotal), 0);
  const previousPeriodTotal = businessRows.reduce((sum, row) => sum + number(row.previousPeriodTotal), 0);
  const latestTimes = businessRows.map(row => row.userDataTime).filter(Boolean).sort();
  return {
    ok: true,
    query: keyword,
    candidates,
    selectedUserId: selectedId,
    user: { ...selected, businessCount: businessRows.length, todayOrders, yesterdaySameTime, periodTotal, previousPeriodTotal },
    range,
    dates,
    businessRows,
    rows: businessRows,
    latestDataTime: latestTimes.at(-1) || userDetailCacheSavedAtText || "-"
  };
}

function cachedFocusCurrentUser(businessId, userId) {
  const key = JSON.stringify({ type: "focus-current", businessId: String(businessId), userId: String(userId), date: dayKey() });
  const payload = userDetailCache.get(key);
  const row = payload?.rows?.[0];
  return row ? { ...attachPlainPhone(row), savedAtText: payload.savedAtText || "-" } : null;
}

function focusRange(query = {}) {
  const today = dayKey();
  const preset = query.preset || "7";
  if (preset === "custom") {
    let endDate = parseDay(query.end_date || today);
    let startDate = parseDay(query.start_date || shiftDay(endDate, -6));
    if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
    if (dayList(startDate, endDate).length > 65) startDate = shiftDay(endDate, -64);
    const days = dayList(startDate, endDate).length;
    const comparisonEndDate = shiftDay(startDate, -1);
    return { preset, startDate, endDate, comparisonStartDate: shiftDay(comparisonEndDate, -(days - 1)), comparisonEndDate, label: `${startDate} 至 ${endDate}` };
  }
  if (preset === "week") {
    const current = dateFromDay(today);
    const offset = (current.getDay() + 6) % 7;
    const startDate = shiftDay(today, -offset);
    return { preset, startDate, endDate: today, comparisonStartDate: shiftDay(startDate, -7), comparisonEndDate: shiftDay(today, -7), label: "本周" };
  }
  if (preset === "7") return { preset, startDate: shiftDay(today, -6), endDate: today, comparisonStartDate: shiftDay(today, -13), comparisonEndDate: shiftDay(today, -7), label: "近7天" };
  if (preset === "30") return { preset, startDate: shiftDay(today, -29), endDate: today, comparisonStartDate: shiftDay(today, -59), comparisonEndDate: shiftDay(today, -30), label: "近30天" };
  const current = dateFromDay(today);
  const startDate = dayKey(new Date(current.getFullYear(), current.getMonth(), 1));
  const comparisonStartDate = dayKey(new Date(current.getFullYear(), current.getMonth() - 1, 1));
  const comparisonMonthEnd = new Date(current.getFullYear(), current.getMonth(), 0).getDate();
  const comparisonEndDate = dayKey(new Date(current.getFullYear(), current.getMonth() - 1, Math.min(current.getDate(), comparisonMonthEnd)));
  return { preset: "month", startDate, endDate: today, comparisonStartDate, comparisonEndDate, label: "本月" };
}

async function focusBusinessCatalog() {
  let rows = lastGood.businesses || [];
  if (!rows.length) {
    const cache = await readDashboardCache();
    rows = latestValidDashboardCache(cache)?.[1]?.payload?.businesses || [];
  }
  const byId = new Map();
  rows.forEach(row => {
    const businessId = String(row.platformBusinessId || row.businessId || "");
    if (!businessId) return;
    byId.set(businessId, {
      platform: row.platform || "-",
      businessName: row.name || row.businessName || "未命名业务",
      businessId,
      catalogBusinessId: String(row.businessId || "")
    });
  });
  return [...byId.values()];
}

function focusBusinessRow(item, business, dates, previousDates, snapshots, cacheIndex) {
    const cached = cacheIndex.get(`${business.businessId}:${item.userId}`) || {};
    const current = cachedFocusCurrentUser(business.businessId, item.userId);
    const days = Object.fromEntries(dates.map(date => [date, number(cached.days?.[date])]));
    if (dates.includes(dayKey())) {
      const hasDailyToday = cached.days && Object.prototype.hasOwnProperty.call(cached.days, dayKey());
      days[dayKey()] = current ? number(current.todayOrders) : (hasDailyToday ? number(cached.days[dayKey()]) : 0);
    }
    const total = Object.values(days).reduce((sum, value) => sum + number(value), 0);
    const previousPeriodTotal = previousDates.reduce((sum, date) => sum + number(cached.days?.[date]), 0);
    const periodDiff = total - previousPeriodTotal;
    const periodRatio = previousPeriodTotal ? periodDiff / previousPeriodTotal * 100 : null;
    const businessId = String(business.businessId);
    const userId = String(item.userId);
    const topState = userRefreshState.top100[businessId] || {};
    const userDataTime = current?.savedAtText || cached.cacheSavedAtText || topState.updatedAtText || "";
    const yesterdayMatch = businessUserSnapshotMatch(
      snapshots,
      shiftDay(dayKey(), -1),
      comparisonMinuteFromText(userDataTime),
      businessId,
      userId
    );
    const yesterdayReference = snapshotReference(yesterdayMatch, yesterdayMatch?.quality);
    const yesterdaySameTime = yesterdayMatch?.snapshot?.businessUsers?.[businessId]?.[userId]?.orders;
    const todayOrders = current ? number(current.todayOrders) : number(days[dayKey()]);
    const diff = yesterdaySameTime === undefined ? null : todayOrders - number(yesterdaySameTime);
    const ratio = yesterdaySameTime === undefined ? null : (number(yesterdaySameTime) ? diff / number(yesterdaySameTime) * 100 : (todayOrders ? 100 : 0));
    const row = {
      ...item,
      platform: business.platform,
      businessName: business.businessName,
      businessId,
      catalogBusinessId: business.catalogBusinessId,
      name: current?.name || cached.name || item.name,
      phone: plainPhoneValue(item.userId, current?.phone, cached.phone, item.phone),
      version: current?.version || cached.version || item.version || "-",
      pendingProfile: !(current?.name || cached.name),
      days,
      periodTotal: total,
      previousPeriodTotal,
      periodRatio,
      periodImpact: Math.abs(periodDiff),
      todayOrders,
      yesterdaySameTime: yesterdaySameTime === undefined ? null : number(yesterdaySameTime),
      sameTime: {
        yesterday: yesterdaySameTime === undefined ? null : { orders: number(yesterdaySameTime) },
        ...yesterdayReference,
        yesterdayReference
      },
      ...yesterdayReference,
      ratio,
      impact: diff === null ? null : Math.abs(diff),
      newTop100At: topState.entered?.[String(item.userId)] || "",
      realtimeToday: Boolean(current),
      userDataTime: userDataTime || userDetailCacheSavedAtText || "-"
    };
    const hinted = (item.businessHints || []).some(hint => String(hint.businessId || hint.catalogBusinessId) === businessId);
    const hasOrders = todayOrders > 0 || previousPeriodTotal > 0 || total > 0 || number(yesterdaySameTime) > 0;
    return hasOrders || hinted ? row : null;
}

async function buildFocusUsers(query = {}) {
  const saved = await readFocusUsers();
  const range = focusRange(query);
  const dates = dayList(range.startDate, range.endDate);
  const previousDates = dayList(range.comparisonStartDate, range.comparisonEndDate);
  const snapshots = await readSnapshots();
  const catalog = await focusBusinessCatalog();
  const cacheIndex = focusUserCacheIndex(saved.items.map(item => item.userId));
  const businessRows = [];
  for (const item of saved.items) {
    const hintMap = new Map(catalog.map(row => [row.businessId, row]));
    (item.businessHints || []).forEach(hint => {
      const businessId = String(hint.businessId || hint.catalogBusinessId || "");
      if (businessId && !hintMap.has(businessId)) hintMap.set(businessId, { ...hint, businessId, businessName: hint.businessName || "未命名业务" });
    });
    for (const business of hintMap.values()) {
      const row = focusBusinessRow(item, business, dates, previousDates, snapshots, cacheIndex);
      if (row) businessRows.push(row);
    }
  }
  const rowsByUser = new Map();
  businessRows.forEach(row => {
    const list = rowsByUser.get(String(row.userId)) || [];
    list.push(row);
    rowsByUser.set(String(row.userId), list);
  });
  const users = saved.items.map(item => {
    const rows = rowsByUser.get(String(item.userId)) || [];
    const profile = rows.find(row => row.name && !String(row.name).startsWith("用户 ")) || rows[0] || {};
    const days = Object.fromEntries(dates.map(date => [date, rows.reduce((sum, row) => sum + number(row.days?.[date]), 0)]));
    const periodTotal = rows.reduce((sum, row) => sum + number(row.periodTotal), 0);
    const previousPeriodTotal = rows.reduce((sum, row) => sum + number(row.previousPeriodTotal), 0);
    const todayOrders = rows.reduce((sum, row) => sum + number(row.todayOrders), 0);
    const comparable = rows.filter(row => row.yesterdaySameTime !== null && row.yesterdaySameTime !== undefined);
    const yesterdaySameTime = comparable.length ? comparable.reduce((sum, row) => sum + number(row.yesterdaySameTime), 0) : null;
    const diff = yesterdaySameTime === null ? null : todayOrders - yesterdaySameTime;
    return {
      ...item,
      name: profile.name || userProfileCache.get(String(item.userId))?.name || item.name || `用户 ${item.userId}`,
      phone: plainPhoneValue(item.userId, profile.phone, item.phone, userProfileCache.get(String(item.userId))?.phone),
      version: profile.version || item.version || "-",
      pendingProfile: !(profile.name || item.name || userProfileCache.get(String(item.userId))?.name),
      businessCount: rows.length,
      days,
      periodTotal,
      previousPeriodTotal,
      periodRatio: previousPeriodTotal ? (periodTotal - previousPeriodTotal) / previousPeriodTotal * 100 : null,
      periodImpact: Math.abs(periodTotal - previousPeriodTotal),
      todayOrders,
      yesterdaySameTime,
      ratio: yesterdaySameTime === null ? null : (yesterdaySameTime ? diff / yesterdaySameTime * 100 : (todayOrders ? 100 : 0)),
      impact: diff === null ? null : Math.abs(diff),
      userDataTime: rows.map(row => row.userDataTime).filter(Boolean).sort().at(-1) || "-"
    };
  });
  const businessMap = new Map();
  businessRows.forEach(row => {
    const current = businessMap.get(row.businessId) || { businessId: row.businessId, catalogBusinessId: row.catalogBusinessId, businessName: row.businessName, platform: row.platform, count: 0 };
    current.count += 1;
    businessMap.set(row.businessId, current);
  });
  const currentTimes = businessRows.map(row => row.userDataTime).filter(Boolean).sort();
  return {
    ok: true,
    schemaVersion: 2,
    focusUpdatedAt: saved.updatedAt || "",
    range,
    dates,
    users,
    businessRows,
    rows: businessRows,
    businesses: [...businessMap.values()].sort((a, b) => a.businessName.localeCompare(b.businessName, "zh-CN")),
    total: users.length,
    relationshipTotal: businessRows.length,
    realtimeUserCount: businessRows.filter(row => row.realtimeToday).length,
    latestDataTime: currentTimes.at(-1) || userDetailCacheSavedAtText || "-"
  };
}

async function addFocusUser(body) {
  const userId = String(body.userId || "").trim();
  if (!userId) throw new Error("请填写用户ID。");
  const businessId = String(body.businessId || "");
  const catalog = await focusBusinessCatalog();
  const business = catalog.find(row => row.businessId === businessId || row.catalogBusinessId === businessId);
  let user = business ? cachedUserForBusiness(business.businessId, userId) : null;
  if (!user) {
    for (const row of catalog) {
      user = cachedUserForBusiness(row.businessId, userId);
      if (user) break;
    }
  }
  user = user || userProfileCache.get(userId) || {};
  const saved = await readFocusUsers();
  const existing = saved.items.find(item => String(item.userId) === userId);
  if (existing) {
    if (business && !(existing.businessHints || []).some(hint => String(hint.businessId) === business.businessId)) existing.businessHints = [...(existing.businessHints || []), business];
    return writeFocusUsers(saved.items);
  }
  saved.items.push({
    userId,
    name: user.name || `用户 ${userId}`,
    phone: plainPhoneValue(userId, user.phone),
    version: user.version || "-",
    pendingProfile: !user.name,
    businessHints: business ? [business] : [],
    addedAt: new Date().toISOString(),
    addedAtText: nowText()
  });
  return writeFocusUsers(saved.items);
}

async function removeFocusUser(body) {
  const userId = String(body.userId || "");
  const saved = await readFocusUsers();
  return writeFocusUsers(saved.items.filter(item => String(item.userId) !== userId));
}

async function saveFocusUserNote(body) {
  const userId = String(body.userId || "");
  if (!userId) throw new Error("缺少用户ID。");
  const saved = await readFocusUsers();
  const index = saved.items.findIndex(item => String(item.userId) === userId);
  if (index < 0) throw new Error("重点用户不存在，请刷新后重试。");
  const previousNotes = Array.isArray(saved.items[index].notes)
    ? saved.items[index].notes
    : String(saved.items[index].note || "").split("\n").filter(Boolean).map(text => ({ text }));
  const requested = Array.isArray(body.notes) ? body.notes : String(body.note || "").split("\n");
  const texts = requested.map(value => String(value?.text || value || "").trim().slice(0, 200)).filter(Boolean).slice(0, 20);
  const existingByText = new Map(previousNotes.map(value => [String(value?.text || value || ""), value]));
  const notes = texts.map(text => existingByText.get(text) || { text, createdAt: new Date().toISOString(), createdAtText: nowText() });
  saved.items[index] = {
    ...saved.items[index],
    note: texts.join("\n"),
    notes,
    noteUpdatedAt: new Date().toISOString(),
    noteUpdatedAtText: nowText()
  };
  return writeFocusUsers(saved.items);
}

async function saveFocusUserPin(body) {
  const userId = String(body.userId || "");
  if (!userId) throw new Error("缺少用户ID。");
  const saved = await readFocusUsers();
  const index = saved.items.findIndex(item => String(item.userId) === userId);
  if (index < 0) throw new Error("重点用户不存在，请刷新后重试。");
  const pinned = Boolean(body.pinned);
  saved.items[index] = {
    ...saved.items[index],
    pinned,
    pinnedAt: pinned ? new Date().toISOString() : ""
  };
  return writeFocusUsers(saved.items);
}

async function testFeishu() {
  await sendFeishuText(`业务异常监控测试消息：${nowText()}。如果你收到这条消息，说明 Webhook 可用。`);
  return { ok: true, message: "测试成功，飞书机器人已返回成功状态。" };
}

async function sendFeishuText(text) {
  const webhook = await readSecret(FEISHU_WEBHOOK_SERVICE);
  const secret = await readSecret(FEISHU_SECRET_SERVICE);
  if (!webhook) throw new Error("请先配置飞书 Webhook URL");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    msg_type: "text",
    content: { text }
  };
  if (secret) {
    payload.timestamp = timestamp;
    payload.sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
  }
  const response = await fetchWithTimeout(webhook, {
    method: "POST",
    headers: { "content-type": "application/json;charset=utf-8" },
    body: JSON.stringify(payload)
  }, 10000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code && data.code !== 0)) throw new Error(data.msg || data.message || "飞书测试消息发送失败");
  return { ok: true };
}

async function notifyOperationalIssue(eventKey, title, detail, config = defaultConfig) {
  if (!config.notification?.enabled || !config.notification?.snapshotAlert) return;
  if (config.notification?.events?.[eventKey] === false) return;
  const key = eventKey || title;
  if (lastOperationalAlert.key === key && Date.now() - lastOperationalAlert.at < 60 * 60 * 1000) return;
  lastOperationalAlert = { key, at: Date.now() };
  try {
    await sendFeishuText(`业务异常监控\n${title}\n时间：${nowText()}\n说明：${detail}\n处理建议：打开本机看板或桌面“业务用户看板服务.command”查看服务状态。`);
  } catch (error) {
    console.error(`[${nowText()}] 飞书通知失败：${error.message}`);
  }
}

async function runCommand(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd: ROOT });
  return `${stdout || ""}${stderr || ""}`.trim();
}

async function encryptedPublicUserDetails(dateRange) {
  const snapshots = await readSnapshots();
  const details = {};
  const historyRanks = new Map();
  const detailRanks = new Map();
  const timeValue = value => {
    const parsed = Date.parse(String(value || "").replace(/\//g, "-"));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      const id = String(key.businessId || "");
      if (!id) continue;
      if (key.type === "history") {
        const rank = [String(key.endDate || ""), (payload.dates || []).length, timeValue(payload.savedAtText)];
        const previous = historyRanks.get(id);
        if (previous && (rank[0] < previous[0] || (rank[0] === previous[0] && rank[1] < previous[1]) || (rank[0] === previous[0] && rank[1] === previous[1] && rank[2] <= previous[2]))) continue;
        historyRanks.set(id, rank);
        details[id] = details[id] || {};
        details[id].history = {
          latestDataTime: payload.savedAtText || "-",
          total: payload.total || payload.rows?.length || 0,
          dates: payload.dates || [],
          rows: payload.rows || []
        };
        continue;
      }
      if (key.startDate !== dateRange.startDate || key.endDate !== dateRange.endDate) continue;
      const rank = [timeValue(payload.savedAtText), (payload.rows || []).length];
      const previous = detailRanks.get(id);
      if (previous && (rank[0] < previous[0] || (rank[0] === previous[0] && rank[1] <= previous[1]))) continue;
      detailRanks.set(id, rank);
      const realtimeToday = key.includePrevious === false && key.startDate === dayKey() && key.endDate === dayKey();
      const rows = enrichBusinessUsersWithSnapshots(
        (payload.rows || []).map(row => ({ ...row, currentDataTime: payload.savedAtText || "" })),
        snapshots,
        id,
        dateRange,
        comparisonMinuteFromText(payload.savedAtText)
      )
        .map(row => ({ ...row, realtimeToday }));
      details[id] = {
        ...(details[id] || {}),
        latestDataTime: payload.savedAtText || "-",
        currentLatestDataTime: payload.savedAtText || "-",
        realtimeUserCount: realtimeToday ? rows.length : 0,
        total: payload.total || rows.length,
        rows
      };
    } catch {
      // Ignore old cache keys that are not JSON.
    }
  }
  for (const [businessId, detail] of Object.entries(details)) {
    if (detail?.rows?.length) detail.rows = deduplicateBusinessUsers(detail.rows);
    if (detail?.history?.rows?.length) {
      detail.history.rows = deduplicateBusinessUsers(detail.history.rows);
      detail.history.dates = [...new Set(detail.history.dates || [])].sort();
      detail.history.total = detail.history.rows.length;
      detail.historyLatestDataTime = detail.history.latestDataTime || "-";
    }
    const t1Detail = buildT1BusinessUserDetail(detail.history, businessId);
    if (t1Detail) {
      Object.assign(detail, t1Detail);
      continue;
    }
    if (dateRange.endDate !== dayKey()) continue;
    const full = latestFullBusinessUsers(businessId, dateRange.endDate);
    if (!full) continue;
    const fast = latestFastBusinessUsers(businessId, dateRange.endDate);
    const fullTime = timeValue(full.savedAtText);
    const fastIsNewer = timeValue(fast?.savedAtText) > fullTime;
    const currentById = new Map(deduplicateBusinessUsers(full.rows || []).map(row => [String(row.id || ""), { ...row, currentDataTime: full.savedAtText || "" }]));
    if (fastIsNewer) {
      for (const row of deduplicateBusinessUsers(fast.rows || [])) currentById.set(String(row.id || ""), { ...row, currentDataTime: fast.savedAtText || "" });
    }
    const historyRows = detail.history?.rows || [];
    const mergedRows = historyRows.map(row => {
      const current = currentById.get(String(row.id || ""));
      return {
        ...row,
        ...(current || {}),
        currentDataTime: current?.currentDataTime || full.savedAtText || "",
        days: { ...(row.days || {}), [dateRange.endDate]: number(current?.todayOrders) },
        todayOrders: number(current?.todayOrders),
        realtimeToday: true
      };
    });
    const historyIds = new Set(historyRows.map(row => String(row.id || "")));
    for (const row of currentById.values()) {
      if (!historyIds.has(String(row.id || ""))) mergedRows.push({ ...row, days: { [dateRange.endDate]: number(row.todayOrders) }, realtimeToday: true });
    }
    const currentLatestDataTime = fastIsNewer ? fast.savedAtText : full.savedAtText;
    detail.rows = enrichBusinessUsersWithSnapshots(mergedRows, snapshots, businessId, dateRange, comparisonMinuteFromText(currentLatestDataTime));
    detail.total = full.total || detail.rows.length;
    detail.latestDataTime = currentLatestDataTime;
    detail.currentLatestDataTime = detail.latestDataTime;
    detail.fullCurrentLatestDataTime = full.savedAtText || "-";
    detail.realtimeUserCount = fastIsNewer ? deduplicateBusinessUsers(fast.rows || []).length : 0;
  }
  return details;
}

async function encryptedPublicBusinessTrends(businesses = []) {
  const preferred = businesses.find(row => String(row.name || "").includes("美团外卖节"));
  const fallback = businesses.find(row => row.platformBusinessId || row.businessId);
  const row = preferred || fallback;
  const id = String(row?.platformBusinessId || row?.businessId || "");
  if (!id) return {};
  const statuses = [];
  try {
    const trend = await fetchBusinessHourlyTrend({ platformBusinessId: id, currentDate: dayKey() }, statuses);
    return trend.ok ? { [id]: trend } : {};
  } catch (error) {
    console.error(`[${nowText()}] 生成公网业务趋势失败：${error.message}`);
    return {};
  }
}

async function sanitizePublicDashboard(data) {
  const dateRange = data.dateRange || rangeFromQuery();
  const userAliases = await readUserAliases();
  return {
    ok: true,
    latestDataTime: nowText(),
    dateRange,
    userAliases: userAliases.aliases,
    config: {
      rules: data.config?.rules || defaultConfig.rules,
      refreshSeconds: data.config?.refreshSeconds || defaultConfig.refreshSeconds,
      snapshotMinutes: data.config?.snapshotMinutes || defaultConfig.snapshotMinutes,
      userRefreshTimes: data.config?.userRefreshTimes || defaultConfig.userRefreshTimes,
      fastUserBusinessIds: data.config?.fastUserBusinessIds || []
    },
    source: {
      publicSnapshot: true,
      encrypted: true,
      snapshotCreatedAt: data.snapshot?.createdAt || new Date().toISOString(),
      snapshotCreatedAtText: data.snapshot?.createdAtText || nowText(),
      dataSource: "本机服务加密公开快照"
    },
    summary: data.summary || null,
    businesses: data.businesses || [],
    users: data.users || [],
    businessDaily: data.businessDaily || null,
    businessTrends: await encryptedPublicBusinessTrends(data.businesses || []),
    userDetails: await encryptedPublicUserDetails(dateRange),
    focusUsers: await buildFocusUsers({ preset: "7" }),
    focusUsersByRange: {
      7: await buildFocusUsers({ preset: "7" }),
      month: await buildFocusUsers({ preset: "month" }),
      30: await buildFocusUsers({ preset: "30" }),
      65: await buildFocusUsers({ preset: "custom", start_date: shiftDay(dayKey(), -64), end_date: dayKey() })
    }
  };
}

async function publishLatestCachedDashboard() {
  const cache = await readDashboardCache();
  const cached = latestValidDashboardCache(cache)?.[1]?.payload;
  if (!cached) return false;
  const config = await readConfig();
  await publishPublicDashboard({ ...cached, config, snapshot: null });
  return true;
}

function enqueuePublicPublish(task) {
  const next = publicPublishQueue.catch(() => {}).then(task);
  publicPublishQueue = next.catch(() => {});
  return next;
}

async function encryptPublicPayload(payload, { compression = "gzip", contentHash = "" } = {}) {
  const password = await readSecret(PUBLIC_PASSWORD_SERVICE);
  if (!password) throw new Error("缺少公网看板访问密码，请先写入钥匙串。");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const iterations = PUBLIC_KDF_ITERATIONS;
  const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const source = Buffer.from(JSON.stringify(payload), "utf8");
  const plaintext = compression === "gzip" ? gzipSync(source) : source;
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    compression,
    contentHash,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
    updatedAt: new Date().toISOString(),
    updatedAtText: nowText()
  };
}

async function writePublicUserDetailShards(details = {}) {
  await mkdir(PUBLIC_USER_DETAIL_DIR, { recursive: true });
  const manifest = {};
  for (const [id, detail] of Object.entries(details)) {
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeId) continue;
    const contentHash = createHash("sha256").update(JSON.stringify(detail)).digest("hex");
    const filePath = join(PUBLIC_USER_DETAIL_DIR, `${safeId}.enc.json`);
    let shouldWrite = true;
    if (existsSync(filePath)) {
      try {
        const current = JSON.parse(await readFile(filePath, "utf8"));
        shouldWrite = current.contentHash !== contentHash || current.compression !== "gzip" || Number(current.iterations) !== PUBLIC_KDF_ITERATIONS;
      } catch {}
    }
    if (shouldWrite) {
      const encrypted = await encryptPublicPayload(detail, { compression: "gzip", contentHash });
      await writeFile(filePath, JSON.stringify(encrypted));
    }
    manifest[id] = {
      shard: `data/business-public-users/${safeId}.enc.json`,
      latestDataTime: detail.latestDataTime || detail.history?.latestDataTime || "-",
      total: detail.history?.total || detail.total || 0
    };
  }
  return manifest;
}

async function writePublicGlobalUserIndex() {
  const aliases = (await readUserAliases()).aliases || {};
  const relationships = globalUserRelationshipIndex();
  const users = [...relationships.entries()].map(([userId, relation]) => {
    const profile = userProfileCache.get(String(userId)) || {};
    const sourceName = String(relation.name || profile.name || "");
    return {
      userId: String(userId),
      name: String(aliases[userId] || sourceName || `用户 ${userId}`),
      sourceName: sourceName || `用户 ${userId}`,
      phone: plainPhoneValue(userId, relation.phone, profile.phone),
      version: relation.version || "-",
      businessIds: [...relation.businessIds]
    };
  });
  const payload = { ok: true, updatedAt: new Date().toISOString(), updatedAtText: nowText(), users };
  const contentHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  let shouldWrite = true;
  if (existsSync(PUBLIC_GLOBAL_USER_INDEX_PATH)) {
    try {
      const current = JSON.parse(await readFile(PUBLIC_GLOBAL_USER_INDEX_PATH, "utf8"));
      shouldWrite = current.contentHash !== contentHash || current.compression !== "gzip" || Number(current.iterations) !== PUBLIC_KDF_ITERATIONS;
    } catch {}
  }
  if (shouldWrite) await writeFile(PUBLIC_GLOBAL_USER_INDEX_PATH, JSON.stringify(await encryptPublicPayload(payload, { compression: "gzip", contentHash })));
  return { shard: "data/business-global-user-index.enc.json", total: users.length, updatedAtText: payload.updatedAtText };
}

async function publishPublicDashboardNow(data) {
  const payload = await sanitizePublicDashboard(data);
  payload.userDetails = await writePublicUserDetailShards(payload.userDetails || {});
  payload.globalUserIndex = await writePublicGlobalUserIndex();
  const encryptedPayload = await encryptPublicPayload(payload, { compression: "gzip" });
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(PUBLIC_DASHBOARD_PATH, JSON.stringify(encryptedPayload, null, 2));
  await pushPublicDashboard();
}

async function publishPublicDashboard(data) {
  return enqueuePublicPublish(() => publishPublicDashboardNow(data));
}

async function publishPublicFocusNotes() {
  return enqueuePublicPublish(async () => {
    const saved = await readFocusUsers();
    const notes = Object.fromEntries(saved.items.map(item => {
      const lines = Array.isArray(item.notes)
        ? item.notes.map(value => String(value?.text || value || "").trim()).filter(Boolean)
        : String(item.note || "").split("\n").map(value => value.trim()).filter(Boolean);
      return [String(item.userId), lines];
    }));
    const pins = Object.fromEntries(saved.items.map(item => [
      String(item.userId),
      { pinned: Boolean(item.pinned), pinnedAt: item.pinnedAt || "" }
    ]));
    const encrypted = await encryptPublicPayload({ ok: true, updatedAt: saved.updatedAt, notes, pins }, { compression: "gzip" });
    await mkdir(join(ROOT, "data"), { recursive: true });
    await writeFile(PUBLIC_FOCUS_NOTES_PATH, JSON.stringify(encrypted));
    await pushPublicFocusNotes();
  });
}

async function pushPublicDashboard() {
  await runCommand("git", ["add", ".gitignore", "README.md", "index.html", "business-user-dashboard-prototype.html", "dashboard-live-server.mjs", "scripts/start-business-user-dashboard-service.zsh", "vendor/fflate.min.js", "vendor/fflate.LICENSE", "data/business-dashboard-public.enc.json", "data/business-global-user-index.enc.json", "data/business-public-users"]);
  const status = await runCommand("git", ["status", "--short", "--", ".gitignore", "README.md", "index.html", "business-user-dashboard-prototype.html", "dashboard-live-server.mjs", "scripts/start-business-user-dashboard-service.zsh", "vendor/fflate.min.js", "vendor/fflate.LICENSE", "data/business-dashboard-public.enc.json", "data/business-global-user-index.enc.json", "data/business-public-users"]);
  if (!status) {
    console.log(`[${nowText()}] 业务看板公开文件没有变化，跳过 GitHub 推送。`);
    return false;
  }
  await runCommand("git", ["commit", "-m", `Update business dashboard ${nowText()}`]);
  await runCommand("git", ["push", "origin", "main"]);
  console.log(`[${nowText()}] 业务看板公开文件已推送到 GitHub。`);
  return true;
}

async function pushPublicFocusNotes() {
  const paths = ["business-user-dashboard-prototype.html", "dashboard-live-server.mjs", "README.md", "data/business-focus-notes-public.enc.json"];
  await runCommand("git", ["add", ...paths]);
  const status = await runCommand("git", ["status", "--short", "--", ...paths]);
  if (!status) return false;
  await runCommand("git", ["commit", "-m", `Update focus notes ${nowText()}`]);
  await runCommand("git", ["push", "origin", "main"]);
  console.log(`[${nowText()}] 重点用户备注已快速推送到 GitHub。`);
  return true;
}

async function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const path = join(ROOT, file);
  try {
    const content = await readFile(path);
    const extension = extname(path);
    res.writeHead(200, {
      "content-type": mime[extension] || "application/octet-stream",
      ...(extension === ".html" ? { "cache-control": "no-cache, no-store, must-revalidate" } : {})
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (url.pathname === "/api/live-dashboard") {
      const query = Object.fromEntries(url.searchParams.entries());
      // Old or duplicated browser tabs must never turn their periodic page check into a full upstream refresh.
      if (query.force !== "1") query.cache = "1";
      return json(res, 200, await liveDashboard({ recordSnapshot: false, query }));
    }
    if (url.pathname === "/api/business-users-sync") {
      const statuses = [];
      const endDate = parseDay(url.searchParams.get("end_date") || dayKey());
      const startDate = parseDay(url.searchParams.get("start_date") || shiftDay(endDate, -64));
      const result = await fetchSynchronizedBusinessUsers({
        businessId: url.searchParams.get("business_id") || "",
        startDate,
        endDate,
        pageSize: number(url.searchParams.get("page_size")) || 5000,
        refresh: url.searchParams.get("refresh") === "1"
      }, statuses);
      return json(res, 200, { ...result, source: { statuses } });
    }
    if (url.pathname === "/api/business-users") {
      const statuses = [];
      const startDate = parseDay(url.searchParams.get("start_date") || dayKey());
      const endDate = parseDay(url.searchParams.get("end_date") || startDate);
      const result = await fetchBusinessUsers({
        businessId: url.searchParams.get("business_id") || "",
        startDate,
        endDate,
        page: number(url.searchParams.get("page")) || 1,
        pageSize: number(url.searchParams.get("page_size")) || 100,
        sortField: url.searchParams.get("sort_field") || "",
        sortOrder: url.searchParams.get("sort_order") || "",
        refresh: url.searchParams.get("refresh") === "1"
      }, statuses);
      const snapshots = await readSnapshots();
      const users = enrichBusinessUsersWithSnapshots(
        result.rows.map(row => ({ ...row, currentDataTime: result.savedAtText || "" })),
        snapshots,
        url.searchParams.get("business_id") || "",
        rangeFromQuery({ start_date: startDate, end_date: endDate }),
        comparisonMinuteFromText(result.savedAtText)
      );
      const topState = userRefreshState.top100[String(url.searchParams.get("business_id") || "")] || {};
      users.forEach(user => { user.newTop100At = topState.entered?.[String(user.id)] || ""; });
      return json(res, 200, { ok: result.ok, cached: Boolean(result.cached), latestDataTime: result.savedAtText || topState.updatedAtText || userDetailCacheSavedAtText || "-", users, total: result.total, userOrderSum: users.reduce((sum, row) => sum + number(row.todayOrders), 0), page: result.page, pageSize: result.pageSize, source: { statuses } });
    }
    if (url.pathname === "/api/business-users-history") {
      const statuses = [];
      const endDate = parseDay(url.searchParams.get("end_date") || dayKey());
      const startDate = parseDay(url.searchParams.get("start_date") || shiftDay(endDate, -6));
      const result = await fetchBusinessUserHistory({
        businessId: url.searchParams.get("business_id") || "",
        startDate,
        endDate,
        pageSize: number(url.searchParams.get("page_size")) || 5000,
        refresh: url.searchParams.get("refresh") === "1"
      }, statuses);
      return json(res, 200, { ok: result.ok, cached: Boolean(result.cached), latestDataTime: result.savedAtText || "-", dates: result.dates, rows: result.rows, total: result.total, source: { statuses } });
    }
    if (url.pathname === "/api/config" && req.method === "GET") return json(res, 200, await getPublicConfig());
    if (url.pathname === "/api/config" && req.method === "POST") return json(res, 200, { ok: true, config: await saveConfig(await readBody(req)) });
    if (url.pathname === "/api/business-refresh" && req.method === "POST") {
      const body = await readBody(req);
      const current = await readConfig();
      const id = String(body.platformBusinessId || body.businessId || "");
      const aliasId = String(body.businessId || "");
      const ids = new Set((current.fastUserBusinessIds || []).map(String));
      if (body.enabled) {
        if (aliasId) ids.delete(aliasId);
        if (id) ids.add(id);
      } else {
        if (id) ids.delete(id);
        if (aliasId) ids.delete(aliasId);
      }
      const config = await writeConfig({ ...current, fastUserBusinessIds: [...ids] });
      return json(res, 200, { ok: true, config });
    }
    if (url.pathname === "/api/global-user-search" && req.method === "GET") return json(res, 200, await buildGlobalUserSearch(Object.fromEntries(url.searchParams.entries())));
    if (url.pathname === "/api/focus-users" && req.method === "GET") return json(res, 200, await buildFocusUsers(Object.fromEntries(url.searchParams.entries())));
    if (url.pathname === "/api/focus-users/state" && req.method === "GET") {
      const saved = await readFocusUsers();
      return json(res, 200, { ok: true, updatedAt: saved.updatedAt || "", total: saved.items?.length || 0 });
    }
    if (url.pathname === "/api/focus-users" && req.method === "POST") {
      const body = await readBody(req);
      const saved = await addFocusUser(body);
      const data = await buildFocusUsers({ preset: "7" });
      json(res, 200, { ok: true, saved, data, syncing: true });
      const item = saved.items?.find(row => String(row.userId) === String(body.userId));
      Promise.resolve(item ? discoverFocusUserBusinesses(item) : false)
        .then(() => publishLatestCachedDashboard())
        .catch(error => console.error(`[${nowText()}] 重点用户后台补全或公网同步失败：${error.message}`));
      return;
    }
    if (url.pathname === "/api/focus-users/remove" && req.method === "POST") {
      const saved = await removeFocusUser(await readBody(req));
      const data = await buildFocusUsers({ preset: "7" });
      const published = await publishLatestCachedDashboard().catch(error => {
        console.error(`[${nowText()}] 重点用户公网同步失败：${error.message}`);
        return false;
      });
      return json(res, 200, { ok: true, saved, data, published });
    }
    if (url.pathname === "/api/focus-users/note" && req.method === "POST") {
      const saved = await saveFocusUserNote(await readBody(req));
      json(res, 200, { ok: true, saved: { updatedAt: saved.updatedAt, updatedAtText: saved.updatedAtText }, syncing: true });
      publishPublicFocusNotes().catch(error => {
        console.error(`[${nowText()}] 重点用户观察备注公网同步失败：${error.message}`);
      });
      return;
    }
    if (url.pathname === "/api/focus-users/pin" && req.method === "POST") {
      const saved = await saveFocusUserPin(await readBody(req));
      json(res, 200, { ok: true, saved: { updatedAt: saved.updatedAt, updatedAtText: saved.updatedAtText }, syncing: true });
      publishPublicFocusNotes().catch(error => {
        console.error(`[${nowText()}] 重点用户置顶状态公网同步失败：${error.message}`);
      });
      return;
    }
    if (url.pathname === "/api/user-aliases" && req.method === "GET") return json(res, 200, { ok: true, ...(await readUserAliases()) });
    if (url.pathname === "/api/user-aliases" && req.method === "POST") {
      const saved = await saveUserAlias(await readBody(req));
      const published = await publishLatestCachedDashboard().catch(error => {
        console.error(`[${nowText()}] 用户备注公网同步失败：${error.message}`);
        return false;
      });
      return json(res, 200, { ok: true, ...saved, published });
    }
    if (url.pathname === "/api/request-stats") return json(res, 200, { ok: true, stats: requestStats });
    if (url.pathname === "/api/feishu/test" && req.method === "POST") {
      try {
        return json(res, 200, await testFeishu());
      } catch (error) {
        return json(res, 200, { ok: false, error: error.message, latestDataTime: nowText() });
      }
    }
    if (url.pathname === "/api/business-hourly-trend") {
      const statuses = [];
      const data = await fetchBusinessHourlyTrend({
        platformBusinessId: url.searchParams.get("platform_business_id") || url.searchParams.get("business_id") || "",
        currentDate: parseDay(url.searchParams.get("date") || dayKey())
      }, statuses);
      return json(res, 200, { ...data, source: { statuses }, latestDataTime: nowText() });
    }
    if (url.pathname === "/api/snapshot" && req.method === "POST") {
      const data = await liveDashboard({ recordSnapshot: false });
      const recorded = await maybeRecordSnapshot(data.businesses, data.users, true, data.businessDaily, data.summary, { manual: true });
      const config = await readConfig();
      let published = true;
      await publishPublicDashboard({ ...data, snapshot: null, config }).catch(error => {
        published = false;
        console.error(`[${nowText()}] 手动公开看板推送失败：${error.message}`);
      });
      return json(res, 200, { ok: true, recorded, published, latestDataTime: nowText() });
    }
    if (url.pathname === "/api/snapshot-slots") {
      const config = await readConfig();
      const day = parseDay(url.searchParams.get("day") || dayKey());
      const intervalMinutes = Math.max(1, Number(config.snapshotMinutes || 30));
      const snapshots = (await readSnapshots()).filter(item => item.day === day);
      const bySlot = new Map(snapshots.map(item => [item.snapshotSlotKey || `${item.day}-${String(item.minuteOfDay).padStart(4, "0")}`, item]));
      const slots = expectedSnapshotSlots(day, intervalMinutes).map(slot => {
        const snapshot = bySlot.get(slot.key);
        return {
          ...slot,
          recorded: Boolean(snapshot),
          createdAtText: snapshot?.createdAtText || "",
          actualMinuteOfDay: snapshot?.actualMinuteOfDay ?? snapshot?.minuteOfDay ?? null,
          businessCount: snapshot ? Object.keys(snapshot.business || {}).length : 0
        };
      });
      return json(res, 200, {
        ok: true,
        day,
        intervalMinutes,
        totalSlots: slots.length,
        recordedSlots: slots.filter(item => item.recorded).length,
        slots
      });
    }
    await serveFile(req, res);
  } catch (error) {
    json(res, 500, { ok: false, error: error.message, latestDataTime: nowText() });
  }
});

server.listen(PORT, HOST, async () => {
  await scheduleSnapshots();
  console.log(`业务异常监控看板已启动：http://127.0.0.1:${PORT}/`);
  console.log(`同一 Wi-Fi 手机可访问：http://本机局域网IP:${PORT}/`);
  warmStartupData();
});
