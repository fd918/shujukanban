import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envPath = resolve(root, ".env");
const htmlPath = resolve(root, "meituan-dashboard-preview.html");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ACTIVITY_META = {
  1199: {
    title: "美团联盟年框媒体激励2026年6月-云瞻",
    activityTime: "2026-06-06 00:00:00 - 2026-06-30 23:59:59",
    ruleImage: "./assets/activity-rule-1199.png",
    rewardCap: 600000,
    start: "2026-06-06",
    end: "2026-06-30"
  }
};

function loadEnv() {
  if (!existsSync(envPath)) {
    throw new Error("未找到 .env。请复制 .env.example 为 .env，并填写活动 ID、Cookie 和 mtgsig。");
  }
  const env = {};
  const raw = readFileSync(envPath, "utf8");
  raw.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index < 0) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    env[key] = value;
  });
  return env;
}

function assertEnv(env, key) {
  if (!env[key] || env[key].startsWith("请")) {
    throw new Error(`.env 缺少 ${key}。`);
  }
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
      throw new Error(`未找到请求标头文件：${env.MEITUAN_HEADERS_FILE}。请新建该文件并粘贴 F12 里的完整请求标头。`);
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
  ["MEITUAN_COOKIE", "MEITUAN_MTGSIG"].forEach(key => assertEnv(env, key));
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    "Cookie": env.MEITUAN_COOKIE,
    "Origin": "https://media.meituan.com",
    "Referer": "https://media.meituan.com/pc/index.html",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "mtgsig": env.MEITUAN_MTGSIG
  };
}

