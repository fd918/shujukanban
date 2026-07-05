import { createHash, createHmac, createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BASE_URL = "https://adminalliance.yunzhanxinxi.com";
const PORT = Number(process.env.DASHBOARD_PORT || 8791);
const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, "data/business-dashboard-config.json");
const SNAPSHOT_PATH = join(ROOT, "data/business-dashboard-snapshots.jsonl");
const DASHBOARD_CACHE_PATH = join(ROOT, "data/business-dashboard-cache.json");
const USER_PHONE_INDEX_PATH = join(ROOT, "data/user-phone-index.json");
const USER_DETAIL_CACHE_PATH = join(ROOT, "data/business-user-detail-cache.json");
const PUBLIC_DASHBOARD_PATH = join(ROOT, "data/business-dashboard-public.enc.json");
const USER_SERVICE = "com.tanwenjie.yunzhan-business-dashboard.username";
const PASS_SERVICE = "com.tanwenjie.yunzhan-business-dashboard.password";
const FEISHU_WEBHOOK_SERVICE = "com.tanwenjie.business-dashboard.feishu.webhook";
const FEISHU_SECRET_SERVICE = "com.tanwenjie.business-dashboard.feishu.secret";
const PUBLIC_PASSWORD_SERVICE = "com.tanwenjie.business-dashboard.public.password";

