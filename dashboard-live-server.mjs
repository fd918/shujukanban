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
const MARKETING_COSTS_PATH = join(ROOT, "data/business-marketing-costs.json");
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
const DEFAULT_USER_HISTORY_DAYS = 30;

let token = process.env.YZ_DASHBOARD_TOKEN || "";
let tokenExpiresAt = 0;
let middlePlatformCookie = "";
let loginPromise = null;
let performanceSessionPromise = null;
let snapshotTimer = null;
let snapshotScheduleVersion = 0;
let snapshotRecordQueue = Promise.resolve();
let marketingCostMutationQueue = Promise.resolve();
let businessUserStatisticsQueue = Promise.resolve();
let lastSnapshotAt = 0;
let lastSnapshotSlotKey = "";
let lastSnapshotPruneDay = "";
let lastGood = { businesses: [], users: [], summary: null, hourlyTrend: [] };
const userDetailCache = new Map();
const userHistoryRequests = new Map();
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
let dailyHistoryFinalizationPromise = null;
let highFrequencyUserWarmupPromise = null;
let snapshotMemoryCache = null;
let marketingCostWorkspaceCache = { data: null, expiresAt: 0, promise: null };
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
  const cookieLines = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  middlePlatformCookie = cookieLines
    .flatMap(line => String(line).split(/,(?=\s*[^;,=]+=[^;,]+)/))
    .map(line => line.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
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
  if (!loginPromise) {
    loginPromise = (async () => {
      const user = process.env.YZ_DASHBOARD_USER || await readSecret(USER_SERVICE);
      const pass = process.env.YZ_DASHBOARD_PASS || await readSecret(PASS_SERVICE);
      if (!user || !pass) throw new Error("本地服务缺少中台账号密码，请在桌面入口写入钥匙串账号。");
      token = await loginWithCredentials(user, pass);
      tokenExpiresAt = Date.now() + 20 * 60 * 1000;
      return token;
    })().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

function sessionExpired(payload = {}) {
  return /登录超时|登陆超时|重新登录|其他地方登录|其它地方登录/.test(String(payload.message || ""));
}

function clearMiddlePlatformSession(expectedToken = "") {
  if (expectedToken && token && token !== expectedToken) return false;
  token = "";
  middlePlatformCookie = "";
  tokenExpiresAt = 0;
  return true;
}

async function ensurePerformanceSession() {
  if (token && middlePlatformCookie && Date.now() < tokenExpiresAt) return { token, cookie: middlePlatformCookie };
  if (!performanceSessionPromise) {
    performanceSessionPromise = (async () => {
      const user = process.env.YZ_DASHBOARD_USER || await readSecret(USER_SERVICE);
      const pass = process.env.YZ_DASHBOARD_PASS || await readSecret(PASS_SERVICE);
      if (!user || !pass) throw new Error("缺少中台账号密码，无法读取订单明细中的成交金额。");
      token = await loginWithCredentials(user, pass);
      tokenExpiresAt = Date.now() + 20 * 60 * 1000;
      return { token, cookie: middlePlatformCookie };
    })().finally(() => { performanceSessionPromise = null; });
  }
  return performanceSessionPromise;
}

async function apiCall(name, method, path, data, timeoutMs = 12000) {
  const startedAt = Date.now();
  recordApiRequest(name, path);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
      if (attempt === 0 && sessionExpired(payload)) {
        clearMiddlePlatformSession(auth);
        continue;
      }
      const ok = response.ok && payload.code === 200;
      return { name, ok, status: response.status, code: payload.code, message: payload.message || (ok ? "成功" : "接口返回异常"), durationMs: Date.now() - startedAt, data: payload.data };
    }
  } catch (error) {
    return { name, ok: false, message: error.name === "AbortError" ? "接口超时" : error.message, durationMs: Date.now() - startedAt, data: null };
  }
  return { name, ok: false, message: "中台登录状态失效", durationMs: Date.now() - startedAt, data: null };
}

