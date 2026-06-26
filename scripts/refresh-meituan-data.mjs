import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const envPath = resolve(root, ".env");
const htmlPath = resolve(root, "meituan-dashboard-preview.html");

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

function buildRows(data, startDate, endDate) {
  const category = data?.data?.categoryRewardList?.[0];
  if (!category || !Array.isArray(category.dailyData)) {
    throw new Error("接口响应中没有 data.categoryRewardList[0].dailyData。");
  }

  const byDate = new Map();
  category.dailyData.forEach(item => {
    byDate.set(ymdFromSeconds(item.date), item);
  });

  const dates = startDate && endDate
    ? dateRange(startDate, endDate)
    : [...byDate.keys()].sort();

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
  return stages.map(stage => ({
    name: `档${stage.levelId}`,
    threshold: Number(((stage.finalConsumeOrdersAmount || stage.consumeOrdersAmount || 0) / 100).toFixed(2)),
    rate: Number(((stage.perOrderCommission || 0) / 10000).toFixed(4))
  })).filter(stage => stage.threshold > 0 && stage.rate > 0);
}

function jsString(value) {
  return JSON.stringify(value);
}

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`HTML 中没有找到 ${startMarker} 到 ${endMarker} 的数据块。`);
  return source.slice(0, start + startMarker.length) + replacement + source.slice(end);
}

async function main() {
  const env = loadEnv();
  ["MEITUAN_ACTIVITY_ID", "MEITUAN_COOKIE", "MEITUAN_MTGSIG"].forEach(key => assertEnv(env, key));

  const activityId = Number(env.MEITUAN_ACTIVITY_ID);
  const url = "https://media.meituan.com/ipc/pcActivityData?yodaReady=h5&csecplatform=4&csecversion=4.2.4";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Content-Type": "application/json",
      "Cookie": env.MEITUAN_COOKIE,
      "Origin": "https://media.meituan.com",
      "Referer": "https://media.meituan.com/pc/index.html",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "mtgsig": env.MEITUAN_MTGSIG
    },
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

  const rows = buildRows(json, env.MEITUAN_ACTIVITY_START, env.MEITUAN_ACTIVITY_END);
  const tiers = buildTiers(json);
  writeFileSync(resolve(root, `meituan-activity-${activityId}-latest.json`), JSON.stringify(json, null, 2));

  const title = env.MEITUAN_ACTIVITY_TITLE || `活动 ${activityId}`;
  let html = readFileSync(htmlPath, "utf8");
  html = html.replace(/<title>.*?<\/title>/, `<title>${title}看板</title>`);
  html = html.replace(/<h1>.*?<\/h1>/, `<h1>${title}看板</h1>`);
  html = html.replace(/活动 \d+ · 数据截至 .*?<\/div>/, `活动 ${activityId} · 数据截至 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</div>`);
  const activityBlock = {
    id: String(activityId),
    title,
    updatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    tiers: tiers.length ? tiers : [
      { name: "档一", threshold: 95378491, rate: 0.002 },
      { name: "档二", threshold: 104381246, rate: 0.004 },
      { name: "档三", threshold: 117885379, rate: 0.005 }
    ],
    rows,
    overrides: {}
  };
  html = replaceBetween(
    html,
    "    const DEFAULT_ACTIVITY = ",
    ";\n\n    let activities",
    `${jsString(activityBlock)}`
  );
  writeFileSync(htmlPath, html);

  const actualTotal = rows.reduce((sum, row) => sum + (row[4] || 0), 0);
  console.log(`已刷新活动 ${activityId}。接口日期 ${rows.filter(row => row[4] != null).length} 天，核销累计 ${actualTotal.toFixed(2)} 元。`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