let token = process.env.YZ_DASHBOARD_TOKEN || "";
let tokenExpiresAt = 0;
let snapshotTimer = null;
let lastSnapshotAt = 0;
let lastGood = { businesses: [], users: [], summary: null, hourlyTrend: [] };
const userDetailCache = new Map();
const userPhoneCache = new Map();
const userProfileCache = new Map();
let userPhoneIndexLoadedAt = 0;
let userPhoneIndexPromise = null;
let lastOperationalAlert = { key: "", at: 0 };
let startupWarmupRunning = false;
let detailCacheSaveTimer = null;

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
  notification: {
    mode: "immediate",
    criticalImmediate: true,
    enabled: false,
    snapshotAlert: true
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
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

async function readConfig() {
  try {
    const saved = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return {
      ...defaultConfig,
      ...saved,
      rules: { ...defaultConfig.rules, ...(saved.rules || {}) },
      notification: { ...defaultConfig.notification, ...(saved.notification || {}) },
      public: { ...defaultConfig.public, ...(saved.public || {}) }
    };
  } catch {
    return defaultConfig;
  }
}

async function writeConfig(nextConfig) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  const config = {
    ...defaultConfig,
    ...nextConfig,
    rules: { ...defaultConfig.rules, ...(nextConfig.rules || {}) },
    notification: { ...defaultConfig.notification, ...(nextConfig.notification || {}) },
    public: { ...defaultConfig.public, ...(nextConfig.public || {}) }
  };
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  scheduleSnapshots();
  return config;
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

  const response = await fetchWithTimeout(`${BASE_URL}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "origin": "https://adminpub.yunzhanxinxi.com",
      "referer": "https://adminpub.yunzhanxinxi.com/"
    },
    body: new URLSearchParams({ usrName: user, passWord: md5(`YZ_ADMIN_${pass}`) })
  }, 10000);
  const payload = await response.json();
  if (payload.code !== 200 || !payload.data?.access_token) throw new Error(payload.message || "中台登录失败");
  token = payload.data.access_token;
  tokenExpiresAt = Date.now() + 20 * 60 * 1000;
  return token;
}

async function apiCall(name, method, path, data, timeoutMs = 12000) {
  const startedAt = Date.now();
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
        phone: String(profile.phone || phones[id] || "")
      });
    });
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
    return userDetailCache.size > 0;
  } catch {
    return false;
  }
}

async function writeUserDetailCacheToDisk() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  const entries = Array.from(userDetailCache.entries()).slice(-300);
  await writeFile(USER_DETAIL_CACHE_PATH, JSON.stringify({
    savedAt: new Date().toISOString(),
    savedAtText: nowText(),
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
  if (userPhoneCache.size && userProfileCache.size && Date.now() - userPhoneIndexLoadedAt < 24 * 60 * 60 * 1000) return;
  if (!userPhoneCache.size && await loadUserPhoneIndexFromDisk()) {
    statuses.push({ name: "用户明文手机号索引", ok: true, message: `使用本地索引：${userPhoneCache.size} 个手机号`, durationMs: 0 });
    return;
  }
  if (userPhoneIndexPromise) return userPhoneIndexPromise;
  userPhoneIndexPromise = (async () => {
    const startedAt = Date.now();
    const first = await apiCall("用户明文手机号索引第1页", "POST", "/api/v2/dashboard/user/day", { page: 1 }, 25000);
    if (!first.ok) {
      statuses.push(first);
      return;
    }
    const firstRows = asList(first.data);
    const total = number(first.data?.total);
    const pageSize = Math.max(1, number(first.data?.pageSize) || firstRows.length || 30);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    const rest = await mapLimit(pages, 8, page => apiCall(`用户明文手机号索引第${page}页`, "POST", "/api/v2/dashboard/user/day", { page }, 25000));
    const rows = firstRows.concat(...rest.filter(item => item.ok).map(item => asList(item.data)));
    rows.forEach(row => {
      const id = String(row.promotion_id || row.uid || row.accounts_id || "");
      const phone = String(row.telephone || row.phone || "");
      if (id && /^1\d{10}$/.test(phone)) userPhoneCache.set(id, phone);
      if (id) userProfileCache.set(id, { name: String(row.nickname || ""), phone });
    });
    userPhoneIndexLoadedAt = Date.now();
    await writeUserPhoneIndexToDisk();
    const failed = rest.filter(item => !item.ok).length;
    statuses.push({
      name: "用户明文手机号索引",
      ok: failed === 0,
      message: `已索引 ${userPhoneCache.size} 个手机号${failed ? `，${failed} 页失败` : ""}`,
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

function currentHourForRange(dateRange) {
  if (dateRange.days === 1 && dateRange.endDate === dayKey()) {
    const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).formatToParts(new Date());
    return Number(parts.find(item => item.type === "hour")?.value || 0);
  }
  return 23;
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

function sumTrendUntil(rows, hour) {
  return rows.reduce((sum, item) => {
    const itemHour = Number(String(item.paid_date || "").slice(0, 2));
    return Number.isFinite(itemHour) && itemHour <= hour ? sum + number(item.value) : sum;
  }, 0);
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

  const sameTimeHour = currentHourForRange(dateRange);
  previousRows.sameTimeOrders = {};
  previousRows.sameTimeCommission = {};
  const trendTargets = rows
    .map(row => ({ id: String(row.order_type || row.business_id || row.subtitle || ""), platform: String(row.order_category_id || row.platform_business_id || "") }))
    .filter(item => item.id && item.platform);
  const trendResults = dateRange.days === 1 ? await mapLimit(trendTargets, 8, item => apiCall(`业务基准趋势-${item.platform}`, "POST", "/api/v2/order-statistic/trend-new", {
    platform: item.platform,
    paid_date: [dateRange.previousEndDate, dateRange.previousEndDate],
    filter_field: "order_count"
  }, 12000)) : [];
  trendResults.forEach((result, index) => {
    const target = trendTargets[index];
    if (result?.ok) previousRows.sameTimeOrders[target.id] = sumTrendUntil(result.data?.data || [], sameTimeHour);
  });

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

async function fetchBusinessDaily(statuses) {
  const endDate = dayKey();
  const startDate = shiftDay(endDate, -6);
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

async function fetchBusinessUsers({ businessId = "", startDate, endDate, page = 1, pageSize = 100, sortField = "", sortOrder = "", refresh = false }, statuses = []) {
  const cacheKey = JSON.stringify({ businessId, startDate, endDate, page, pageSize, sortField, sortOrder });
  if (!refresh && userDetailCache.has(cacheKey)) {
    const cached = userDetailCache.get(cacheKey);
    statuses.push({ name: "业务用户缓存", ok: true, message: `使用缓存：${cached.rows.length} 个用户`, durationMs: 0 });
    return { ...cached, cached: true };
  }
  const params = { order_type: businessId, page, pre_page: pageSize, start_date: startDate, end_date: endDate };
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
  if (businessId) {
    const previousDay = shiftDay(endDate, -1);
    const previous = await apiCall("业务用户前一日基准", "GET", "/api/v2/dashboard/business/user-order-statistics", {
      order_type: businessId,
      page: 1,
      pre_page: pageSize,
      start_date: previousDay,
      end_date: previousDay
    }, 30000);
    statuses.push(previous);
    let previousRows = asList(previous.data);
    const previousTotal = number(previous.data?.total);
    const previousPerPage = Math.max(1, number(previous.data?.per_page) || previousRows.length || 10);
    const previousTotalPages = Math.max(1, number(previous.data?.total_pages) || Math.ceil(previousTotal / previousPerPage));
    const previousNeedPages = Math.min(previousTotalPages, Math.ceil(Math.max(pageSize, previousRows.length) / previousPerPage));
    if (previous.ok && previousNeedPages > 1) {
      const previousRestPages = Array.from({ length: previousNeedPages - 1 }, (_, index) => index + 2);
      const previousRest = await mapLimit(previousRestPages, 8, currentPage => apiCall(`业务用户前一日基准第${currentPage}页`, "GET", "/api/v2/dashboard/business/user-order-statistics", {
        order_type: businessId,
        page: currentPage,
        pre_page: pageSize,
        start_date: previousDay,
        end_date: previousDay
      }, 30000));
      previousRows = previousRows.concat(...previousRest.filter(item => item.ok).map(item => asList(item.data)));
    }
    previousById = {};
    previousRows.forEach(row => {
      const id = String(row.uid || row.promotion_id || row.accounts_id || "");
      previousById[id] = number(previousById[id]) + number(row[previousDay] ?? row.period_total);
    });
  }
  const rows = allRows.slice(0, pageSize).map(row => normalizeUser(row, startDate === endDate ? endDate : "period_total"));
  rows.forEach(row => {
    row.yesterdayOrders = previousById[row.id] || 0;
  });
  await mapLimit(rows, 8, async row => {
    const plainPhone = await fetchPlainPhone(row.id);
    if (plainPhone) row.phone = plainPhone;
  });
  const payload = {
    ok: result.ok,
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

async function warmBusinessUserDetails(businesses, dateRange) {
  const rows = (businesses || []).filter(row => row.platformBusinessId || row.businessId);
  if (!rows.length) return;
  let warmed = 0;
  await mapLimit(rows, 2, async row => {
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
        refresh: false
      }, statuses);
      warmed += 1;
    } catch (error) {
      console.error(`[${nowText()}] 预热业务用户失败：${row.name} ${error.message}`);
    }
  });
  console.log(`[${nowText()}] 已预热业务用户明细缓存：${warmed}/${rows.length}`);
}

async function warmStartupData() {
  if (startupWarmupRunning) return;
  startupWarmupRunning = true;
  try {
    console.log(`[${nowText()}] 开始启动预热：用户索引、今日业务、用户明细缓存`);
    const loadedDetailCache = await loadUserDetailCacheFromDisk();
    if (loadedDetailCache) console.log(`[${nowText()}] 已加载本地用户明细缓存：${userDetailCache.size} 条`);
    await ensureUserPhoneIndex();
    const dateRange = rangeFromQuery({ preset: "today", start_date: dayKey(), end_date: dayKey() });
    const data = await liveDashboard({ recordSnapshot: false, query: { preset: "today", start_date: dateRange.startDate, end_date: dateRange.endDate, force: "1" } });
    await warmBusinessUserDetails(data.businesses, dateRange);
    console.log(`[${nowText()}] 启动预热完成`);
  } catch (error) {
    console.error(`[${nowText()}] 启动预热失败：${error.message}`);
    readConfig()
      .then(config => notifyOperationalIssue("启动预热失败", error.message, config))
      .catch(notifyError => console.error(`[${nowText()}] 飞书通知失败：${notifyError.message}`));
  } finally {
    startupWarmupRunning = false;
  }
}

async function readSnapshots(limit = 5000) {
  if (!existsSync(SNAPSHOT_PATH)) return [];
  const text = await readFile(SNAPSHOT_PATH, "utf8");
  return text.trim().split("\n").filter(Boolean).slice(-limit).map(line => JSON.parse(line));
}

function nearestSnapshot(snapshots, targetDay, targetMinute) {
  const candidates = snapshots.filter(item => item.day === targetDay);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => Math.abs(a.minuteOfDay - targetMinute) - Math.abs(b.minuteOfDay - targetMinute))[0];
}

function enrichWithSnapshots(rows, snapshots, type, dateRange = rangeFromQuery()) {
  const currentDate = dateFromDay(dateRange.endDate);
  const minute = minuteOfDay();
  const yesterday = nearestSnapshot(snapshots, dayKey(addDays(currentDate, -1)), minute);
  const lastWeek = nearestSnapshot(snapshots, dayKey(addDays(currentDate, -7)), minute);
  const recent = Array.from({ length: 7 }, (_, index) => nearestSnapshot(snapshots, dayKey(addDays(currentDate, -(index + 1))), minute)).filter(Boolean);

  return rows.map(row => {
    const id = String(type === "business" ? row.businessId : row.id);
    const pick = snap => snap?.[type]?.[id] || null;
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
        yesterday: pick(yesterday) || (row.yesterdaySameTimeOrders || row.yesterdaySameTimeCommission || row.yesterdayOrders || row.yesterdayCommission ? {
          orders: number(row.yesterdaySameTimeOrders || row.yesterdayOrders),
          commission: number(row.yesterdaySameTimeCommission || row.yesterdayCommission),
          source: row.yesterdaySameTimeOrders ? "中台昨日同时刻趋势" : "中台前一日全日"
        } : null),
        lastWeek: pick(lastWeek),
        sevenDayAvg: avg,
        hasSnapshot: Boolean(pick(yesterday) || pick(lastWeek) || avg),
        hasApiBaseline: Boolean(row.yesterdaySameTimeOrders || row.yesterdayOrders)
      }
    };
  });
}

function enrichBusinessUsersWithSnapshots(rows, snapshots, businessId, dateRange = rangeFromQuery()) {
  const currentDate = dateFromDay(dateRange.endDate);
  const minute = minuteOfDay();
  const yesterday = nearestSnapshot(snapshots, dayKey(addDays(currentDate, -1)), minute);
  const lastWeek = nearestSnapshot(snapshots, dayKey(addDays(currentDate, -7)), minute);
  const recent = Array.from({ length: 7 }, (_, index) => nearestSnapshot(snapshots, dayKey(addDays(currentDate, -(index + 1))), minute)).filter(Boolean);
  const businessKey = String(businessId || "");

  return rows.map(row => {
    const id = String(row.id || "");
    const pick = snap => snap?.businessUsers?.[businessKey]?.[id] || null;
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
        yesterday: pick(yesterday) || (row.yesterdayOrders || row.yesterdayCommission ? {
          orders: number(row.yesterdayOrders),
          commission: number(row.yesterdayCommission),
          source: "中台业务用户前一日全日"
        } : null),
        lastWeek: pick(lastWeek),
        sevenDayAvg: avg,
        hasSnapshot: Boolean(pick(yesterday) || pick(lastWeek) || avg),
        hasApiBaseline: Boolean(row.yesterdayOrders || row.yesterdayCommission)
      }
    };
  });
}

function cachedBusinessUsersSnapshot(dateRange) {
  const details = {};
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      if (key.startDate !== dateRange.startDate || key.endDate !== dateRange.endDate) continue;
      const businessId = String(key.businessId);
      const rows = payload.rows || [];
      if (details[businessId] && Object.keys(details[businessId]).length >= rows.length) continue;
      const byUser = {};
      for (const row of rows) {
        const userId = String(row.id);
        byUser[userId] ||= { name: row.name, phone: row.phone, version: row.version, orders: 0, commission: 0 };
        byUser[userId].orders += number(row.todayOrders);
        byUser[userId].commission += number(row.todayCommission);
      }
      details[businessId] = byUser;
    } catch {
      // Ignore old cache keys that are not JSON.
    }
  }
  return details;
}

async function liveDashboard({ recordSnapshot = true, query = {} } = {}) {
  const config = await readConfig();
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
        config,
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
    fetchBusinessDaily(statuses)
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

  if (recordSnapshot) await maybeRecordSnapshot(businesses, users);
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

async function maybeRecordSnapshot(businesses, users, force = false) {
  const config = await readConfig();
  const interval = Math.max(1, Number(config.snapshotMinutes || 30)) * 60 * 1000;
  if (!force && Date.now() - lastSnapshotAt < interval) return false;
  const dateRange = rangeFromQuery();
  await warmBusinessUserDetails(businesses, dateRange);
  const previousSnapshot = (await readSnapshots(1))[0] || null;
  await mkdir(join(ROOT, "data"), { recursive: true });
  const snapshot = {
    createdAt: new Date().toISOString(),
    createdAtText: nowText(),
    day: dayKey(),
    minuteOfDay: minuteOfDay(),
    business: Object.fromEntries(businesses.map(row => [String(row.businessId), { name: row.name, platform: row.platform, orders: row.todayOrders, commission: row.todayCommission }])),
    users: Object.fromEntries(users.map(row => [String(row.id), { name: row.name, phone: row.phone, orders: row.todayOrders, commission: row.todayCommission }])),
    businessUsers: cachedBusinessUsersSnapshot(dateRange)
  };
  await checkSnapshotHealth(snapshot, previousSnapshot, config);
  await appendFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot)}\n`);
  lastSnapshotAt = Date.now();
  if (config.public?.autoPush) {
    await publishPublicDashboard({ businesses, users, snapshot, config }).catch(error => {
      console.error(`[${nowText()}] 公开看板推送失败：${error.message}`);
      notifyOperationalIssue("公开看板推送失败", error.message, config).catch(notifyError => console.error(`[${nowText()}] 飞书通知失败：${notifyError.message}`));
    });
  }
  return true;
}

