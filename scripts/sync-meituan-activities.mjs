import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envPath = resolve(root, ".env");
const htmlPath = resolve(root, "meituan-dashboard-preview.html");
const savedActivitiesPath = resolve(root, "data/saved-activities.json");
const activityListPath = resolve(root, "data/activity-list.json");
const configPath = resolve(root, "data/watch-config.json");
const endpoint = "https://media.meituan.com/ipc/pcActivityList?yodaReady=h5&csecplatform=4&csecversion=4.2.4";

const statusMap = {
  1: "未开始",
  2: "进行中",
  3: "已结束",
  4: "结算中",
  5: "已结算"
};

function loadEnv() {
  if (!existsSync(envPath)) {
    throw new Error("未找到 .env。请先配置美团请求标头。");
  }
  const env = {};
  readFileSync(envPath, "utf8").split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index < 0) return;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  });
  return env;
}

function parseRawHeaders(text) {
  const headers = {};
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || /^POST\s+/i.test(trimmed) || /^GET\s+/i.test(trimmed)) return;
    const index = trimmed.indexOf(":");
    if (index < 0) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!key || !value) return;
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "accept-encoding"].includes(lower)) return;
    headers[key] = value;
  });
  return headers;
}

function requestHeaders(env) {
  if (env.MEITUAN_HEADERS_FILE) {
    const headersPath = resolve(root, env.MEITUAN_HEADERS_FILE);
    if (!existsSync(headersPath)) {
      throw new Error(`未找到请求标头文件：${env.MEITUAN_HEADERS_FILE}`);
    }
    const parsed = parseRawHeaders(readFileSync(headersPath, "utf8"));
    if (!parsed.Cookie) throw new Error("请求标头文件中没有 Cookie。");
    if (!parsed.mtgsig) throw new Error("请求标头文件中没有 mtgsig。");
    return {
      "Accept": parsed.Accept || "application/json, text/plain, */*",
      "Accept-Language": parsed["Accept-Language"] || "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/json",
      "Cookie": parsed.Cookie,
      "Origin": parsed.Origin || "https://media.meituan.com",
      "Referer": parsed.Referer || "https://media.meituan.com/pc/index.html",
      "User-Agent": parsed["User-Agent"] || "Mozilla/5.0",
      "mtgsig": parsed.mtgsig,
      "sec-ch-ua": parsed["sec-ch-ua"],
      "sec-ch-ua-mobile": parsed["sec-ch-ua-mobile"],
      "sec-ch-ua-platform": parsed["sec-ch-ua-platform"]
    };
  }
  if (!env.MEITUAN_COOKIE || !env.MEITUAN_MTGSIG) {
    throw new Error(".env 缺少 MEITUAN_COOKIE 或 MEITUAN_MTGSIG。");
  }
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    "Cookie": env.MEITUAN_COOKIE,
    "Origin": "https://media.meituan.com",
    "Referer": "https://media.meituan.com/pc/index.html",
    "User-Agent": "Mozilla/5.0",
    "mtgsig": env.MEITUAN_MTGSIG
  };
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(resolve(root, "data"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function formatDateTime(seconds) {
  if (!seconds) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date(Number(seconds) * 1000)).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 100000000000 ? Math.floor(number / 1000) : number;
}

function extractList(data) {
  const source = data?.data || data || {};
  if (Array.isArray(source)) return { list: source, total: source.length };
  const keys = ["activityList", "list", "dataList", "records", "resultList", "items"];
  for (const key of keys) {
    if (Array.isArray(source[key])) return { list: source[key], total: Number(source.total || source.totalCount || source.count || source[key].length) };
  }
  for (const value of Object.values(source)) {
    if (Array.isArray(value)) return { list: value, total: Number(source.total || source.totalCount || source.count || value.length) };
  }
  return { list: [], total: 0 };
}

async function fetchPage(headers, activityStatus, pageNum, pageSize) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      activityName: "",
      activityStartTime: 0,
      activityEndTime: 0,
      registerStatus: 0,
      activityStatus,
      pageNum,
      pageSize
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`活动列表请求失败：HTTP ${response.status} ${text.slice(0, 120)}`);
  }
  const json = JSON.parse(text);
  if (json.code !== 0) {
    throw new Error(`活动列表接口返回失败：${json.msg || "未知错误"}`);
  }
  return extractList(json);
}

async function fetchAllByStatus(headers, activityStatus) {
  const pageSize = 50;
  const result = [];
  let total = 0;
  for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
    const page = await fetchPage(headers, activityStatus, pageNum, pageSize);
    total = Number(page.total || total || page.list.length);
    result.push(...page.list);
    if (!page.list.length || result.length >= total || page.list.length < pageSize) break;
  }
  return result;
}