function ymdFromSeconds(seconds) {
  return new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function dateRange(start, end) {
  const result = [];
  const cursor = new Date(`${start}T00:00:00+08:00`);
  const endDate = new Date(`${end}T00:00:00+08:00`);
  while (cursor <= endDate) {
    result.push(cursor.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function centsToYuan(value) {
  return value == null ? null : Number((value / 100).toFixed(2));
}

function buildRows(data, startDate, endDate, fallbackRows = []) {
  const category = data?.data?.categoryRewardList?.[0];
  if (!category || !Array.isArray(category.dailyData)) {
    throw new Error("接口响应中没有 data.categoryRewardList[0].dailyData。");
  }

  const byDate = new Map();
  category.dailyData.forEach(item => {
    byDate.set(ymdFromSeconds(item.date), item);
  });

  const fallbackDates = fallbackRows.map(row => row[0]);
  const dates = startDate && endDate
    ? dateRange(startDate, endDate)
    : [...new Set([...fallbackDates, ...byDate.keys()])].sort();

  return dates.map(date => {
    const item = byDate.get(date);
    if (!item) return [date, null, null, null, null];
    return [
      date,
      item.validOrders ?? null,
      item.redemptionOrders ?? null,
      centsToYuan(item.actualPayment),
      centsToYuan(item.redemptionOrdersAmount)
    ];
  });
}

function buildTiers(data) {
  const stages = data?.data?.categoryRewardList?.[0]?.activityStages || [];
  return stages.map(stage => {
    const amountThreshold = Number(((stage.finalConsumeOrdersAmount || stage.consumeOrdersAmount || 0) / 100).toFixed(2));
    const orderThreshold = Number(stage.finalConsumeOrders || stage.consumeOrders || 0);
    const rate = Number(((stage.perOrderCommission || 0) / 10000).toFixed(4));
    const perOrderReward = Number(((stage.perOrderReward || 0) / 100).toFixed(2));
    const extraReward = Number(((stage.extraReward || 0) / 100).toFixed(2));

    if (amountThreshold > 0 && rate > 0) {
      return {
        name: `档${stage.levelId}`,
        metric: "amount",
        threshold: amountThreshold,
        rewardType: "rate",
        rate
      };
    }
    if (orderThreshold > 0 && perOrderReward > 0) {
      return {
        name: `档${stage.levelId}`,
        metric: "orders",
        threshold: orderThreshold,
        rewardType: "per_order",
        perOrderReward
      };
    }
    if ((amountThreshold > 0 || orderThreshold > 0) && extraReward > 0) {
      return {
        name: `档${stage.levelId}`,
        metric: amountThreshold > 0 ? "amount" : "orders",
        threshold: amountThreshold > 0 ? amountThreshold : orderThreshold,
        rewardType: "fixed",
        fixedReward: extraReward
      };
    }
    return null;
  }).filter(Boolean);
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
  }).formatToParts(new Date(seconds * 1000)).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function fetchJson(url, headers, activityId) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ activityId })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`接口请求失败：HTTP ${response.status}\n${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text);
  if (json.code !== 0) {
    throw new Error(`接口返回失败：${json.msg || "未知错误"}`);
  }
  return json;
}

function sanitizeRuleHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "");
}

async function buildRuleImage(headers, activityId) {
  if (!existsSync(chromePath)) return "";
  let rule = {};
  try {
    rule = await fetchJson(
      "https://media.meituan.com/ipc/pcActivityRule?yodaReady=h5&csecplatform=4&csecversion=4.2.4",
      headers,
      activityId
    );
  } catch {
    return "";
  }
  const activityDesc = sanitizeRuleHtml(rule.data?.activityDesc);
  if (!activityDesc) return "";

  const tempDir = mkdtempSync(resolve(tmpdir(), `meituan-rule-${activityId}-`));
  const htmlFile = resolve(tempDir, `activity-rule-${activityId}.html`);
  const imageFile = resolve(root, "assets", `activity-rule-${activityId}.png`);
  const height = Math.max(1600, Math.min(4200, 900 + Math.ceil(activityDesc.length / 2.6)));
  const ruleHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#f5f7fb;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;color:#202124;}
    .page{box-sizing:border-box;width:1600px;padding:28px 24px 34px;background:#f5f7fb;}
    .rule{font-size:18px;line-height:1.55;letter-spacing:0;background:#f5f7fb;}
    .rule p{margin:0 0 4px;}
    .rule table{border-collapse:collapse;margin:4px 0 6px;width:auto;}
    .rule td,.rule th{font-size:18px;line-height:1.45;padding:1px 16px 1px 0;vertical-align:top;font-weight:400;text-align:left;}
    .rule strong{font-weight:700;}
    .rule ul,.rule ol{margin:4px 0 4px 22px;padding:0;}
    .rule li{margin:0 0 2px;}
  </style></head><body><div class="page"><div class="rule">${activityDesc}</div></div></body></html>`;
  try {
    writeFileSync(htmlFile, ruleHtml);
    execFileSync(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--screenshot=${imageFile}`,
      `--window-size=1600,${height}`,
      pathToFileURL(htmlFile).href
    ], { stdio: "ignore" });
    return `./assets/activity-rule-${activityId}.png`;
  } catch {
    return "";
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function jsString(value) {
  return JSON.stringify(value);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeHourlySnapshot(activityId, title, rows, tiers, updatedAt) {
  const dataDir = resolve(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const hour = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false
  }).format(now);
  const dateHour = `${today} ${hour}:00`;
  const todayRow = rows.find(row => row[0] === today) || [];
  const metric = tiers.find(tier => tier.metric)?.metric || "amount";
  const actualRows = rows.filter(row => row[4] != null);
  const cumulativeRedemptionAmount = actualRows.reduce((sum, row) => sum + (row[4] || 0), 0);
  const cumulativeRedemptionOrders = actualRows.reduce((sum, row) => sum + (row[2] || 0), 0);
  const file = resolve(dataDir, `hourly-snapshots-${activityId}.json`);
  const snapshots = readJson(file, []);
  const snapshot = {
    activityId: String(activityId),
    title,
    metric,
    date: today,
    hour: Number(hour),
    dateHour,
    recordedAt: updatedAt,
    todayValidOrders: todayRow[1] ?? null,
    todayRedemptionOrders: todayRow[2] ?? null,
    todayActualPayment: todayRow[3] ?? null,
    todayRedemptionAmount: todayRow[4] ?? null,
    cumulativeRedemptionOrders,
    cumulativeRedemptionAmount
  };
  const next = snapshots.filter(item => item.dateHour !== dateHour);
  next.push(snapshot);
  next.sort((a, b) => String(a.dateHour).localeCompare(String(b.dateHour)));
  writeFileSync(file, JSON.stringify(next, null, 2));
}

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`HTML 中没有找到 ${startMarker} 到 ${endMarker} 的数据块。`);
  return source.slice(0, start + startMarker.length) + replacement + source.slice(end);
}

function existingDefaultActivity(html) {
  const startMarker = "    const DEFAULT_ACTIVITY = ";
  const endMarker = ";\n\n    let activities";
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) return {};
  try {
    return JSON.parse(html.slice(start + startMarker.length, end));
  } catch {
    return {};
  }
}

async function main() {
  const env = loadEnv();
  const activityId = Number(process.argv[2] || env.MEITUAN_ACTIVITY_ID);
  if (!Number.isFinite(activityId) || activityId <= 0) {
    throw new Error("缺少活动 ID。请使用：node scripts/refresh-meituan-data.mjs 1199");
  }
  const headers = requestHeaders(env);
  const dataUrl = "https://media.meituan.com/ipc/pcActivityData?yodaReady=h5&csecplatform=4&csecversion=4.2.4";
  const detailUrl = "https://media.meituan.com/ipc/pcActivityDetail?yodaReady=h5&csecplatform=4&csecversion=4.2.4";
  const json = await fetchJson(dataUrl, headers, activityId);
  let detail = {};
  try {
    detail = await fetchJson(detailUrl, headers, activityId);
  } catch {
    detail = {};
  }

  let html = readFileSync(htmlPath, "utf8");
  const existing = existingDefaultActivity(html);
  const sameActivity = String(existing.id || "") === String(activityId);
  const meta = ACTIVITY_META[activityId] || {};
  const detailData = detail.data || {};
  const detailStart = detailData.activityStartTime ? ymdFromSeconds(detailData.activityStartTime) : "";
  const detailEnd = detailData.activityEndTime ? ymdFromSeconds(detailData.activityEndTime) : "";
  const fallbackRows = process.env.MEITUAN_FALLBACK_ROWS_JSON
    ? JSON.parse(process.env.MEITUAN_FALLBACK_ROWS_JSON)
    : (sameActivity ? (existing.rows || []) : []);
  const rows = buildRows(json, env.MEITUAN_ACTIVITY_START || meta.start || detailStart, env.MEITUAN_ACTIVITY_END || meta.end || detailEnd, fallbackRows);
  const tiers = buildTiers(json);
  const generatedRuleImage = await buildRuleImage(headers, activityId);
  writeFileSync(resolve(root, `meituan-activity-${activityId}-latest.json`), JSON.stringify(json, null, 2));

  const detailActivityTime = detailData.activityStartTime && detailData.activityEndTime
    ? `${formatDateTime(detailData.activityStartTime)} - ${formatDateTime(detailData.activityEndTime)}`
    : "";
  const title = detailData.activityName || process.env.MEITUAN_ACTIVITY_TITLE || env.MEITUAN_ACTIVITY_TITLE || meta.title || (sameActivity ? existing.title : "") || `活动 ${activityId}`;
  const updatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  html = html.replace(/<title>.*?<\/title>/, `<title>${title}-看板</title>`);
  html = html.replace(/<h1>.*?<\/h1>/, `<h1>${title}-看板</h1>`);
  html = html.replace(/活动 \d+ · 数据截至 .*?<\/div>/, `活动 ${activityId} · 数据截至 ${updatedAt}</div>`);
  html = html.replace(/<div class="data-deadline" id="data-deadline">.*?<\/div>/, `<div class="data-deadline" id="data-deadline">数据截止时间：${updatedAt}</div>`);
  const activityBlock = {
    id: String(activityId),
    title,
    activityTime: detailActivityTime || process.env.MEITUAN_ACTIVITY_TIME || meta.activityTime || (sameActivity ? existing.activityTime : "") || "",
    ruleImage: generatedRuleImage || process.env.MEITUAN_RULE_IMAGE || meta.ruleImage || (sameActivity ? existing.ruleImage : "") || "",
    updatedAt,
    rewardCap: meta.rewardCap ?? (sameActivity ? existing.rewardCap : null) ?? null,
    tiers: tiers.length ? tiers : (sameActivity && Array.isArray(existing.tiers) ? existing.tiers : []),
    rows,
    overrides: sameActivity ? (existing.overrides || {}) : {}
  };
  html = replaceBetween(
    html,
    "    const DEFAULT_ACTIVITY = ",
    ";\n\n    let activities",
    `${jsString(activityBlock)}`
  );
  writeFileSync(htmlPath, html);
  writeHourlySnapshot(activityId, title, rows, activityBlock.tiers, updatedAt);

  const actualTotal = rows.reduce((sum, row) => sum + (row[4] || 0), 0);
  console.log(`已刷新活动 ${activityId}。接口日期 ${rows.filter(row => row[4] != null).length} 天，核销累计 ${actualTotal.toFixed(2)} 元。`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