async function checkSnapshotHealth(snapshot, previousSnapshot, config = defaultConfig) {
  const businesses = Object.values(snapshot.business || {});
  const totalOrders = businesses.reduce((sum, item) => sum + number(item.orders), 0);
  if (!businesses.length) {
    await notifyOperationalIssue("快照异常：业务为空", "本次快照没有业务数据，请检查中台接口或本地服务。", config);
    return;
  }
  if (!totalOrders) {
    await notifyOperationalIssue("快照异常：订单全为 0", "本次快照业务总订单为 0，可能是中台接口异常或数据尚未回传。", config);
    return;
  }
  if (!previousSnapshot?.business) return;
  const currentEntries = Object.entries(snapshot.business);
  const comparable = currentEntries.filter(([id, item]) => {
    const prev = previousSnapshot.business[id];
    return prev && (number(prev.orders) > 0 || number(item.orders) > 0);
  });
  if (comparable.length < 20) return;
  const same = comparable.filter(([id, item]) => number(previousSnapshot.business[id].orders) === number(item.orders));
  const ratio = same.length / comparable.length;
  if (ratio >= 0.95 && snapshot.minuteOfDay !== previousSnapshot.minuteOfDay) {
    await notifyOperationalIssue(
      "快照异常：大量业务数据未变化",
      `本次有 ${same.length}/${comparable.length} 个活跃业务订单数与上一条快照完全一致，可能是中台接口返回旧数据。`,
      config
    );
  }
}