function normalizeActivity(item, fallbackStatus) {
  const id = String(item.activityId || item.id || item.activityID || "").trim();
  if (!id) return null;
  const start = normalizeTimestamp(item.activityStartTime || item.startTime || item.beginTime || item.startAt);
  const end = normalizeTimestamp(item.activityEndTime || item.endTime || item.finishTime || item.endAt);
  const status = Number(item.activityStatus || item.status || fallbackStatus);
  return {
    id,
    title: String(item.activityName || item.title || item.name || `活动 ${id}`).trim(),
    activityTime: start && end ? `${formatDateTime(start)} - ${formatDateTime(end)}` : "",
    activityStartTime: start,
    activityEndTime: end,
    activityStatus: Number.isFinite(status) ? status : fallbackStatus,
    activityStatusText: statusMap[status] || "",
    registerStatus: item.registerStatus ?? null,
    pictureUrl: item.pictureUrl || item.activityPicUrl || item.imageUrl || "",
    discoveredAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    listUpdatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
  };
}

function mergeActivities(fetched) {
  const saved = readJson(savedActivitiesPath, {});
  fetched.forEach(activity => {
    const previous = saved[activity.id] || {};
    saved[activity.id] = {
      ...previous,
      ...activity,
      title: activity.title || previous.title || `活动 ${activity.id}`,
      activityTime: activity.activityTime || previous.activityTime || "",
      ruleImage: previous.ruleImage || "",
      updatedAt: previous.updatedAt || "",
      rewardCap: previous.rewardCap ?? null,
      tiers: Array.isArray(previous.tiers) ? previous.tiers : [],
      rows: Array.isArray(previous.rows) ? previous.rows : [],
      overrides: previous.overrides || {},
      recordSnapshot: previous.recordSnapshot ?? false,
      discoveredAt: previous.discoveredAt || activity.discoveredAt
    };
  });
  writeJson(savedActivitiesPath, saved);
  return saved;
}

function enableOngoingAutoRefresh(saved) {
  const fallback = {
    intervalMinutes: 30,
    primaryActivityId: 1199,
    activityIds: [],
    autoPush: true
  };
  const current = readJson(configPath, fallback);
  const ids = new Set(
    (Array.isArray(current.activityIds) ? current.activityIds : [])
      .map(id => Number(id))
      .filter(id => Number.isFinite(id) && id > 0)
  );
  let enabledCount = 0;
  Object.values(saved).forEach(activity => {
    if (Number(activity.activityStatus) !== 2) return;
    const id = Number(activity.id);
    if (!Number.isFinite(id) || id <= 0) return;
    if (!ids.has(id) || activity.recordSnapshot !== true) enabledCount += 1;
    ids.add(id);
    activity.recordSnapshot = true;
  });
  const next = {
    ...fallback,
    ...current,
    activityIds: [...ids].sort((a, b) => a - b)
  };
  writeJson(configPath, next);
  writeJson(savedActivitiesPath, saved);
  return enabledCount;
}

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`HTML 中没有找到 ${startMarker} 到 ${endMarker} 的数据块。`);
  return source.slice(0, start + startMarker.length) + replacement + source.slice(end);
}

function updateHtml(savedActivities) {
  let html = readFileSync(htmlPath, "utf8");
  html = replaceBetween(
    html,
    "    const SAVED_ACTIVITIES = ",
    ";\n\n    let activities",
    JSON.stringify(savedActivities)
  );
  writeFileSync(htmlPath, html);
}

async function main() {
  const headers = requestHeaders(loadEnv());
  const all = [];
  for (const status of [1, 2, 3]) {
    const list = await fetchAllByStatus(headers, status);
    all.push(...list.map(item => normalizeActivity(item, status)).filter(Boolean));
  }
  const byId = new Map();
  all.forEach(activity => byId.set(activity.id, { ...(byId.get(activity.id) || {}), ...activity }));
  const fetched = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const saved = mergeActivities(fetched);
  const autoEnabled = enableOngoingAutoRefresh(saved);
  const counts = fetched.reduce((acc, activity) => {
    if (activity.activityStatus === 1) acc.upcoming += 1;
    else if (activity.activityStatus === 2) acc.ongoing += 1;
    else acc.ended += 1;
    return acc;
  }, { upcoming: 0, ongoing: 0, ended: 0 });
  writeJson(activityListPath, {
    updatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    counts,
    activities: fetched
  });
  updateHtml(saved);
  console.log(`已同步活动列表：未开始 ${counts.upcoming} 个，进行中 ${counts.ongoing} 个，已结束 ${counts.ended} 个；已确保 ${counts.ongoing} 个进行中活动开启自动刷新，本次新增 ${autoEnabled} 个。`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