async function performanceOrderCall(name, data, timeoutMs = 60000) {
  const startedAt = Date.now();
  const path = "/performance/order-list/index";
  recordApiRequest(name, path);
  try {
    const body = new URLSearchParams();
    Object.entries(data || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((item, index) => body.append(`${key}[${index}]`, String(item)));
      else if (value !== undefined && value !== null) body.append(key, String(value));
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await ensurePerformanceSession();
      const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${session.token}`,
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "origin": "https://adminpub.yunzhanxinxi.com",
          "referer": "https://adminpub.yunzhanxinxi.com/",
          "cookie": session.cookie
        },
        body
      }, timeoutMs);
      const payload = await response.json();
      if (attempt === 0 && sessionExpired(payload)) {
        clearMiddlePlatformSession(session.token);
        continue;
      }
      const ok = response.ok && payload.code === 200;
      return { name, ok, status: response.status, code: payload.code, message: payload.message || (ok ? "成功" : "接口返回异常"), durationMs: Date.now() - startedAt, data: payload.data };
    }
  } catch (error) {
    return { name, ok: false, message: error.name === "AbortError" ? "接口超时" : error.message, durationMs: Date.now() - startedAt, data: null };
  }
  return { name, ok: false, message: "中台登录状态失效", durationMs: Date.now() - startedAt, data: null };
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
  const entries = retainedUserDetailCacheEntries(userDetailCache.entries());
  userDetailCacheSavedAtText = nowText();
  const temporaryPath = `${USER_DETAIL_CACHE_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({
    savedAt: new Date().toISOString(),
    savedAtText: userDetailCacheSavedAtText,
    items: Object.fromEntries(entries)
  }, null, 2));
  await rename(temporaryPath, USER_DETAIL_CACHE_PATH);
}

function userDetailCacheRetentionId(cacheKey, payload = {}) {
  try {
    const key = JSON.parse(cacheKey);
    const businessId = String(key.businessId || "");
    const userId = String(key.userId || "");
    if (key.type === "history" && businessId) {
      const completeness = payload.partial === true || payload.complete === false ? "partial" : "complete";
      const rangeDays = key.startDate && key.endDate ? daysBetweenInclusive(key.startDate, key.endDate) : 0;
      const rolling = rangeDays > 0 && rangeDays <= DEFAULT_USER_HISTORY_DAYS && String(key.endDate || "") >= shiftDay(dayKey(), -1);
      return rolling ? `history:${businessId}:rolling:${completeness}` : `history:${businessId}:custom:${key.startDate || ""}:${key.endDate || ""}:${completeness}`;
    }
    if (["focus-order-history", "focus-current", "focus-metric-history"].includes(key.type) && businessId && userId) {
      return `${key.type}:${businessId}:${userId}`;
    }
    if (businessId) return `business-detail:${businessId}:${key.includePrevious === false ? "current" : "comparison"}`;
  } catch {}
  return `legacy:${cacheKey}`;
}

function userDetailCacheRetentionRank(cacheKey, payload = {}) {
  let key = {};
  try { key = JSON.parse(cacheKey); } catch {}
  const endDate = String(key.endDate || key.date || "");
  const rangeDays = Array.isArray(payload.dates) ? payload.dates.length : 0;
  const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
  const rows = Array.isArray(payload.rows) ? payload.rows.length : 0;
  const complete = payload.partial === true || payload.complete === false ? 0 : 1;
  const usable = rows > 0 ? 1 : 0;
  return [endDate, complete, usable, savedAt, rangeDays, rows];
}

function retainedUserDetailCacheEntries(sourceEntries) {
  const retained = new Map();
  const ranks = new Map();
  for (const [cacheKey, payload] of sourceEntries) {
    const retentionId = userDetailCacheRetentionId(cacheKey, payload);
    const rank = userDetailCacheRetentionRank(cacheKey, payload);
    const currentRank = ranks.get(retentionId);
    const shouldReplace = !currentRank || rank.some((value, index) => value > currentRank[index] && rank.slice(0, index).every((item, prefix) => item === currentRank[prefix]));
    if (!shouldReplace) continue;
    ranks.set(retentionId, rank);
    retained.set(retentionId, [cacheKey, payload]);
  }
  return [...retained.values()];
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

async function retryApiCall(name, path, params, timeoutMs, attempts = 3) {
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await apiCall(attempt === 1 ? name : `${name}（重试${attempt - 1}）`, "GET", path, params, timeoutMs);
    if (result.ok) return result;
    if (attempt < attempts) await new Promise(resolveWait => setTimeout(resolveWait, attempt * 200));
  }
  return result;
}

async function businessUserStatisticsCall(name, params, timeoutMs) {
  const run = businessUserStatisticsQueue.catch(() => {}).then(async () => {
    const path = "/api/v2/dashboard/business/user-order-statistics";
    const requestParams = {
      ...(params || {}),
      // The official dashboard currently requests this endpoint in fixed 10-row pages.
      // Sending our desired merged size (for example 5000) as pre_page causes code 100100.
      pre_page: Math.min(10, Math.max(1, number(params?.pre_page) || 10))
    };
    const result = await apiCall(name, "GET", path, requestParams, timeoutMs);
    if (result.ok || result.code !== 100100 || !Object.prototype.hasOwnProperty.call(requestParams, "filter_field")) return result;
    const officialParams = { ...requestParams };
    delete officialParams.filter_field;
    const fallback = await apiCall(`${name}（官方参数兼容）`, "GET", path, officialParams, timeoutMs);
    return fallback.ok
      ? { ...fallback, filterFieldFallback: true }
      : { ...fallback, filterFieldFallbackAttempted: true };
  });
  businessUserStatisticsQueue = run.catch(() => {});
  return run;
}

async function retryBusinessUserStatisticsCall(name, params, timeoutMs, attempts = 3) {
  let result = null;
  let retryParams = { ...(params || {}) };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await businessUserStatisticsCall(attempt === 1 ? name : `${name}（重试${attempt - 1}）`, retryParams, timeoutMs);
    if (result.ok) return result;
    if (result.filterFieldFallbackAttempted) delete retryParams.filter_field;
    // This endpoint throttles short bursts after several successful pages. A real
    // backoff lets the next page recover instead of turning the rest of the batch
    // into code 100100 failures.
    if (attempt < attempts) await new Promise(resolveWait => setTimeout(resolveWait, attempt * 1200));
  }
  return result;
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
    const [orders, commission, amount] = await Promise.all([
      apiCall(`业务每日订单-${date}`, "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "order_valid" }, 20000),
      apiCall(`业务每日佣金-${date}`, "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "settle_amount_valid" }, 20000),
      apiCall(`业务每日成交金额-${date}`, "POST", "/api/v2/order-statistic/summary-new", { ...payload, filter_field: "amount_valid" }, 20000)
    ]);
    statuses.push(orders, commission, amount);
    return { date, orders, commission, amount };
  });

  for (const { date, orders, commission, amount } of dailyResults) {
    for (const row of pickArray(orders.data)) {
      const id = String(row.order_type || row.business_id || row.subtitle || "");
      rowsById[id] ||= {
        platform: row.title || row.platform || "未分类",
        name: row.subtitle || row.business_name || "未命名业务",
        businessId: id,
        platformBusinessId: String(row.order_category_id || row.platform_business_id || ""),
        days: {}
      };
      rowsById[id].days[date] ||= { orders: 0, commission: 0, amount: 0 };
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
      rowsById[id].days[date] ||= { orders: 0, commission: 0, amount: 0 };
      rowsById[id].days[date].commission = number(row[date] ?? row.period_total ?? row.total);
    }

    for (const row of pickArray(amount.data)) {
      const id = String(row.order_type || row.business_id || row.subtitle || "");
      rowsById[id] ||= {
        platform: row.title || row.platform || "未分类",
        name: row.subtitle || row.business_name || "未命名业务",
        businessId: id,
        platformBusinessId: String(row.order_category_id || row.platform_business_id || ""),
        days: {}
      };
      rowsById[id].days[date] ||= { orders: 0, commission: 0, amount: 0 };
      rowsById[id].days[date].amount = number(row[date] ?? row.period_total ?? row.total);
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

async function fetchBusinessUserHistory(options = {}, statuses = []) {
  const requestKey = JSON.stringify({
    businessId: String(options.businessId || ""),
    startDate: options.startDate,
    endDate: options.endDate,
    pageSize: number(options.pageSize) || 5000,
    refresh: Boolean(options.refresh),
    enrichPhones: options.enrichPhones !== false
  });
  if (userHistoryRequests.has(requestKey)) {
    statuses.push({ name: "业务用户历史合并请求", ok: true, message: "复用正在进行的相同业务历史请求", durationMs: 0 });
    return userHistoryRequests.get(requestKey);
  }
  const request = fetchBusinessUserHistoryRequest(options, statuses);
  userHistoryRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (userHistoryRequests.get(requestKey) === request) userHistoryRequests.delete(requestKey);
  }
}

async function fetchBusinessUserHistoryRequest({ businessId = "", startDate, endDate, pageSize = 5000, refresh = false, enrichPhones = true }, statuses = []) {
  const cacheKey = JSON.stringify({ type: "history", businessId, startDate, endDate, pageSize, filterField: "order_valid" });
  const historyCandidates = [...userDetailCache.entries()]
    .map(([key, payload]) => {
        try {
          return { key: JSON.parse(key), payload };
        } catch {
          return null;
        }
      })
    .filter(item => item?.key?.type === "history"
      && String(item.key.businessId) === String(businessId)
      && item.key.startDate <= startDate)
    .sort((a, b) => {
      const completeA = a.payload.partial === true || a.payload.complete === false ? 0 : 1;
      const completeB = b.payload.partial === true || b.payload.complete === false ? 0 : 1;
      if (completeA !== completeB) return completeB - completeA;
      const usableA = (a.payload.rows || []).length ? 1 : 0;
      const usableB = (b.payload.rows || []).length ? 1 : 0;
      if (usableA !== usableB) return usableB - usableA;
      const timeA = Date.parse(String(a.payload.savedAtText || "").replace(/\//g, "-")) || 0;
      const timeB = Date.parse(String(b.payload.savedAtText || "").replace(/\//g, "-")) || 0;
      return timeB - timeA || (b.payload.dates?.length || 0) - (a.payload.dates?.length || 0);
    });
  const isCompleteHistory = item => item.payload.partial !== true && item.payload.complete !== false;
  const covering = historyCandidates.find(item => isCompleteHistory(item) && item.key.endDate >= endDate)
    || historyCandidates.find(item => isCompleteHistory(item) && item.key.endDate < endDate && shiftDay(item.key.endDate, 1) >= endDate)
    || historyCandidates.find(item => item.key.endDate >= endDate)
    || historyCandidates.find(item => item.key.endDate < endDate && shiftDay(item.key.endDate, 1) >= endDate)
    || null;
  const cachedSlice = () => {
    if (!covering) return null;
      const dates = dayList(startDate, endDate);
      const rows = (covering.payload.rows || []).map(row => attachPlainPhone({
        ...row,
        days: Object.fromEntries(dates.map(date => [date, number(row.days?.[date])])),
        todayOrders: dates.reduce((sum, date) => sum + number(row.days?.[date]), 0)
      }));
    return {
      ...covering.payload,
      dates,
      rows,
      total: rows.length,
      cached: true,
      staleThroughDate: covering.key.endDate < endDate ? covering.key.endDate : ""
    };
  };
  if (!refresh && covering) {
    const cached = cachedSlice();
    statuses.push({ name: "业务用户历史覆盖缓存", ok: true, message: `从已保存历史切片：${cached.rows.length} 个用户、${cached.dates.length} 天${cached.staleThroughDate ? `（完整历史截至 ${cached.staleThroughDate}，今日由实时分页补齐）` : ""}`, durationMs: 0 });
    return cached;
  }
  const dates = dayList(startDate, endDate);
  const params = { order_type: businessId, page: 1, pre_page: pageSize, start_date: startDate, end_date: endDate, filter_field: "order_valid" };
  const result = await businessUserStatisticsCall("业务用户历史", params, 30000);
  statuses.push(result);
  if (!result.ok) {
    const fallback = cachedSlice();
    if (fallback) {
      statuses.push({ name: "业务用户历史保护", ok: true, message: "中台请求失败，已保留并返回旧缓存", durationMs: 0 });
      return { ...fallback, ok: true, upstreamOk: false, cacheFallback: true };
    }
    return { ok: false, savedAtText: nowText(), total: 0, dates, rows: [] };
  }
  const firstRows = asList(result.data);
  const total = number(result.data?.total);
  const perPage = Math.max(1, number(result.data?.per_page) || firstRows.length || 10);
  const totalPages = Math.max(1, number(result.data?.total_pages) || Math.ceil(total / perPage));
  let allRows = firstRows;
  let pageLoadFailed = false;
  if (totalPages > 1) {
    const restPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    const rest = await mapLimit(restPages, 1, async currentPage => {
      await new Promise(resolveWait => setTimeout(resolveWait, currentPage === 2 ? 5000 : 600));
      return retryBusinessUserStatisticsCall(`业务用户历史第${currentPage}页`, {
        ...params,
        page: currentPage
      }, 30000);
    });
    const failed = rest.filter(item => !item.ok).length;
    pageLoadFailed = failed > 0;
    statuses.push({ name: "业务用户历史翻页", ok: failed === 0, message: failed ? `${failed} 页加载失败` : `已加载 ${totalPages} 页`, durationMs: rest.reduce((sum, item) => sum + number(item.durationMs), 0) });
    allRows = allRows.concat(...rest.filter(item => item.ok).map(item => asList(item.data)));
  }
  if (pageLoadFailed) {
    const fallback = cachedSlice();
    if (fallback) {
      statuses.push({ name: "业务用户历史保护", ok: true, message: "中台分页不完整，已保留并返回旧缓存", durationMs: 0 });
      return { ...fallback, ok: true, upstreamOk: false, cacheFallback: true };
    }
    statuses.push({ name: "业务用户历史部分结果", ok: true, message: "没有完整旧缓存，先返回已成功加载的用户页，后续刷新继续补齐", durationMs: 0 });
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
  const fallback = cachedSlice();
  const fallbackHasOrders = fallback?.rows?.some(row => dates.some(date => number(row.days?.[date]) > 0));
  if (!rows.length && fallbackHasOrders) {
    statuses.push({ name: "业务用户历史保护", ok: true, message: "中台返回空历史，已保留并返回旧缓存", durationMs: 0 });
    return { ...fallback, ok: true, upstreamOk: false, cacheFallback: true };
  }
  const payload = { ok: true, complete: !pageLoadFailed, upstreamOk: !pageLoadFailed, partial: pageLoadFailed, filterFieldFallback: Boolean(result.filterFieldFallback), savedAtText: nowText(), total, dates, rows };
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
      if (payload.partial === true || payload.complete === false) continue;
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
      if (payload.partial === true || payload.complete === false) continue;
      const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
      if (!latest || savedAt > latestAt) {
        latest = payload;
        latestAt = savedAt;
      }
    } catch {}
  }
  return latest;
}

function latestPartialBusinessUsers(businessId, date = dayKey()) {
  let latest = null;
  let latestAt = 0;
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      if (String(key.businessId) !== String(businessId)) continue;
      if (key.startDate !== date || key.endDate !== date || key.includePrevious !== false) continue;
      if (key.filterField !== "order_valid" || number(key.pageSize) < 5000) continue;
      if (payload.partial !== true && payload.complete !== false) continue;
      if (!(payload.rows || []).length) continue;
      const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
      if (!latest || savedAt > latestAt) {
        latest = payload;
        latestAt = savedAt;
      }
    } catch {}
  }
  return latest;
}

function mergeFocusOrderHistoryRows(businessId, baseRows = []) {
  const rowsById = new Map(baseRows.map(row => [String(row.id || ""), { ...row, days: { ...(row.days || {}) } }]));
  let latestDataTime = "";
  let latestAt = 0;
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    let key;
    try { key = JSON.parse(cacheKey); } catch { continue; }
    if (key.type !== "focus-order-history" || String(key.businessId) !== String(businessId)) continue;
    const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
    if (savedAt >= latestAt) {
      latestAt = savedAt;
      latestDataTime = payload.savedAtText || latestDataTime;
    }
    for (const focusRow of payload.rows || []) {
      const id = String(focusRow.id || "");
      if (!id) continue;
      const current = rowsById.get(id) || {};
      rowsById.set(id, attachPlainPhone({
        ...current,
        ...focusRow,
        days: { ...(current.days || {}), ...(focusRow.days || {}) },
        currentDataTime: payload.savedAtText || current.currentDataTime || ""
      }));
    }
  }
  return { rows: [...rowsById.values()], latestDataTime };
}

function latestKnownPositiveOrder(businessId, userId, date = dayKey()) {
  let latest = null;
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    let key;
    try { key = JSON.parse(cacheKey); } catch { continue; }
    if (String(key.businessId || "") !== String(businessId)) continue;
    const row = (payload.rows || []).find(item => String(item.id || item.userId || "") === String(userId));
    if (!row) continue;
    const hasDateValue = Object.prototype.hasOwnProperty.call(row.days || {}, date);
    const isCurrentRange = key.startDate === date && key.endDate === date;
    const value = hasDateValue ? number(row.days[date]) : (isCurrentRange ? number(row.todayOrders) : 0);
    if (value <= 0) continue;
    const savedAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
    if (!latest || savedAt >= latest.savedAt) latest = { value, savedAt };
  }
  return latest?.value || 0;
}

function latestFocusCurrentRows(businessId, date = dayKey()) {
  const rowsById = new Map();
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    let key;
    try { key = JSON.parse(cacheKey); } catch { continue; }
    if (key.type !== "focus-current" || String(key.businessId) !== String(businessId) || key.date !== date) continue;
    for (const row of payload.rows || []) {
      const id = String(row.id || "");
      if (!id) continue;
      const storedOrders = number(row.todayOrders ?? row.days?.[date]);
      const preservedOrders = storedOrders > 0 ? storedOrders : latestKnownPositiveOrder(businessId, id, date);
      const safeRow = preservedOrders > storedOrders
        ? { ...row, todayOrders: preservedOrders, days: { ...(row.days || {}), [date]: preservedOrders }, orderPreserved: true }
        : row;
      const current = rowsById.get(id);
      const incomingAt = Date.parse(String(payload.savedAtText || "").replace(/\//g, "-")) || 0;
      if (!current || incomingAt >= current.savedAt) rowsById.set(id, { row: { ...safeRow, currentDataTime: payload.savedAtText || "", realtimeToday: true }, savedAt: incomingAt });
    }
  }
  return [...rowsById.values()].map(item => item.row);
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
  const baseHistoryRows = deduplicateBusinessUsers(history.rows || []).map(row => ({ ...row, currentDataTime: history.savedAtText || "" }));
  const focusHistory = mergeFocusOrderHistoryRows(businessId, baseHistoryRows);
  const historyRows = focusHistory.rows;
  const timeValue = value => Date.parse(String(value || "").replace(/\//g, "-")) || 0;
  const historyLatestDataTime = timeValue(focusHistory.latestDataTime) > timeValue(history.savedAtText) ? focusHistory.latestDataTime : (history.savedAtText || "-");
  const t1Detail = buildT1BusinessUserDetail({ ...history, savedAtText: historyLatestDataTime, rows: historyRows }, businessId);
  if (t1Detail) {
    return {
      ok: history.ok,
      message: history.ok ? "" : "中台业务用户历史接口未返回有效数据",
      cached: Boolean(history.cached),
      ...t1Detail,
      history: {
        ok: history.ok,
        cached: Boolean(history.cached),
        latestDataTime: historyLatestDataTime,
        dates: history.dates,
        rows: historyRows,
        total: Math.max(number(history.total), historyRows.length)
      }
    };
  }
  const snapshots = await readSnapshots();
  const refreshedCandidate = refresh && endDate === dayKey() ? await fetchBusinessUsers({
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
  const refreshedFull = refreshedCandidate?.ok && refreshedCandidate.complete !== false && refreshedCandidate.partial !== true ? refreshedCandidate : null;
  const full = refreshedFull || (endDate === dayKey() ? latestFullBusinessUsers(businessId, endDate) : null);
  const partial = refreshedCandidate?.ok && (refreshedCandidate.partial === true || refreshedCandidate.complete === false)
    ? refreshedCandidate
    : (endDate === dayKey() ? latestPartialBusinessUsers(businessId, endDate) : null);
  const fast = endDate === dayKey() ? latestFastBusinessUsers(businessId, endDate) : null;
  const fullRows = deduplicateBusinessUsers(full?.rows || []).map(row => ({ ...row, currentDataTime: full?.savedAtText || "" }));
  const fullById = new Map(fullRows.map(row => [String(row.id || ""), row]));
  const partialIsNewer = partial && (!full || timeValue(partial.savedAtText) > timeValue(full.savedAtText));
  const partialRows = deduplicateBusinessUsers(partialIsNewer ? partial.rows || [] : []).map(row => ({ ...row, currentDataTime: partial?.savedAtText || "", realtimeToday: true }));
  const partialById = new Map(partialRows.map(row => [String(row.id || ""), row]));
  const currentBaseTime = Math.max(timeValue(full?.savedAtText), timeValue(partialIsNewer ? partial?.savedAtText : ""));
  const fastIsNewer = timeValue(fast?.savedAtText) > currentBaseTime;
  const fastRows = deduplicateBusinessUsers(fastIsNewer ? fast?.rows || [] : []).map(row => ({ ...row, currentDataTime: fast?.savedAtText || "" }));
  const fastById = new Map(fastRows.map(row => [String(row.id || ""), row]));
  const currentById = new Map(fullById);
  partialById.forEach((row, id) => currentById.set(id, row));
  fastById.forEach((row, id) => currentById.set(id, row));
  latestFocusCurrentRows(businessId, endDate).forEach(row => {
    const id = String(row.id || "");
    const existing = currentById.get(id);
    if (!existing || timeValue(row.currentDataTime) >= timeValue(existing.currentDataTime)) currentById.set(id, row);
  });
  const todayRows = historyRows.map(row => {
    const current = currentById.get(String(row.id || ""));
    return {
      ...row,
      ...(current || {}),
      currentDataTime: current?.currentDataTime || (full ? full.savedAtText : row.currentDataTime),
      days: {
        ...(row.days || {}),
        ...(current || full ? { [endDate]: number(current?.todayOrders) } : {})
      },
      todayOrders: current ? number(current.todayOrders) : (full ? 0 : number(row.days?.[endDate])),
      yesterdayOrders: number(row.days?.[shiftDay(endDate, -1)]),
      // A complete current-day response also proves that omitted historical users have zero orders at this batch time.
      realtimeToday: Boolean(full || current)
    };
  });
  for (const currentRow of currentById.values()) {
    if (historyRows.some(row => String(row.id || "") === String(currentRow.id || ""))) continue;
    todayRows.push({ ...currentRow, days: { [endDate]: number(currentRow.todayOrders) }, realtimeToday: true });
  }
  const fullCurrentLatestDataTime = full?.savedAtText || "";
  const currentLatestDataTime = [...currentById.values()].map(row => row.currentDataTime).filter(Boolean).sort().at(-1)
    || (fastIsNewer ? fast.savedAtText : (partialIsNewer ? partial.savedAtText : (fullCurrentLatestDataTime || historyLatestDataTime)));
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
    realtimeUserCount: currentById.size,
    partialCurrent: Boolean(!full && partial),
    total: Math.max(number(full?.total), number(partial?.total), number(history.total), users.length),
    userOrderSum: users.reduce((sum, row) => sum + number(row.todayOrders), 0),
    users,
    history: {
      ok: history.ok,
      cached: Boolean(history.cached),
      latestDataTime: historyLatestDataTime,
      dates: history.dates,
      rows: historyRows,
      total: Math.max(number(history.total), historyRows.length)
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
  const exactCache = userDetailCache.get(cacheKey);
  const cachedFallback = () => {
    const cached = exactCache || (includePrevious === false && startDate === endDate && pageSize >= 5000
      ? latestFullBusinessUsers(businessId, endDate)
      : null);
    return cached?.rows?.length ? { ...cached, rows: cached.rows.map(attachPlainPhone), cached: true, cacheFallback: true } : null;
  };
  if (!refresh && exactCache) {
    const cached = exactCache;
    statuses.push({ name: "业务用户缓存", ok: true, message: `使用缓存：${cached.rows.length} 个用户`, durationMs: 0 });
    return { ...cached, rows: cached.rows.map(attachPlainPhone), cached: true };
  }
  const params = { order_type: businessId, page, pre_page: pageSize, start_date: startDate, end_date: endDate, filter_field: "order_valid" };
  if (sortField && sortOrder) {
    params.sort_field = sortField;
    params.sort_order = sortOrder;
  }
  const result = await businessUserStatisticsCall("业务用户下钻", params, 25000);
  statuses.push(result);
  if (!result.ok) {
    const fallback = cachedFallback();
    if (fallback) {
      statuses.push({ name: "业务用户刷新保护", ok: true, message: "中台首屏请求失败，已保留并返回上一次完整用户缓存", durationMs: 0 });
      return fallback;
    }
    return { ok: false, savedAtText: nowText(), total: 0, page, pageSize, columns: [], rows: [] };
  }
  const firstRows = asList(result.data);
  const total = number(result.data?.total);
  const perPage = Math.max(1, number(result.data?.per_page) || firstRows.length || 10);
  const totalPages = Math.max(1, number(result.data?.total_pages) || Math.ceil(total / perPage));
  const needPages = Math.min(totalPages, Math.ceil(Math.max(pageSize, firstRows.length) / perPage));
  const resumePartialCache = exactCache?.rows?.length
    && (exactCache.partial === true || exactCache.complete === false)
    && Array.isArray(exactCache.loadedPages);
  let allRows = firstRows;
  let pageLoadFailed = false;
  let loadedPages = resumePartialCache
    ? [...new Set([1, ...exactCache.loadedPages])].filter(currentPage => currentPage >= 1 && currentPage <= needPages).sort((a, b) => a - b)
    : [1];
  if (result.ok && needPages > 1) {
    const loadedPageSet = new Set(loadedPages);
    const restPages = Array.from({ length: needPages - 1 }, (_, index) => index + 2).filter(currentPage => !loadedPageSet.has(currentPage));
    const rest = await mapLimit(restPages, 1, async currentPage => {
      await new Promise(resolveWait => setTimeout(resolveWait, currentPage === 2 ? 5000 : 600));
      return retryBusinessUserStatisticsCall(`业务用户下钻第${currentPage}页`, {
        ...params,
        page: currentPage
      }, 25000);
    });
    const failed = rest.filter(item => !item.ok).length;
    loadedPages = loadedPages.concat(restPages.filter((currentPage, index) => rest[index]?.ok));
    loadedPages = [...new Set(loadedPages)].sort((a, b) => a - b);
    pageLoadFailed = failed > 0 || loadedPages.length < needPages;
    statuses.push({ name: "业务用户下钻翻页", ok: !pageLoadFailed, message: pageLoadFailed ? `${needPages - loadedPages.length} 页尚未补齐` : `已加载 ${needPages} 页`, durationMs: rest.reduce((sum, item) => sum + number(item.durationMs), 0) });
    if (pageLoadFailed) {
      const fallback = cachedFallback();
      const fallbackComplete = fallback && fallback.partial !== true && fallback.complete !== false;
      if (fallbackComplete) {
        statuses.push({ name: "业务用户刷新保护", ok: true, message: "中台分页不完整，已保留并返回上一次完整用户缓存", durationMs: 0 });
        return fallback;
      }
      statuses.push({ name: "业务用户下钻部分结果", ok: true, message: "没有完整旧缓存，已把本轮成功页与此前部分缓存合并，后续刷新继续补齐", durationMs: 0 });
    }
    allRows = allRows.concat(...rest.filter(item => item.ok).map(item => asList(item.data)));
  }
  let previousById = {};
  if (businessId && includePrevious) {
    const periodDays = dayList(startDate, endDate).length;
    const previousEnd = shiftDay(startDate, -1);
    const previousStart = shiftDay(previousEnd, -(periodDays - 1));
    const previousKey = previousStart === previousEnd ? previousEnd : "period_total";
    const previous = await businessUserStatisticsCall("业务用户前一周期基准", {
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
      const previousRest = await mapLimit(previousRestPages, 4, currentPage => businessUserStatisticsCall(`业务用户前一周期基准第${currentPage}页`, {
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
  let rows = deduplicateBusinessUsers(allRows.slice(0, pageSize).map(row => normalizeUser(row, startDate === endDate ? endDate : "period_total")));
  if (!rows.length) {
    const fallback = cachedFallback();
    if (fallback?.rows?.some(row => number(row.todayOrders) > 0)) {
      statuses.push({ name: "业务用户刷新保护", ok: true, message: "中台返回空用户列表，已保留并返回上一次完整用户缓存", durationMs: 0 });
      return fallback;
    }
    statuses.push({ name: "业务用户空结果保护", ok: false, message: "中台返回空用户列表，本次不写入缓存", durationMs: 0 });
    return { ok: false, savedAtText: nowText(), total: 0, page, pageSize, columns: result.data?.columns || [], rows: [] };
  }
  rows.forEach(row => {
    row.yesterdayOrders = previousById[row.id] || 0;
  });
  await mapLimit(rows, 8, async row => {
    const plainPhone = await fetchPlainPhone(row.id);
    row.phone = plainPhoneValue(row.id, plainPhone, row.phone);
  });
  if (resumePartialCache) {
    const mergedById = new Map(deduplicateBusinessUsers(exactCache.rows).map(row => [String(row.id || ""), row]));
    rows.forEach(row => mergedById.set(String(row.id || ""), row));
    rows = [...mergedById.values()];
  }
  const payload = {
    ok: true,
    complete: !pageLoadFailed,
    upstreamOk: !pageLoadFailed,
    partial: pageLoadFailed,
    filterFieldFallback: Boolean(result.filterFieldFallback),
    savedAtText: nowText(),
    total,
    totalPages,
    loadedPages,
    page: number(result.data?.page || page),
    pageSize: perPage,
    columns: result.data?.columns || [],
    rows
  };
  userDetailCache.set(cacheKey, payload);
  scheduleUserDetailCacheSave();
  return payload;
}

async function warmBusinessUserDetails(businesses, dateRange, { refresh = false, pageSize = 5000, includePrevious = true } = {}) {
  const rows = (businesses || []).filter(row => row.platformBusinessId || row.businessId);
  if (!rows.length) return { total: 0, complete: 0, failed: 0 };
  let warmed = 0;
  let complete = 0;
  let failed = 0;
  await mapLimit(rows, 4, async row => {
    const statuses = [];
    try {
      const result = await fetchBusinessUsers({
        businessId: row.platformBusinessId || row.businessId || "",
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        page: 1,
        pageSize,
        sortField: dateRange.startDate === dateRange.endDate ? dateRange.endDate : "period_total",
        sortOrder: "desc",
        refresh,
        includePrevious
      }, statuses);
      if (result?.ok) warmed += 1;
      if (result?.ok && result.complete !== false && result.partial !== true) complete += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[${nowText()}] 预热业务用户失败：${row.name} ${error.message}`);
    }
  });
  console.log(`[${nowText()}] 已预热业务用户明细缓存：${warmed}/${rows.length}；完整 ${complete}；失败或部分 ${failed}`);
  return { total: rows.length, warmed, complete, failed };
}

async function loadUserRefreshState() {
  try {
    userRefreshState = JSON.parse(await readFile(USER_REFRESH_STATE_PATH, "utf8"));
  } catch {
    userRefreshState = { scheduledRuns: {}, top100: {} };
  }
  userRefreshState.scheduledRuns ||= {};
  userRefreshState.top100 ||= {};
  userRefreshState.historyFinalizations ||= {};
}

async function saveUserRefreshState() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(USER_REFRESH_STATE_PATH, JSON.stringify(userRefreshState, null, 2));
}

async function warmTopBusinessUsersRun(businesses, dateRange, config) {
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
    if (!result.ok || result.complete === false || result.partial === true || !(result.rows || []).length) {
      console.error(`[${nowText()}] 高频业务完整用户刷新失败：${row.name}；已保留旧缓存`);
      return;
    }
    const topRows = (result.rows || []).slice(0, 100);
    const previousIds = new Set(userRefreshState.top100[businessId]?.ids || []);
    const entered = topRows.filter(user => !previousIds.has(String(user.id))).map(user => String(user.id));
    const enteredToday = { ...(userRefreshState.top100[businessId]?.entered || {}) };
    entered.forEach(id => { enteredToday[id] = nowText(); });
    userRefreshState.top100[businessId] = {
      ids: topRows.map(user => String(user.id)),
      entered: enteredToday,
      updatedAt: new Date().toISOString(),
      updatedAtText: nowText()
    };
    users += result.rows?.length || 0;
    newTop100 += previousIds.size ? entered.length : 0;
  });
  await saveUserRefreshState();
  console.log(`[${nowText()}] 已刷新高频业务完整用户：${rows.length} 个业务，${users} 个用户；前100新进 ${newTop100} 人。`);
  return { businesses: rows.length, users, newTop100 };
}

async function warmTopBusinessUsers(businesses, dateRange, config) {
  if (highFrequencyUserWarmupPromise) return highFrequencyUserWarmupPromise;
  highFrequencyUserWarmupPromise = warmTopBusinessUsersRun(businesses, dateRange, config);
  try {
    return await highFrequencyUserWarmupPromise;
  } finally {
    highFrequencyUserWarmupPromise = null;
  }
}

async function fetchFocusUserOrderMetrics(item, startDate, endDate) {
  const phone = plainPhoneValue(item.userId, item.phone);
  const performanceBusinessId = String(item.catalogBusinessId || "");
  if (!/^1\d{10}$/.test(phone)) return { ok: false, message: "重点用户缺少完整手机号" };
  if (!performanceBusinessId) return { ok: false, message: "业务缺少订单明细分类 ID" };
  const pageSize = 5000;
  const request = page => performanceOrderCall(`重点用户订单明细第${page}页`, {
    page,
    pageSize,
    userKeyword: "",
    accountKeyword: phone,
    payStartTime: `${startDate} 00:00:00`,
    payEndTime: `${endDate} 23:59:59`,
    settleStartTime: "",
    settleEndTime: "",
    orderStatus: [2, 3],
    orderNo: "",
    allianceAffiliation: "",
    rebateType: "",
    commissionType: "",
    category_id: "",
    platform: performanceBusinessId,
    package: ""
  });
  const first = await request(1);
  if (!first.ok) return { ok: false, message: first.message || "订单明细加载失败" };
  let rows = Array.isArray(first.data?.data) ? first.data.data : [];
  const totalPages = Math.max(1, number(first.data?.pageCount) || Math.ceil(number(first.data?.total) / pageSize));
  if (totalPages > 1) {
    const rest = await mapLimit(Array.from({ length: totalPages - 1 }, (_, index) => index + 2), 3, request);
    const failed = rest.filter(result => !result.ok);
    if (failed.length) return { ok: false, message: `订单明细有 ${failed.length} 页加载失败` };
    rows = rows.concat(...rest.map(result => Array.isArray(result.data?.data) ? result.data.data : []));
  }
  const commissionDays = {};
  const gmvDays = {};
  for (const row of rows) {
    const date = String(row.paid_time || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDate || date > endDate) continue;
    gmvDays[date] = number(gmvDays[date]) + number(row.paid_amount);
    const commission = number(row.settle_amount) || number(row.estimate_amount);
    commissionDays[date] = number(commissionDays[date]) + commission;
  }
  dayList(startDate, endDate).forEach(date => {
    commissionDays[date] = Math.round(number(commissionDays[date]) * 100) / 100;
    gmvDays[date] = Math.round(number(gmvDays[date]) * 100) / 100;
  });
  return { ok: true, rows: rows.length, commissionDays, gmvDays };
}

async function refreshFocusUserOrderHistory(item, range) {
  const dates = dayList(range.startDate, range.endDate);
  const params = {
    order_type: item.businessId,
    page: 1,
    pre_page: 5000,
    start_date: range.startDate,
    end_date: range.endDate,
    keyword: item.userId,
    filter_field: "order_valid"
  };
  const result = await businessUserStatisticsCall("重点用户近30天订单", params, 30000);
  if (!result.ok) return { ok: false, message: result.message || "用户订单历史加载失败" };
  const matched = asList(result.data).filter(row => String(row.uid || row.promotion_id || row.accounts_id || "") === String(item.userId));
  if (!matched.length) {
    const cached = focusUserCacheIndex([item.userId]).get(`${item.businessId}:${item.userId}`);
    const hasKnownOrders = dates.some(date => number(cached?.days?.[date]) > 0);
    if (hasKnownOrders) {
      return { ok: false, preserved: true, message: "接口未返回已知有单重点用户，已保留旧缓存" };
    }
  }
  const merged = deduplicateBusinessUsers(matched.map(source => {
    const row = normalizeUser(source, "period_total");
    row.days = Object.fromEntries(dates.map(date => [date, number(source[date])]));
    row.todayOrders = number(row.days[range.endDate]);
    return row;
  }));
  const row = merged[0] || {
    id: String(item.userId),
    name: item.name || `用户 ${item.userId}`,
    phone: item.phone || "-",
    version: item.version || "-",
    days: Object.fromEntries(dates.map(date => [date, 0])),
    todayOrders: 0
  };
  row.phone = plainPhoneValue(row.id, row.phone, item.phone);
  const savedAtText = nowText();
  const cacheKey = JSON.stringify({ type: "focus-order-history", businessId: String(item.businessId), userId: String(item.userId), startDate: range.startDate, endDate: range.endDate });
  userDetailCache.set(cacheKey, { ok: true, savedAtText, total: 1, dates, rows: [row] });
  if (range.endDate === dayKey()) {
    const currentKey = JSON.stringify({ type: "focus-current", businessId: String(item.businessId), userId: String(item.userId), date: range.endDate });
    userDetailCache.set(currentKey, { ok: true, savedAtText, total: 1, rows: [{ ...row, days: { [range.endDate]: row.todayOrders }, realtimeToday: true }] });
  }
  scheduleUserDetailCacheSave();
  return { ok: true, savedAtText };
}

async function refreshFocusUserToday(item) {
  const today = dayKey();
  const params = {
    order_type: item.businessId,
    page: 1,
    pre_page: 10,
    start_date: today,
    end_date: today,
    keyword: item.userId,
    filter_field: "order_valid"
  };
  const [ordersResult, orderMetrics] = await Promise.all([
    businessUserStatisticsCall("重点用户今日订单", params, 20000),
    fetchFocusUserOrderMetrics(item, today, today)
  ]);
  if (!ordersResult.ok && !orderMetrics.ok) return false;
  const orderMatched = asList(ordersResult.data).find(row => String(row.uid || row.promotion_id || row.accounts_id || "") === String(item.userId));
  const rawOrders = orderMatched?.[today] ?? orderMatched?.period_total ?? orderMatched?.today_order_num ?? orderMatched?.order_valid ?? orderMatched?.total;
  const cachedOrders = latestKnownPositiveOrder(item.businessId, item.userId, today);
  const resolvedOrders = rawOrders === undefined || rawOrders === null || rawOrders === ""
    ? cachedOrders
    : Math.max(number(rawOrders), cachedOrders);
  const row = orderMatched ? normalizeUser(orderMatched, today) : {
    id: String(item.userId),
    name: item.name || `用户 ${item.userId}`,
    phone: item.phone || "-",
    version: item.version || "-",
    todayOrders: 0
  };
  row.todayOrders = resolvedOrders;
  row.days = { [today]: row.todayOrders };
  row.orderPreserved = !orderMatched && cachedOrders > 0;
  if (orderMetrics.ok) {
    row.todayCommission = number(orderMetrics.commissionDays[today]);
    row.todayAmount = number(orderMetrics.gmvDays[today]);
    row.commissionDays = { [today]: row.todayCommission };
    row.gmvDays = { [today]: row.todayAmount };
  }
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
  const start = addDays(today, -(DEFAULT_USER_HISTORY_DAYS - 1));
  return { startDate: dayKey(start), endDate: dayKey(today) };
}

async function refreshFocusUserMetricHistory(item, range = publicHistoryRange()) {
  const result = await fetchFocusUserOrderMetrics(item, range.startDate, range.endDate);
  if (!result.ok) return { ok: false, message: result.message || "订单明细加载失败" };
  const dates = dayList(range.startDate, range.endDate);
  const row = {
    id: String(item.userId),
    name: item.name || `用户 ${item.userId}`,
    phone: plainPhoneValue(item.userId, item.phone),
    version: item.version || "-",
    commissionDays: result.commissionDays,
    gmvDays: result.gmvDays,
    todayCommission: number(result.commissionDays[range.endDate]),
    todayAmount: number(result.gmvDays[range.endDate])
  };
  const cacheKey = JSON.stringify({ type: "focus-metric-history", businessId: String(item.businessId), userId: String(item.userId), startDate: range.startDate, endDate: range.endDate });
  userDetailCache.set(cacheKey, { ok: true, savedAtText: nowText(), total: 1, dates, rows: [row] });
  scheduleUserDetailCacheSave();
  return { ok: true };
}

async function refreshFocusUsersMetricHistories(days = 30, includeMetrics = true) {
  const safeDays = Math.max(1, Math.min(65, number(days) || 30));
  const range = { startDate: shiftDay(dayKey(), -(safeDays - 1)), endDate: dayKey() };
  const saved = await readFocusUsers();
  const catalog = await focusBusinessCatalog();
  const cacheIndex = focusUserCacheIndex(saved.items.map(item => item.userId));
  const targets = [];
  const seen = new Set();
  for (const item of saved.items) {
    const hinted = new Set((item.businessHints || []).flatMap(hint => [String(hint.businessId || ""), String(hint.catalogBusinessId || "")]).filter(Boolean));
    for (const business of catalog) {
      const cached = cacheIndex.get(`${business.businessId}:${item.userId}`);
      const hasRecentOrders = Boolean(cached) && (number(cached.todayOrders) > 0 || Object.entries(cached.days || {}).some(([date, value]) => date >= shiftDay(dayKey(), -65) && number(value) > 0));
      const hasRelationship = hasRecentOrders || hinted.has(business.businessId) || hinted.has(business.catalogBusinessId);
      const key = `${business.businessId}:${item.userId}`;
      if (!hasRelationship || seen.has(key)) continue;
      seen.add(key);
      targets.push({ ...item, ...business });
    }
  }
  let orderRefreshed = 0;
  let metricRefreshed = 0;
  const failureCounts = new Map();
  let abortedMessage = "";
  await mapLimit(targets, 4, async item => {
    if (abortedMessage) return;
    const orderResult = await refreshFocusUserOrderHistory(item, range);
    if (orderResult.ok) orderRefreshed += 1;
    else {
      failureCounts.set(orderResult.message, number(failureCounts.get(orderResult.message)) + 1);
      if (/登录超时|登陆超时|重新登录|其他地方登录|其它地方登录|登录状态失效|中台登录失败|接口超时/.test(String(orderResult.message || ""))) abortedMessage = orderResult.message;
    }
  });
  if (includeMetrics && !abortedMessage) {
    await mapLimit(targets, 4, async item => {
      const metricResult = await refreshFocusUserMetricHistory(item, range);
      if (metricResult.ok) metricRefreshed += 1;
      else failureCounts.set(metricResult.message, number(failureCounts.get(metricResult.message)) + 1);
    });
  }
  await writeUserDetailCacheToDisk();
  console.log(`[${nowText()}] 已刷新重点用户近 ${safeDays} 天订单：${orderRefreshed}/${targets.length} 条业务关系${includeMetrics ? `；佣金与成交金额 ${metricRefreshed}/${targets.length}` : ""}。`);
  return {
    ok: orderRefreshed > 0 || metricRefreshed > 0 || targets.length === 0,
    refreshed: orderRefreshed,
    orderRefreshed,
    metricRefreshed,
    total: targets.length,
    days: safeDays,
    message: abortedMessage ? `中台数据刷新已停止：${abortedMessage}` : "",
    aborted: Boolean(abortedMessage),
    failures: Object.fromEntries(failureCounts)
  };
}

async function warmBusinessUserHistories(businesses, { refresh = false, range = publicHistoryRange(), businessIds = null } = {}) {
  if (publicHistoryWarmupRunning) return;
  publicHistoryWarmupRunning = true;
  const selected = businessIds ? new Set([...businessIds].map(String)) : null;
  const rows = (businesses || []).filter(row => {
    const businessId = String(row.platformBusinessId || row.businessId || "");
    return businessId && (!selected || selected.has(businessId));
  });
  try {
    if (!rows.length) return { total: 0, complete: 0, failed: [] };
    let warmed = 0;
    const failed = [];
    await mapLimit(rows, 1, async row => {
      const statuses = [];
      const businessId = String(row.platformBusinessId || row.businessId || "");
      try {
        const history = await fetchBusinessUserHistory({
          businessId,
          startDate: range.startDate,
          endDate: range.endDate,
          pageSize: 5000,
          enrichPhones: false,
          refresh
        }, statuses);
        const complete = history?.ok
          && history.complete !== false
          && history.partial !== true
          && history.upstreamOk !== false
          && (history.dates || []).includes(range.endDate);
        if (complete) warmed += 1;
        else {
          const status = [...statuses].reverse().find(item => !item.ok);
          failed.push({ businessId, name: row.name || businessId, message: status?.message || history?.message || "历史分页未完整" });
          console.error(`[${nowText()}] 预热业务用户历史未取得有效数据：${row.name}${status ? `；${status.name}：${status.message}` : ""}`);
        }
      } catch (error) {
        failed.push({ businessId, name: row.name || businessId, message: error.message });
        console.error(`[${nowText()}] 预热业务用户历史失败：${row.name} ${error.message}`);
      }
    });
    if (warmed) await writeUserDetailCacheToDisk();
    console.log(`[${nowText()}] 已更新业务用户历史：${warmed}/${rows.length}${failed.length ? `；失败 ${failed.length}` : ""}`);
    return { total: rows.length, complete: warmed, failed };
  } finally {
    publicHistoryWarmupRunning = false;
  }
}

async function warmStartupData() {
  if (startupWarmupRunning) return;
  startupWarmupRunning = true;
  try {
    console.log(`[${nowText()}] 开始启动缓存恢复：只读取磁盘，不请求中台`);
    const loadedDetailCache = await loadUserDetailCacheFromDisk();
    if (loadedDetailCache) console.log(`[${nowText()}] 已加载本地用户明细缓存：${userDetailCache.size} 条`);
    await loadUserRefreshState();
    await loadRequestStats();
    await loadUserPhoneIndexFromDisk();
    console.log(`[${nowText()}] 启动缓存恢复完成；中台刷新等待下一个自然时间槽`);
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
  if (!snapshotMemoryCache) {
    const text = await readFile(SNAPSHOT_PATH, "utf8");
    snapshotMemoryCache = [];
    for (const line of text.trim().split("\n").filter(Boolean)) {
      try {
        snapshotMemoryCache.push(JSON.parse(line));
      } catch {
        // A partial final write must not make the whole dashboard unavailable.
      }
    }
  }
  return snapshotMemoryCache.slice(-Math.max(1, number(limit) || 5000));
}

function compactSnapshot(snapshot) {
  const compactValues = values => Object.fromEntries(Object.entries(values || {}).map(([id, value]) => [id, {
    orders: number(value?.orders),
    commission: number(value?.commission),
    amount: number(value?.amount)
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
      commission: number(value?.commission),
      amount: number(value?.amount)
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
  snapshotMemoryCache = null;
  lastSnapshotPruneDay = today;
  console.log(`[${nowText()}] 快照清理完成：保留 ${cutoff} 至 ${today}，共 ${kept} 条`);
}

function comparisonMinuteFromText(value) {
  const match = String(value || "").match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function snapshotCacheMatches(savedAtText, targetDate, targetMinute, actualMinute = targetMinute) {
  const match = String(savedAtText || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!match) return false;
  const savedDate = `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  if (savedDate !== targetDate) return false;
  const savedMinute = Number(match[4]) * 60 + Number(match[5]);
  const startMinute = Number(targetMinute);
  const endMinute = Math.max(startMinute, Number(actualMinute));
  return savedMinute >= startMinute && savedMinute <= endMinute;
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
          commission: Math.round(sevenValues.reduce((sum, item) => sum + number(item.commission), 0) / sevenValues.length * 100) / 100,
          amount: Math.round(sevenValues.reduce((sum, item) => sum + number(item.amount), 0) / sevenValues.length * 100) / 100
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
          commission: Math.round(sevenValues.reduce((sum, item) => sum + number(item.commission), 0) / sevenValues.length * 100) / 100,
          amount: Math.round(sevenValues.reduce((sum, item) => sum + number(item.amount), 0) / sevenValues.length * 100) / 100
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

function cachedBusinessUsersSnapshot(dateRange, targetMinute = minuteOfDay(), actualMinute = targetMinute) {
  const targetDate = dateRange.endDate;
  const candidates = new Map();
  const focusCurrent = new Map();
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      const businessId = String(key.businessId);
      if (!businessId || !Array.isArray(payload.rows)) continue;
      if (payload.partial === true || payload.complete === false) continue;
      if (key.type === "focus-current") {
        if (key.date === targetDate && snapshotCacheMatches(payload.savedAtText, targetDate, targetMinute, actualMinute)) {
          const rows = focusCurrent.get(businessId) || [];
          rows.push(...payload.rows);
          focusCurrent.set(businessId, rows);
        }
        continue;
      }
      if (key.type && key.type !== "history") continue;
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
      const fullMatchesSlot = snapshotCacheMatches(full.savedAtText, targetDate, targetMinute, actualMinute);
      const fastMatchesSlot = snapshotCacheMatches(fast?.savedAtText, targetDate, targetMinute, actualMinute);
      const currentById = new Map((fullMatchesSlot ? deduplicateBusinessUsers(full.rows || []) : []).map(row => [String(row.id || ""), row]));
      if (fastMatchesSlot) {
        for (const row of deduplicateBusinessUsers(fast.rows || [])) currentById.set(String(row.id || ""), row);
      }
      if (currentById.size) details[businessId] = Object.fromEntries([...currentById.entries()].map(([userId, row]) => [userId, {
        name: row.name,
        phone: plainPhoneValue(userId, row.phone),
        version: row.version,
        orders: number(row.todayOrders),
        commission: number(row.todayCommission),
        amount: number(row.todayAmount)
      }]));
      continue;
    }
    const historyRows = (snapshotCacheMatches(group.history?.payload.savedAtText, targetDate, targetMinute, actualMinute) ? group.history?.payload.rows || [] : []).map(row => ({
      ...row,
      todayOrders: number(row.days?.[targetDate]),
      todayCommission: 0
    }));
    const byUser = {};
    for (const row of deduplicateBusinessUsers(historyRows)) {
      const userId = String(row.id || "");
      if (!userId) continue;
      byUser[userId] = { name: row.name, phone: plainPhoneValue(userId, row.phone), version: row.version, orders: number(row.todayOrders), commission: number(row.todayCommission), amount: number(row.todayAmount) };
    }
    if (snapshotCacheMatches(group.exact?.payload.savedAtText, targetDate, targetMinute, actualMinute)) {
      for (const row of deduplicateBusinessUsers(group.exact?.payload.rows || [])) {
        const userId = String(row.id || "");
        if (!userId) continue;
        byUser[userId] = { name: row.name, phone: plainPhoneValue(userId, row.phone), version: row.version, orders: number(row.todayOrders), commission: number(row.todayCommission), amount: number(row.todayAmount) };
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
        commission: number(row.todayCommission),
        amount: number(row.todayAmount)
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
    business: Object.fromEntries(businesses.map(row => [String(row.businessId), { name: row.name, platform: row.platform, orders: row.todayOrders, commission: row.todayCommission, amount: row.todayAmount }])),
    users: Object.fromEntries(users.map(row => [String(row.id), { name: row.name, phone: row.phone, orders: row.todayOrders, commission: row.todayCommission, amount: row.todayAmount }])),
    businessUsers: cachedBusinessUsersSnapshot(dateRange, slot.minuteOfDay, minuteOfDay())
  };
  await checkSnapshotHealth(snapshot, previousSnapshot, config);
  await appendFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot)}\n`);
  if (snapshotMemoryCache) snapshotMemoryCache.push(snapshot);
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
  console.log(`[${nowText()}] 开始固定时段今日全量用户对账：${time}`);
  const todayRange = { startDate: dayKey(), endDate: dayKey() };
  const result = await warmBusinessUserDetails(businesses, todayRange, { refresh: true, pageSize: 5000, includePrevious: false });
  await refreshFocusUsersMetricHistories(1);
  userRefreshState.scheduledRuns = Object.fromEntries(Object.entries(userRefreshState.scheduledRuns).filter(([item]) => item.startsWith(dayKey())));
  userRefreshState.scheduledRuns[key] = { updatedAtText: nowText(), ...result };
  await saveUserRefreshState();
  console.log(`[${nowText()}] 固定时段今日全量用户对账完成：${time}；完整 ${result.complete}/${result.total}`);
  return true;
}

async function runDailyHistoryFinalization(businesses) {
  if (minuteOfDay() < 30) return false;
  if (dailyHistoryFinalizationPromise) return dailyHistoryFinalizationPromise;
  const targetDate = shiftDay(dayKey(), -1);
  const catalog = (businesses || []).filter(row => row.platformBusinessId || row.businessId);
  const businessIds = [...new Set(catalog.map(row => String(row.platformBusinessId || row.businessId || "")).filter(Boolean))];
  if (!businessIds.length) return false;
  userRefreshState.historyFinalizations ||= {};
  const current = userRefreshState.historyFinalizations[targetDate] || { completedIds: [], failures: {}, startedAtText: nowText(), completedAtText: "" };
  const completed = new Set((current.completedIds || []).map(String));
  const now = Date.now();
  const pendingIds = businessIds.filter(id => {
    if (completed.has(id)) return false;
    const failed = current.failures?.[id];
    return !failed?.nextRetryAt || Number(failed.nextRetryAt) <= now;
  });
  if (!pendingIds.length) {
    if (completed.size >= businessIds.length && !current.completedAtText) {
      current.completedAtText = nowText();
      userRefreshState.historyFinalizations[targetDate] = current;
      await saveUserRefreshState();
    }
    return false;
  }
  dailyHistoryFinalizationPromise = (async () => {
    console.log(`[${nowText()}] 开始结算 ${targetDate} 全业务用户订单：待处理 ${pendingIds.length}/${businessIds.length}`);
    const result = await warmBusinessUserHistories(catalog, {
      refresh: true,
      range: { startDate: shiftDay(targetDate, -(DEFAULT_USER_HISTORY_DAYS - 1)), endDate: targetDate },
      businessIds: pendingIds
    });
    if (!result) return false;
    const failedById = new Map((result.failed || []).map(item => [String(item.businessId), item]));
    pendingIds.forEach(id => {
      const failure = failedById.get(id);
      if (!failure) {
        completed.add(id);
        delete current.failures[id];
        return;
      }
      const previous = current.failures[id] || {};
      const attempts = Number(previous.attempts || 0) + 1;
      const delayMinutes = [5, 15, 30][Math.min(attempts - 1, 2)];
      current.failures[id] = {
        attempts,
        message: failure.message || "历史结算失败",
        updatedAtText: nowText(),
        nextRetryAt: Date.now() + delayMinutes * 60 * 1000
      };
    });
    current.completedIds = [...completed];
    if (completed.size >= businessIds.length) current.completedAtText = nowText();
    userRefreshState.historyFinalizations = Object.fromEntries(Object.entries(userRefreshState.historyFinalizations).filter(([date]) => date >= shiftDay(targetDate, -7)));
    userRefreshState.historyFinalizations[targetDate] = current;
    await saveUserRefreshState();
    console.log(`[${nowText()}] ${targetDate} 历史结算进度：${completed.size}/${businessIds.length}；待重试 ${Object.keys(current.failures).length}`);
    return current.completedAtText ? true : false;
  })().finally(() => { dailyHistoryFinalizationPromise = null; });
  return dailyHistoryFinalizationPromise;
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
      runDailyHistoryFinalization(data.businesses).catch(error => console.error(`[${nowText()}] 昨日用户历史结算失败：${error.message}`));
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
      operatorGroup: "",
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
    const operatorGroup = String(source.operatorGroup || source.operator_group || "").trim().slice(0, 40);
    if (operatorGroup) current.operatorGroup = operatorGroup;
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

const DEFAULT_FOCUS_GROUP_NAME = "默认分组";

function focusGroupId(name = DEFAULT_FOCUS_GROUP_NAME) {
  const normalized = String(name || DEFAULT_FOCUS_GROUP_NAME).trim().toLowerCase();
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `group-${digest}`;
}

function normalizeFocusGroups(groups = [], items = []) {
  const validUserIds = new Set(items.map(item => String(item.userId)));
  const normalized = [];
  const usedIds = new Set();
  const usedNames = new Set();
  for (const source of Array.isArray(groups) ? groups : []) {
    const name = String(source?.name || "").trim().slice(0, 40);
    if (!name || usedNames.has(name)) continue;
    let id = String(source?.id || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || focusGroupId(name);
    while (usedIds.has(id)) id = `${id}-${normalized.length + 1}`;
    const userIds = [...new Set((Array.isArray(source?.userIds) ? source.userIds : []).map(String).filter(userId => validUserIds.has(userId)))];
    normalized.push({ id, name, userIds, createdAt: String(source?.createdAt || ""), createdAtText: String(source?.createdAtText || "") });
    usedIds.add(id);
    usedNames.add(name);
  }
  if (!normalized.length && items.length) {
    const legacyGroups = new Map();
    items.forEach(item => {
      const name = String(item.operatorGroup || "").trim() || DEFAULT_FOCUS_GROUP_NAME;
      const userIds = legacyGroups.get(name) || [];
      userIds.push(String(item.userId));
      legacyGroups.set(name, userIds);
    });
    legacyGroups.forEach((userIds, name) => normalized.push({ id: focusGroupId(name), name, userIds: [...new Set(userIds)], createdAt: "", createdAtText: "" }));
  }
  return normalized;
}

function focusGroupMembership(groups = [], userId = "") {
  const id = String(userId);
  return groups.filter(group => group.userIds.includes(id)).map(group => group.id);
}

async function readFocusUsers() {
  try {
    const saved = JSON.parse(await readFile(FOCUS_USERS_PATH, "utf8"));
    const sourceItems = Array.isArray(saved.items) ? saved.items : [];
    const items = mergeFocusUserRecords(sourceItems);
    const operatorGroups = normalizeFocusGroups(saved.operatorGroups, items);
    if (saved.schemaVersion !== 3 || items.length !== sourceItems.length || JSON.stringify(operatorGroups) !== JSON.stringify(saved.operatorGroups || [])) {
      if (!existsSync(FOCUS_USERS_BACKUP_PATH)) await copyFile(FOCUS_USERS_PATH, FOCUS_USERS_BACKUP_PATH);
      const payload = { schemaVersion: 3, items, operatorGroups, updatedAt: saved.updatedAt || new Date().toISOString(), updatedAtText: saved.updatedAtText || nowText() };
      await writeFile(FOCUS_USERS_PATH, JSON.stringify(payload, null, 2));
      console.log(`[${nowText()}] 重点用户已迁移为独立运营标签：${items.length} 位用户，${operatorGroups.length} 个标签。`);
      return payload;
    }
    return { schemaVersion: 3, items, operatorGroups, updatedAt: saved.updatedAt || "", updatedAtText: saved.updatedAtText || "" };
  } catch {
    return { schemaVersion: 3, items: [], operatorGroups: [], updatedAt: "", updatedAtText: "" };
  }
}

async function writeFocusUsers(items, operatorGroups = null) {
  const mergedItems = mergeFocusUserRecords(items);
  let sourceGroups = operatorGroups;
  if (!sourceGroups) {
    try {
      sourceGroups = JSON.parse(await readFile(FOCUS_USERS_PATH, "utf8")).operatorGroups;
    } catch {
      sourceGroups = [];
    }
  }
  const payload = { schemaVersion: 3, items: mergedItems, operatorGroups: normalizeFocusGroups(sourceGroups, mergedItems), updatedAt: new Date().toISOString(), updatedAtText: nowText() };
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(FOCUS_USERS_PATH, JSON.stringify(payload, null, 2));
  invalidateMarketingCostWorkspace();
  return payload;
}

function normalizeMarketingCostItem(item = {}) {
  const startDate = parseDay(item.startDate || item.start_date || dayKey());
  const endDate = parseDay(item.endDate || item.end_date || startDate);
  const status = item.status === "confirmed" ? "confirmed" : "draft";
  return {
    id: String(item.id || randomBytes(8).toString("hex")),
    userId: String(item.userId || "").trim(),
    userName: String(item.userName || "").trim().slice(0, 60),
    businessId: String(item.businessId || "").trim(),
    businessName: String(item.businessName || "").trim().slice(0, 100),
    platform: String(item.platform || "").trim().slice(0, 30),
    startDate: startDate <= endDate ? startDate : endDate,
    endDate: startDate <= endDate ? endDate : startDate,
    unitPrice: Math.max(0, Number(item.unitPrice || 0)),
    note: String(item.note || "").trim().slice(0, 200),
    batchId: String(item.batchId || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100),
    status,
    lockedOrders: status === "confirmed" && Number.isFinite(Number(item.lockedOrders)) ? Number(item.lockedOrders) : null,
    lockedAmount: status === "confirmed" && Number.isFinite(Number(item.lockedAmount)) ? Number(item.lockedAmount) : null,
    confirmedAt: status === "confirmed" ? String(item.confirmedAt || "") : "",
    confirmedAtText: status === "confirmed" ? String(item.confirmedAtText || "") : "",
    createdAt: String(item.createdAt || new Date().toISOString()),
    createdAtText: String(item.createdAtText || nowText()),
    updatedAt: String(item.updatedAt || new Date().toISOString()),
    updatedAtText: String(item.updatedAtText || nowText())
  };
}

async function readMarketingCosts() {
  try {
    const saved = JSON.parse(await readFile(MARKETING_COSTS_PATH, "utf8"));
    return {
      schemaVersion: 1,
      items: (Array.isArray(saved.items) ? saved.items : []).map(normalizeMarketingCostItem).filter(item => item.userId && item.businessId),
      updatedAt: saved.updatedAt || "",
      updatedAtText: saved.updatedAtText || ""
    };
  } catch {
    return { schemaVersion: 1, items: [], updatedAt: "", updatedAtText: "" };
  }
}

async function writeMarketingCosts(items) {
  const payload = {
    schemaVersion: 1,
    items: items.map(normalizeMarketingCostItem).filter(item => item.userId && item.businessId),
    updatedAt: new Date().toISOString(),
    updatedAtText: nowText()
  };
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(MARKETING_COSTS_PATH, JSON.stringify(payload, null, 2));
  invalidateMarketingCostWorkspace();
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
      merged.commissionDays = incomingIsNewer
        ? { ...(current.commissionDays || {}), ...(row.commissionDays || {}) }
        : { ...(row.commissionDays || {}), ...(current.commissionDays || {}) };
      merged.gmvDays = incomingIsNewer
        ? { ...(current.gmvDays || {}), ...(row.gmvDays || {}) }
        : { ...(row.gmvDays || {}), ...(current.gmvDays || {}) };
      merged.cacheSavedAtText = incomingIsNewer ? (payload.savedAtText || current.cacheSavedAtText || "") : current.cacheSavedAtText;
      index.set(key, attachPlainPhone(merged));
    }
  }
  const orderHistoryByDate = new Map();
  const currentByRelation = new Map();
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    let cache;
    try { cache = JSON.parse(cacheKey); } catch { continue; }
    const businessId = String(cache.businessId || "");
    if (!businessId || !["focus-order-history", "focus-current"].includes(cache.type)) continue;
    const savedAt = Date.parse(String(payload.savedAtText || "").replaceAll("/", "-")) || 0;
    for (const row of payload.rows || []) {
      const userId = String(row.id || row.userId || "");
      if (!wanted.has(userId)) continue;
      const relationKey = `${businessId}:${userId}`;
      if (cache.type === "focus-current") {
        const current = currentByRelation.get(relationKey);
        if (!current || savedAt >= current.savedAt) currentByRelation.set(relationKey, { row, savedAt, savedAtText: payload.savedAtText || "" });
        continue;
      }
      const dates = orderHistoryByDate.get(relationKey) || new Map();
      Object.entries(row.days || {}).forEach(([date, value]) => {
        const current = dates.get(date);
        if (!current || savedAt >= current.savedAt) dates.set(date, { value: number(value), savedAt });
      });
      orderHistoryByDate.set(relationKey, dates);
    }
  }
  orderHistoryByDate.forEach((dates, relationKey) => {
    const current = index.get(relationKey) || {};
    current.days = { ...(current.days || {}), ...Object.fromEntries([...dates].map(([date, state]) => [date, state.value])) };
    index.set(relationKey, attachPlainPhone(current));
  });
  currentByRelation.forEach(({ row, savedAtText }, relationKey) => {
    const current = index.get(relationKey) || {};
    const today = dayKey();
    const [businessId, userId] = relationKey.split(":");
    const storedOrders = number(row.todayOrders ?? row.days?.[today]);
    const resolvedOrders = storedOrders > 0 ? storedOrders : latestKnownPositiveOrder(businessId, userId, today);
    index.set(relationKey, attachPlainPhone({
      ...current,
      ...row,
      todayOrders: resolvedOrders,
      days: { ...(current.days || {}), [today]: resolvedOrders },
      orderPreserved: resolvedOrders > storedOrders,
      cacheSavedAtText: savedAtText || current.cacheSavedAtText || ""
    }));
  });
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
  if (!row) return null;
  const today = dayKey();
  const storedOrders = number(row.todayOrders ?? row.days?.[today]);
  const resolvedOrders = storedOrders > 0 ? storedOrders : latestKnownPositiveOrder(businessId, userId, today);
  return {
    ...attachPlainPhone(row),
    todayOrders: resolvedOrders,
    days: { ...(row.days || {}), [today]: resolvedOrders },
    orderPreserved: resolvedOrders > storedOrders,
    savedAtText: payload.savedAtText || "-"
  };
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

async function focusRelatedBusinessCatalog() {
  const catalog = await focusBusinessCatalog();
  const saved = await readFocusUsers();
  const relatedIds = new Set();
  for (const item of saved.items || []) {
    for (const hint of item.businessHints || []) {
      if (hint.businessId) relatedIds.add(String(hint.businessId));
      if (hint.catalogBusinessId) relatedIds.add(String(hint.catalogBusinessId));
    }
  }
  return catalog.filter(business => relatedIds.has(String(business.businessId)) || relatedIds.has(String(business.catalogBusinessId)));
}

function focusBusinessRow(item, business, dates, previousDates, snapshots, cacheIndex) {
    const cached = cacheIndex.get(`${business.businessId}:${item.userId}`) || {};
    const current = cachedFocusCurrentUser(business.businessId, item.userId);
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
    const snapshotUser = yesterdayMatch?.snapshot?.businessUsers?.[businessId]?.[userId] || {};
    const buildMetric = ({ daysField, currentField, snapshotField }) => {
      const sourceDays = cached[daysField] || {};
      const metricDays = Object.fromEntries(dates.map(date => [date, number(sourceDays?.[date])]));
      if (dates.includes(dayKey())) {
        const hasDailyToday = Object.prototype.hasOwnProperty.call(sourceDays, dayKey());
        metricDays[dayKey()] = current ? number(current[currentField]) : (hasDailyToday ? number(sourceDays[dayKey()]) : 0);
      }
      const periodTotal = Object.values(metricDays).reduce((sum, value) => sum + number(value), 0);
      const previousPeriodTotal = previousDates.reduce((sum, date) => sum + number(sourceDays?.[date]), 0);
      const periodDiff = periodTotal - previousPeriodTotal;
      const todayValue = current ? number(current[currentField]) : number(metricDays[dayKey()]);
      const rawYesterday = snapshotField && Object.prototype.hasOwnProperty.call(snapshotUser, snapshotField) ? snapshotUser[snapshotField] : undefined;
      const yesterdaySameTime = rawYesterday === undefined ? null : number(rawYesterday);
      const diff = yesterdaySameTime === null ? null : todayValue - yesterdaySameTime;
      return {
        days: metricDays,
        today: todayValue,
        yesterdaySameTime,
        ratio: yesterdaySameTime === null ? null : (yesterdaySameTime ? diff / yesterdaySameTime * 100 : (todayValue ? 100 : 0)),
        impact: diff === null ? null : Math.abs(diff),
        periodTotal,
        previousPeriodTotal,
        periodRatio: previousPeriodTotal ? periodDiff / previousPeriodTotal * 100 : null,
        periodImpact: Math.abs(periodDiff)
      };
    };
    const metrics = {
      orders: buildMetric({ daysField: "days", currentField: "todayOrders", snapshotField: "orders" }),
      commission: buildMetric({ daysField: "commissionDays", currentField: "todayCommission", snapshotField: null }),
      gmv: buildMetric({ daysField: "gmvDays", currentField: "todayAmount", snapshotField: null })
    };
    const orders = metrics.orders;
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
      metrics,
      days: orders.days,
      periodTotal: orders.periodTotal,
      previousPeriodTotal: orders.previousPeriodTotal,
      periodRatio: orders.periodRatio,
      periodImpact: orders.periodImpact,
      todayOrders: orders.today,
      yesterdaySameTime: orders.yesterdaySameTime,
      sameTime: {
        yesterday: yesterdayMatch ? { orders: metrics.orders.yesterdaySameTime, commission: metrics.commission.yesterdaySameTime, amount: metrics.gmv.yesterdaySameTime } : null,
        ...yesterdayReference,
        yesterdayReference
      },
      ...yesterdayReference,
      ratio: orders.ratio,
      impact: orders.impact,
      newTop100At: topState.entered?.[String(item.userId)] || "",
      realtimeToday: Boolean(current),
      userDataTime: userDataTime || userDetailCacheSavedAtText || "-"
    };
    const hinted = (item.businessHints || []).some(hint => String(hint.businessId || hint.catalogBusinessId) === businessId);
    const hasMetricData = Object.values(metrics).some(metric => metric.today > 0 || metric.previousPeriodTotal > 0 || metric.periodTotal > 0 || number(metric.yesterdaySameTime) > 0);
    return hasMetricData || hinted ? row : null;
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
    const aggregateMetric = metricName => {
      const metricRows = rows.map(row => row.metrics?.[metricName]).filter(Boolean);
      const daysByMetric = Object.fromEntries(dates.map(date => [date, metricRows.reduce((sum, metric) => sum + number(metric.days?.[date]), 0)]));
      const periodTotal = metricRows.reduce((sum, metric) => sum + number(metric.periodTotal), 0);
      const previousPeriodTotal = metricRows.reduce((sum, metric) => sum + number(metric.previousPeriodTotal), 0);
      const today = metricRows.reduce((sum, metric) => sum + number(metric.today), 0);
      const comparable = metricRows.filter(metric => metric.yesterdaySameTime !== null && metric.yesterdaySameTime !== undefined);
      const yesterdaySameTime = comparable.length ? comparable.reduce((sum, metric) => sum + number(metric.yesterdaySameTime), 0) : null;
      const diff = yesterdaySameTime === null ? null : today - yesterdaySameTime;
      return {
        days: daysByMetric,
        today,
        yesterdaySameTime,
        ratio: yesterdaySameTime === null ? null : (yesterdaySameTime ? diff / yesterdaySameTime * 100 : (today ? 100 : 0)),
        impact: diff === null ? null : Math.abs(diff),
        periodTotal,
        previousPeriodTotal,
        periodRatio: previousPeriodTotal ? (periodTotal - previousPeriodTotal) / previousPeriodTotal * 100 : null,
        periodImpact: Math.abs(periodTotal - previousPeriodTotal)
      };
    };
    const metrics = { orders: aggregateMetric("orders"), commission: aggregateMetric("commission"), gmv: aggregateMetric("gmv") };
    const orders = metrics.orders;
    return {
      ...item,
      name: profile.name || userProfileCache.get(String(item.userId))?.name || item.name || `用户 ${item.userId}`,
      phone: plainPhoneValue(item.userId, profile.phone, item.phone, userProfileCache.get(String(item.userId))?.phone),
      version: profile.version || item.version || "-",
      pendingProfile: !(profile.name || item.name || userProfileCache.get(String(item.userId))?.name),
      businessCount: rows.length,
      metrics,
      days: orders.days,
      periodTotal: orders.periodTotal,
      previousPeriodTotal: orders.previousPeriodTotal,
      periodRatio: orders.periodRatio,
      periodImpact: orders.periodImpact,
      todayOrders: orders.today,
      yesterdaySameTime: orders.yesterdaySameTime,
      ratio: orders.ratio,
      impact: orders.impact,
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
    schemaVersion: 3,
    focusUpdatedAt: saved.updatedAt || "",
    range,
    dates,
    operatorGroups: saved.operatorGroups.map(group => ({ ...group, count: group.userIds.length })),
    users: users.map(user => ({ ...user, operatorGroupIds: focusGroupMembership(saved.operatorGroups, user.userId) })),
    businessRows: businessRows.map(row => ({ ...row, operatorGroupIds: focusGroupMembership(saved.operatorGroups, row.userId) })),
    rows: businessRows.map(row => ({ ...row, operatorGroupIds: focusGroupMembership(saved.operatorGroups, row.userId) })),
    businesses: [...businessMap.values()].sort((a, b) => a.businessName.localeCompare(b.businessName, "zh-CN")),
    total: users.length,
    relationshipTotal: businessRows.length,
    realtimeUserCount: businessRows.filter(row => row.realtimeToday).length,
    latestDataTime: currentTimes.at(-1) || userDetailCacheSavedAtText || "-"
  };
}

async function marketingCostContext() {
  const focus = await readFocusUsers();
  const aliases = (await readUserAliases()).aliases || {};
  const catalog = await focusBusinessCatalog();
  return {
    focus,
    aliases,
    catalog,
    catalogById: new Map(catalog.map(item => [String(item.businessId), item])),
    cacheIndex: focusUserCacheIndex(focus.items.map(item => item.userId))
  };
}

function calculateMarketingCostItem(item, context) {
  const normalized = normalizeMarketingCostItem(item);
  const user = context.focus.items.find(row => String(row.userId) === normalized.userId) || {};
  const business = context.catalogById.get(normalized.businessId) || {
    businessId: normalized.businessId,
    businessName: normalized.businessName || "未命名业务",
    platform: normalized.platform || "-"
  };
  const cached = context.cacheIndex.get(`${normalized.businessId}:${normalized.userId}`) || {};
  const current = cachedFocusCurrentUser(normalized.businessId, normalized.userId);
  const dates = dayList(normalized.startDate, normalized.endDate);
  const dailyOrders = {};
  const missingDates = [];
  for (const date of dates) {
    if (date === dayKey() && T1_USER_BUSINESS_IDS.has(normalized.businessId)) {
      missingDates.push(date);
      continue;
    }
    if (date === dayKey() && current) {
      dailyOrders[date] = number(current.todayOrders);
      continue;
    }
    if (cached.days && Object.prototype.hasOwnProperty.call(cached.days, date)) {
      dailyOrders[date] = number(cached.days[date]);
      continue;
    }
    missingDates.push(date);
  }
  const liveOrders = Object.values(dailyOrders).reduce((sum, value) => sum + number(value), 0);
  const liveAmount = Math.round(liveOrders * normalized.unitPrice * 100) / 100;
  const confirmed = normalized.status === "confirmed" && normalized.lockedOrders !== null && normalized.lockedAmount !== null;
  const dataTimes = [current?.savedAtText, cached.cacheSavedAtText].filter(Boolean).sort();
  return {
    ...normalized,
    userName: context.aliases[normalized.userId] || user.name || cached.name || normalized.userName || `用户 ${normalized.userId}`,
    businessName: business.businessName || normalized.businessName || "未命名业务",
    platform: business.platform || normalized.platform || "-",
    orderCount: confirmed ? normalized.lockedOrders : liveOrders,
    estimatedAmount: confirmed ? normalized.lockedAmount : liveAmount,
    liveOrders,
    liveAmount,
    dailyOrders,
    missingDates,
    complete: missingDates.length === 0,
    t1Pending: T1_USER_BUSINESS_IDS.has(normalized.businessId) && missingDates.includes(dayKey()),
    dataTime: dataTimes.at(-1) || "-"
  };
}

function invalidateMarketingCostWorkspace() {
  marketingCostWorkspaceCache = { data: null, expiresAt: 0, promise: null };
}

async function buildMarketingCostWorkspaceFresh() {
  const saved = await readMarketingCosts();
  const context = await marketingCostContext();
  const items = saved.items.map(item => calculateMarketingCostItem(item, context)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const focusData = await buildFocusUsers({ preset: "custom", start_date: shiftDay(dayKey(), -(DEFAULT_USER_HISTORY_DAYS - 1)), end_date: dayKey() });
  const relationships = (focusData.businessRows || []).map(row => ({
    userId: String(row.userId),
    userName: context.aliases[String(row.userId)] || row.name || `用户 ${row.userId}`,
    businessId: String(row.businessId),
    businessName: row.businessName || "未命名业务",
    platform: row.platform || "-",
    days: row.days || {},
    dataTime: row.userDataTime || "-",
    t1: T1_USER_BUSINESS_IDS.has(String(row.businessId))
  }));
  const summary = {
    itemCount: items.length,
    userCount: new Set(items.map(item => item.userId)).size,
    orderCount: items.reduce((sum, item) => sum + number(item.orderCount), 0),
    estimatedAmount: Math.round(items.reduce((sum, item) => sum + Number(item.estimatedAmount || 0), 0) * 100) / 100
  };
  return {
    ok: true,
    schemaVersion: 2,
    updatedAt: saved.updatedAt,
    updatedAtText: saved.updatedAtText,
    latestDataTime: relationships.map(row => row.dataTime).filter(Boolean).sort().at(-1) || userDetailCacheSavedAtText || "-",
    items,
    summary,
    operatorGroups: focusData.operatorGroups || [],
    users: focusData.users.map(user => ({ userId: String(user.userId), name: context.aliases[String(user.userId)] || user.name || `用户 ${user.userId}` })),
    relationships,
    range: { startDate: shiftDay(dayKey(), -(DEFAULT_USER_HISTORY_DAYS - 1)), endDate: dayKey() }
  };
}

async function buildMarketingCostWorkspace({ refresh = false } = {}) {
  if (!refresh && marketingCostWorkspaceCache.data && Date.now() < marketingCostWorkspaceCache.expiresAt) {
    return { ...marketingCostWorkspaceCache.data, cached: true };
  }
  if (!refresh && marketingCostWorkspaceCache.promise) return marketingCostWorkspaceCache.promise;
  const promise = buildMarketingCostWorkspaceFresh().then(data => {
    marketingCostWorkspaceCache = { data, expiresAt: Date.now() + 60 * 1000, promise: null };
    return data;
  }).catch(error => {
    marketingCostWorkspaceCache.promise = null;
    throw error;
  });
  marketingCostWorkspaceCache.promise = promise;
  return promise;
}

function enqueueMarketingCostMutation(task) {
  const next = marketingCostMutationQueue.then(task, task);
  marketingCostMutationQueue = next.catch(() => {});
  return next;
}

function marketingCostBatchItemId(batchId, userId, businessId, startDate, endDate) {
  const digest = createHash("sha256").update(`${batchId}|${userId}|${businessId}|${startDate}|${endDate}`).digest("hex").slice(0, 24);
  return `cost-${digest}`;
}

async function saveMarketingCost(body) {
  const rawItems = Array.isArray(body.items) ? body.items : [body];
  if (!rawItems.length) throw new Error("请选择需要保存的费用项。");
  if (rawItems.length > 500) throw new Error("单次最多新增500个费用项。");
  const batchId = String(body.batchId || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  const uniqueItems = [];
  const seen = new Set();
  rawItems.forEach(source => {
    const key = String(source?.id || "") || `${String(source?.userId || "")}:${String(source?.businessId || "")}:${String(source?.startDate || "")}:${String(source?.endDate || "")}`;
    if (!seen.has(key)) uniqueItems.push(source || {});
    seen.add(key);
  });
  const saved = await readMarketingCosts();
  const context = await marketingCostContext();
  const savedItems = [];
  let createdCount = 0;
  let updatedCount = 0;
  for (const source of uniqueItems) {
    const requestedId = String(source.id || "") || (batchId && source.userId && source.businessId ? marketingCostBatchItemId(batchId, source.userId, source.businessId, source.startDate, source.endDate) : "");
    const existingIndex = saved.items.findIndex(item => String(item.id) === requestedId);
    const existing = existingIndex >= 0 ? saved.items[existingIndex] : {};
    const item = normalizeMarketingCostItem({ ...existing, ...source, ...(requestedId ? { id:requestedId } : {}), batchId:batchId || existing.batchId || "", updatedAt:new Date().toISOString(), updatedAtText:nowText() });
    if (!item.userId) throw new Error("请选择重点用户。");
    if (!item.businessId) throw new Error("请选择业务。");
    if (!(item.unitPrice > 0)) throw new Error("单价必须大于0。");
    if (dayList(item.startDate, item.endDate).length > 65) throw new Error("单个费用周期最多支持65天。");
    const calculated = calculateMarketingCostItem(item, context);
    if (item.status === "confirmed") {
      if (!calculated.complete) throw new Error(calculated.t1Pending ? "该T+1业务仍有日期待更新，暂不能确认费用。" : `缺少 ${calculated.missingDates.length} 天订单数据，暂不能确认费用。`);
      item.lockedOrders = calculated.liveOrders;
      item.lockedAmount = calculated.liveAmount;
      item.confirmedAt = new Date().toISOString();
      item.confirmedAtText = nowText();
    } else {
      item.lockedOrders = null;
      item.lockedAmount = null;
      item.confirmedAt = "";
      item.confirmedAtText = "";
    }
    if (existingIndex >= 0) {
      saved.items.splice(existingIndex, 1, item);
      updatedCount += 1;
    } else {
      saved.items.unshift(item);
      createdCount += 1;
    }
    savedItems.push(calculateMarketingCostItem(item, context));
  }
  await writeMarketingCosts(saved.items);
  return {
    ok: true,
    savedItems,
    updatedAt: new Date().toISOString(),
    updatedAtText: nowText(),
    batchResult: { batchId, requestedCount: rawItems.length, savedCount: savedItems.length, createdCount, updatedCount }
  };
}

async function removeMarketingCost(body) {
  const id = String(body.id || "");
  const saved = await readMarketingCosts();
  await writeMarketingCosts(saved.items.filter(item => String(item.id) !== id));
  return buildMarketingCostWorkspace();
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
  const groupId = String(body.groupId || body.operatorGroupId || saved.operatorGroups[0]?.id || "");
  let operatorGroups = saved.operatorGroups;
  if (!operatorGroups.length) {
    const createdAt = new Date().toISOString();
    operatorGroups = [{ id: focusGroupId(DEFAULT_FOCUS_GROUP_NAME), name: DEFAULT_FOCUS_GROUP_NAME, userIds: [], createdAt, createdAtText: nowText() }];
  }
  const targetGroup = operatorGroups.find(group => group.id === groupId) || operatorGroups[0];
  if (!targetGroup) throw new Error("请先新增一个运营标签。");
  const existing = saved.items.find(item => String(item.userId) === userId);
  if (existing) {
    if (business && !(existing.businessHints || []).some(hint => String(hint.businessId) === business.businessId)) existing.businessHints = [...(existing.businessHints || []), business];
    operatorGroups = operatorGroups.map(group => group.id === targetGroup.id ? { ...group, userIds: [...new Set([...group.userIds, userId])] } : group);
    return writeFocusUsers(saved.items, operatorGroups);
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
  operatorGroups = operatorGroups.map(group => group.id === targetGroup.id ? { ...group, userIds: [...new Set([...group.userIds, userId])] } : group);
  return writeFocusUsers(saved.items, operatorGroups);
}

async function removeFocusUser(body) {
  const userId = String(body.userId || "");
  const saved = await readFocusUsers();
  const groupId = String(body.groupId || body.operatorGroupId || "");
  if (!groupId) return writeFocusUsers(saved.items.filter(item => String(item.userId) !== userId), saved.operatorGroups.map(group => ({ ...group, userIds: group.userIds.filter(id => id !== userId) })));
  const operatorGroups = saved.operatorGroups.map(group => group.id === groupId ? { ...group, userIds: group.userIds.filter(id => id !== userId) } : group);
  const stillAssigned = operatorGroups.some(group => group.userIds.includes(userId));
  return writeFocusUsers(stillAssigned ? saved.items : saved.items.filter(item => String(item.userId) !== userId), operatorGroups);
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

async function mutateFocusGroup(body) {
  const saved = await readFocusUsers();
  const action = String(body.action || "");
  if (action === "create") {
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) throw new Error("请填写运营标签名称。");
    if (saved.operatorGroups.some(group => group.name === name)) throw new Error("该运营标签已经存在。");
    const createdAt = new Date().toISOString();
    let id = focusGroupId(`${name}-${createdAt}-${randomBytes(4).toString("hex")}`);
    while (saved.operatorGroups.some(group => group.id === id)) id = focusGroupId(`${name}-${randomBytes(8).toString("hex")}`);
    const result = await writeFocusUsers(saved.items, [...saved.operatorGroups, { id, name, userIds: [], createdAt, createdAtText: nowText() }]);
    return { ...result, selectedGroupId: id };
  }
  const groupId = String(body.groupId || "");
  const group = saved.operatorGroups.find(item => item.id === groupId);
  if (!group) throw new Error("运营标签不存在，请刷新后重试。");
  if (action === "rename") {
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) throw new Error("请填写运营标签名称。");
    if (saved.operatorGroups.some(item => item.id !== groupId && item.name === name)) throw new Error("该运营标签已经存在。");
    return writeFocusUsers(saved.items, saved.operatorGroups.map(item => item.id === groupId ? { ...item, name } : item));
  }
  if (action === "remove") {
    const operatorGroups = saved.operatorGroups.filter(item => item.id !== groupId);
    const remainingIds = new Set(operatorGroups.flatMap(item => item.userIds));
    return writeFocusUsers(saved.items.filter(item => remainingIds.has(String(item.userId))), operatorGroups);
  }
  throw new Error("不支持的运营标签操作。");
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
  const publicDetailConfig = await readConfig();
  const fastBusinessIds = new Set((publicDetailConfig.fastUserBusinessIds || []).map(String));
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
        const complete = payload.partial === true || payload.complete === false ? 0 : 1;
        const rank = [complete, String(key.endDate || ""), (payload.dates || []).length, timeValue(payload.savedAtText)];
        const previous = historyRanks.get(id);
        if (previous && (
          rank[0] < previous[0]
          || (rank[0] === previous[0] && rank[1] < previous[1])
          || (rank[0] === previous[0] && rank[1] === previous[1] && rank[2] < previous[2])
          || (rank[0] === previous[0] && rank[1] === previous[1] && rank[2] === previous[2] && rank[3] <= previous[3])
        )) continue;
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
      if (key.type || payload.partial === true || payload.complete === false || !(payload.rows || []).length) continue;
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
    const historyRows = detail.history?.rows || [];
    if (!full) {
      if (!fastBusinessIds.has(String(businessId))) continue;
      const partial = latestPartialBusinessUsers(businessId, dateRange.endDate);
      const currentMap = new Map(deduplicateBusinessUsers(detail.rows || []).map(row => [String(row.id || ""), row]));
      for (const row of deduplicateBusinessUsers(partial?.rows || [])) {
        currentMap.set(String(row.id || ""), { ...row, currentDataTime: partial.savedAtText || "", realtimeToday: true });
      }
      for (const row of latestFocusCurrentRows(businessId, dateRange.endDate)) {
        const id = String(row.id || "");
        const existing = currentMap.get(id);
        if (!existing || timeValue(row.currentDataTime) >= timeValue(existing.currentDataTime)) currentMap.set(id, row);
      }
      const currentRows = [...currentMap.values()];
      const currentById = new Map(currentRows.map(row => [String(row.id || ""), row]));
      const historyLatestDataTime = detail.history?.latestDataTime || "";
      const historyById = new Map(historyRows.map(row => [String(row.id || ""), row]));
      const currentLatestDataTime = currentRows.map(row => row.currentDataTime).filter(Boolean).sort().at(-1)
        || partial?.savedAtText
        || (currentRows.length ? (detail.currentLatestDataTime || detail.latestDataTime || historyLatestDataTime) : historyLatestDataTime);
      const targetMinutes = new Set([historyLatestDataTime, ...currentRows.map(row => row.currentDataTime)].map(comparisonMinuteFromText).filter(Number.isFinite));
      const referenceDays = new Set(Array.from({ length: 7 }, (_, index) => shiftDay(dateRange.endDate, -(index + 1))));
      const comparisonUserIds = new Set(currentRows.map(row => String(row.id || "")));
      for (const snapshot of snapshots) {
        if (!referenceDays.has(snapshot.day)) continue;
        if (![...targetMinutes].some(targetMinute => Math.abs(number(snapshot.minuteOfDay) - targetMinute) <= 20)) continue;
        Object.keys(snapshot.businessUsers?.[businessId] || {}).forEach(userId => comparisonUserIds.add(String(userId)));
      }
      const comparisonRows = [...comparisonUserIds].map(userId => {
        const current = currentById.get(userId);
        const history = historyById.get(userId);
        if (!current && !history) return null;
        return {
          ...(history || {}),
          ...(current || {}),
          id: userId,
          currentDataTime: current?.currentDataTime || historyLatestDataTime,
          todayOrders: current ? number(current.todayOrders) : number(history?.days?.[dateRange.endDate])
        };
      }).filter(Boolean);
      const comparisons = enrichBusinessUsersWithSnapshots(comparisonRows, snapshots, businessId, dateRange, comparisonMinuteFromText(currentLatestDataTime));
      detail.sameTimeUsers = Object.fromEntries(comparisons.filter(row => row.sameTime?.hasSnapshot).map(row => [String(row.id || ""), row.sameTime]));
      detail.rows = currentRows;
      detail.total = Math.max(number(detail.history?.total), number(partial?.total), historyRows.length, currentRows.length);
      detail.latestDataTime = currentLatestDataTime || "-";
      detail.currentLatestDataTime = detail.latestDataTime;
      detail.fullCurrentLatestDataTime = "-";
      detail.realtimeUserCount = currentRows.length;
      detail.partialCurrent = Boolean(partial);
      continue;
    }
    const fast = latestFastBusinessUsers(businessId, dateRange.endDate);
    const fullTime = timeValue(full.savedAtText);
    const fastIsNewer = timeValue(fast?.savedAtText) > fullTime;
    const currentById = new Map(deduplicateBusinessUsers(full.rows || []).map(row => [String(row.id || ""), { ...row, currentDataTime: full.savedAtText || "" }]));
    if (fastIsNewer) {
      for (const row of deduplicateBusinessUsers(fast.rows || [])) currentById.set(String(row.id || ""), { ...row, currentDataTime: fast.savedAtText || "" });
    }
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
      30: await buildFocusUsers({ preset: "30" })
    },
    marketingCosts: await buildMarketingCostWorkspace()
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
      const startDate = parseDay(url.searchParams.get("start_date") || shiftDay(endDate, -(DEFAULT_USER_HISTORY_DAYS - 1)));
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
      return json(res, 200, {
        ok: result.ok,
        cached: Boolean(result.cached),
        complete: result.complete !== false && result.partial !== true,
        partial: result.partial === true || result.complete === false,
        upstreamOk: result.upstreamOk !== false,
        latestDataTime: result.savedAtText || "-",
        dates: result.dates,
        rows: result.rows,
        total: result.total,
        source: { statuses }
      });
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
    if (url.pathname === "/api/focus-groups" && req.method === "POST") {
      const saved = await mutateFocusGroup(await readBody(req));
      const data = await buildFocusUsers({ preset: "7" });
      const published = await publishLatestCachedDashboard().catch(error => {
        console.error(`[${nowText()}] 重点用户运营标签公网同步失败：${error.message}`);
        return false;
      });
      return json(res, 200, { ok: true, saved: { updatedAt: saved.updatedAt, updatedAtText: saved.updatedAtText }, selectedGroupId: saved.selectedGroupId || "", data, published });
    }
    if (url.pathname === "/api/focus-users/refresh-metrics" && req.method === "POST") {
      const body = await readBody(req);
      const result = await refreshFocusUsersMetricHistories(body.days, body.includeMetrics !== false);
      if (!result.ok) return json(res, 502, result);
      const data = await buildFocusUsers({ preset: "7" });
      const published = await publishLatestCachedDashboard().catch(error => {
        console.error(`[${nowText()}] 重点用户指标公网同步失败：${error.message}`);
        return false;
      });
      return json(res, 200, { ...result, data, published });
    }
    if (url.pathname === "/api/marketing-costs" && req.method === "GET") {
      return json(res, 200, await buildMarketingCostWorkspace({ refresh: url.searchParams.get("refresh") === "1" }));
    }
    if (url.pathname === "/api/marketing-costs" && req.method === "POST") {
      const body = await readBody(req);
      const data = await enqueueMarketingCostMutation(() => saveMarketingCost(body));
      json(res, 200, { ...data, syncing: true });
      publishLatestCachedDashboard().catch(error => console.error(`[${nowText()}] 营销费用公网同步失败：${error.message}`));
      return;
    }
    if (url.pathname === "/api/marketing-costs/remove" && req.method === "POST") {
      const body = await readBody(req);
      const data = await enqueueMarketingCostMutation(() => removeMarketingCost(body));
      json(res, 200, { ...data, syncing: true });
      publishLatestCachedDashboard().catch(error => console.error(`[${nowText()}] 营销费用删除公网同步失败：${error.message}`));
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