async function scheduleSnapshots() {
  if (snapshotTimer) clearInterval(snapshotTimer);
  const config = await readConfig();
  const ms = Math.max(1, Number(config.snapshotMinutes || 30)) * 60 * 1000;
  snapshotTimer = setInterval(async () => {
    try {
      const data = await liveDashboard({ recordSnapshot: false });
      if (data.source?.missing?.length) {
        await notifyOperationalIssue("快照异常：接口数据缺失", data.source.missing.join("；"), config);
      }
      await maybeRecordSnapshot(data.businesses, data.users, true);
      console.log(`[${nowText()}] 已记录业务用户快照`);
    } catch (error) {
      console.error(`[${nowText()}] 记录快照失败：${error.message}`);
      readConfig()
        .then(config => notifyOperationalIssue("快照异常：记录失败", error.message, config))
        .catch(notifyError => console.error(`[${nowText()}] 飞书通知失败：${notifyError.message}`));
    }
  }, ms);
}

async function getPublicConfig() {
  const config = await readConfig();
  return {
    ...config,
    notification: {
      ...config.notification,
      hasWebhook: Boolean(await readSecret(FEISHU_WEBHOOK_SERVICE)),
      hasSignSecret: Boolean(await readSecret(FEISHU_SECRET_SERVICE))
    }
  };
}

async function saveConfig(body) {
  if (body.feishu?.webhookUrl) await writeSecret(FEISHU_WEBHOOK_SERVICE, body.feishu.webhookUrl);
  if (body.feishu?.signSecret) await writeSecret(FEISHU_SECRET_SERVICE, body.feishu.signSecret);
  const current = await readConfig();
  return writeConfig({
    ...current,
    rules: body.rules || current.rules,
    refreshSeconds: Number(body.refreshSeconds || current.refreshSeconds || defaultConfig.refreshSeconds),
    snapshotMinutes: body.snapshotMinutes || current.snapshotMinutes,
    notification: { ...current.notification, ...(body.notification || {}) },
    public: { ...current.public, ...(body.public || {}) }
  });
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

async function notifyOperationalIssue(title, detail, config = defaultConfig) {
  if (!config.notification?.enabled || !config.notification?.snapshotAlert) return;
  const key = title;
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
  for (const [cacheKey, payload] of userDetailCache.entries()) {
    try {
      const key = JSON.parse(cacheKey);
      if (key.startDate !== dateRange.startDate || key.endDate !== dateRange.endDate) continue;
      const rows = enrichBusinessUsersWithSnapshots(payload.rows || [], snapshots, key.businessId, dateRange);
      details[String(key.businessId)] = {
        latestDataTime: nowText(),
        total: payload.total || rows.length,
        rows
      };
    } catch {
      // Ignore old cache keys that are not JSON.
    }
  }
  return details;
}

async function sanitizePublicDashboard(data) {
  const dateRange = data.dateRange || rangeFromQuery();
  await warmBusinessUserDetails(data.businesses || [], dateRange);
  return {
    ok: true,
    latestDataTime: nowText(),
    dateRange,
    config: {
      rules: data.config?.rules || defaultConfig.rules,
      refreshSeconds: data.config?.refreshSeconds || defaultConfig.refreshSeconds,
      snapshotMinutes: data.config?.snapshotMinutes || defaultConfig.snapshotMinutes
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
    userDetails: await encryptedPublicUserDetails(dateRange)
  };
}

async function encryptPublicPayload(payload) {
  const password = await readSecret(PUBLIC_PASSWORD_SERVICE);
  if (!password) throw new Error("缺少公网看板访问密码，请先写入钥匙串。");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 200000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: 200000,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
    updatedAt: new Date().toISOString(),
    updatedAtText: nowText()
  };
}

async function publishPublicDashboard(data) {
  const payload = await sanitizePublicDashboard(data);
  const encryptedPayload = await encryptPublicPayload(payload);
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(PUBLIC_DASHBOARD_PATH, JSON.stringify(encryptedPayload, null, 2));
  await pushPublicDashboard();
}

async function pushPublicDashboard() {
  await runCommand("git", ["add", ".gitignore", "README.md", "business-user-dashboard-prototype.html", "dashboard-live-server.mjs", "scripts/start-business-user-dashboard-service.zsh", "data/business-dashboard-public.enc.json"]);
  const status = await runCommand("git", ["status", "--short", "--", ".gitignore", "README.md", "business-user-dashboard-prototype.html", "dashboard-live-server.mjs", "scripts/start-business-user-dashboard-service.zsh", "data/business-dashboard-public.enc.json"]);
  if (!status) {
    console.log(`[${nowText()}] 业务看板公开文件没有变化，跳过 GitHub 推送。`);
    return false;
  }
  await runCommand("git", ["commit", "-m", `Update business dashboard ${nowText()}`]);
  await runCommand("git", ["push", "origin", "main"]);
  console.log(`[${nowText()}] 业务看板公开文件已推送到 GitHub。`);
  return true;
}

async function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = url.pathname === "/" ? "business-user-dashboard-prototype.html" : decodeURIComponent(url.pathname.slice(1));
  const path = join(ROOT, file);
  try {
    const content = await readFile(path);
    res.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream" });
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
    if (url.pathname === "/api/live-dashboard") return json(res, 200, await liveDashboard({ query: Object.fromEntries(url.searchParams.entries()) }));
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
      const users = enrichBusinessUsersWithSnapshots(result.rows, snapshots, url.searchParams.get("business_id") || "", rangeFromQuery({ start_date: startDate, end_date: endDate }));
      return json(res, 200, { ok: result.ok, cached: Boolean(result.cached), latestDataTime: nowText(), users, total: result.total, page: result.page, pageSize: result.pageSize, source: { statuses } });
    }
    if (url.pathname === "/api/config" && req.method === "GET") return json(res, 200, await getPublicConfig());
    if (url.pathname === "/api/config" && req.method === "POST") return json(res, 200, { ok: true, config: await saveConfig(await readBody(req)) });
    if (url.pathname === "/api/feishu/test" && req.method === "POST") return json(res, 200, await testFeishu());
    if (url.pathname === "/api/snapshot" && req.method === "POST") {
      const data = await liveDashboard({ recordSnapshot: false });
      const recorded = await maybeRecordSnapshot(data.businesses, data.users, true);
      return json(res, 200, { ok: true, recorded, latestDataTime: nowText() });
    }
    await serveFile(req, res);
  } catch (error) {
    json(res, 500, { ok: false, error: error.message, latestDataTime: nowText() });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  await scheduleSnapshots();
  console.log(`业务异常监控看板已启动：http://127.0.0.1:${PORT}/`);
  warmStartupData();
});
