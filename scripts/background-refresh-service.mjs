import { createHmac } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const envPath = resolve(root, ".env");
const configPath = resolve(root, "data/watch-config.json");
const overridesPath = resolve(root, "data/manual-overrides.json");
const savedActivitiesPath = resolve(root, "data/saved-activities.json");
const FEISHU_WEBHOOK_SERVICE = "com.tanwenjie.business-dashboard.feishu.webhook";
const FEISHU_SECRET_SERVICE = "com.tanwenjie.business-dashboard.feishu.secret";
const port = Number(process.env.MEITUAN_REFRESH_PORT || 8765);
const manualRefreshIntervalMs = 60 * 1000;
const refreshTimeoutMs = Number(process.env.MEITUAN_REFRESH_TIMEOUT_MS || 120000);
const meituanAuthAlertIntervalMs = 60 * 60 * 1000;
let refreshInFlight = null;
let autoRefreshRunning = false;
let autoRefreshRequested = false;
let manualQueueRunning = false;
let activityListSyncRunning = false;
const lastManualRefreshAtByActivity = new Map();
const manualRefreshQueue = [];
let refreshTimer = null;
let activityListSyncTimer = null;
let lastMeituanAuthAlertAt = 0;

function nowText() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function readConfig() {
  const fallback = {
    intervalMinutes: 30,
    primaryActivityId: 1199,
    activityIds: [1199],
    autoPush: false
  };
  if (!existsSync(configPath)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const ids = Array.isArray(parsed.activityIds) ? parsed.activityIds : [parsed.primaryActivityId].filter(Boolean);
    return {
      ...fallback,
      ...parsed,
      activityIds: [...new Set(ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0))]
    };
  } catch {
    return fallback;
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readEnv() {
  if (!existsSync(envPath)) return {};
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

function headersFilePath() {
  const env = readEnv();
  return resolve(root, env.MEITUAN_HEADERS_FILE || "meituan-request-headers.txt");
}

function mtgsigTimeFromHeaders(text) {
  const line = String(text || "").split(/\r?\n/).find(item => /^mtgsig:/i.test(item.trim()));
  if (!line) return "";
  try {
    const parsed = JSON.parse(line.slice(line.indexOf(":") + 1).trim());
    if (!parsed?.a2) return "";
    return new Date(Number(parsed.a2)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  } catch {
    return "";
  }
}

function headersStatus() {
  const path = headersFilePath();
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      updatedAt: "",
      mtgsigTime: "",
      hasCookie: false,
      hasMtgsig: false
    };
  }
  const text = readFileSync(path, "utf8");
  return {
    exists: true,
    path,
    updatedAt: statSync(path).mtime.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    mtgsigTime: mtgsigTimeFromHeaders(text),
    hasCookie: /\bCookie:/i.test(text),
    hasMtgsig: /^mtgsig:/im.test(text)
  };
}

async function readSecret(service) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-a", "default", "-s", service, "-w"]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function sendFeishuText(text) {
  const webhook = await readSecret(FEISHU_WEBHOOK_SERVICE);
  const secret = await readSecret(FEISHU_SECRET_SERVICE);
  if (!webhook) {
    console.error(`[${nowText()}] 美团接口失效提醒未发送：飞书 Webhook 未配置。`);
    return;
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    msg_type: "text",
    content: { text }
  };
  if (secret) {
    payload.timestamp = timestamp;
    payload.sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code && data.code !== 0)) {
    throw new Error(data.msg || data.message || "飞书消息发送失败");
  }
}

function isLikelyMeituanAuthError(error) {
  const message = String(error?.message || error || "");
  return /code\s*50103|Cookie|mtgsig|登录|鉴权|权限|未授权|系统异常|未知错误/i.test(message);
}

async function notifyMeituanAuthError(error, activityId = "") {
  if (!isLikelyMeituanAuthError(error)) return;
  const now = Date.now();
  if (now - lastMeituanAuthAlertAt < meituanAuthAlertIntervalMs) return;
  lastMeituanAuthAlertAt = now;
  const status = headersStatus();
  const lines = [
    "美团活动看板接口失效提醒",
    `时间：${nowText()}`,
    `活动：${activityId || "活动列表同步/后台刷新"}`,
    `现象：${String(error?.message || error).split("\n")[0]}`,
    "判断：美团请求头、Cookie 或 mtgsig 可能已过期。",
    "处理：打开本地看板 -> 设置 -> 美团接口请求标头，粘贴 F12 里 pcActivityData 的完整请求标头后保存。",
    `当前请求头保存时间：${status.updatedAt || "未找到"}`,
    `当前 mtgsig 时间：${status.mtgsigTime || "未识别"}`
  ];
  try {
    await sendFeishuText(lines.join("\n"));
    console.log(`[${nowText()}] 已发送美团接口失效飞书提醒。`);
  } catch (notifyError) {
    console.error(`[${nowText()}] 美团接口失效飞书提醒发送失败：${notifyError.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(resolve(root, "data"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rememberActivity(activityId, { primary = false } = {}) {
  const id = Number(activityId);
  if (!Number.isFinite(id) || id <= 0) return readConfig();
  const config = readConfig();
  const ids = [...new Set([...(config.activityIds || []), id])].sort((a, b) => a - b);
  const next = {
    ...config,
    activityIds: ids,
    primaryActivityId: primary ? id : (config.primaryActivityId || id)
  };
  writeJson(configPath, next);
  return next;
}

function saveActivity(activity = {}) {
  const id = String(activity.id || "").trim();
  if (!id) return readJson(savedActivitiesPath, {});
  const saved = readJson(savedActivitiesPath, {});
  const previous = saved[id] || {};
  const incomingTitle = String(activity.title || "").trim();
  const placeholderTitle = `活动 ${id}`;
  const title = incomingTitle && (incomingTitle !== placeholderTitle || !previous.title)
    ? incomingTitle
    : (previous.title || incomingTitle || placeholderTitle);
  saved[id] = {
    ...previous,
    id,
    title,
    activityTime: activity.activityTime || previous.activityTime || "",
    ruleImage: activity.ruleImage || previous.ruleImage || "",
    updatedAt: activity.updatedAt || previous.updatedAt || "",
    rewardCap: activity.rewardCap ?? previous.rewardCap ?? null,
    tiers: Array.isArray(activity.tiers) && activity.tiers.length ? activity.tiers : (previous.tiers || []),
    rows: Array.isArray(activity.rows) && activity.rows.length ? activity.rows : (previous.rows || []),
    overrides: previous.overrides || activity.overrides || {},
    recordSnapshot: activity.recordSnapshot ?? previous.recordSnapshot ?? false
  };
  writeJson(savedActivitiesPath, saved);
  return saved;
}

function normalizeConfigUpdate(update = {}) {
  const current = readConfig();
  const interval = Number(update.intervalMinutes);
  const next = {
    ...current
  };
  if (Number.isFinite(interval) && interval >= 1) next.intervalMinutes = Math.round(interval);
  if (typeof update.autoPush === "boolean") next.autoPush = update.autoPush;
  if (Array.isArray(update.activityIds)) {
    next.activityIds = [...new Set(update.activityIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
  }
  const primary = Number(update.primaryActivityId);
  if (Number.isFinite(primary) && primary > 0) next.primaryActivityId = primary;
  writeJson(configPath, next);
  return next;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const { timeoutMs = 0, ...spawnOptions } = options;
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      ...spawnOptions
    });
    let output = "";
    let settled = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`命令超时 ${Math.round(timeoutMs / 1000)} 秒，已跳过。`));
      }, timeoutMs);
    }
    child.stdout?.on("data", chunk => { output += chunk.toString(); });
    child.stderr?.on("data", chunk => { output += chunk.toString(); });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("exit", code => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) resolvePromise(output.trim());
      else reject(new Error(output.trim() || `${command} 退出码 ${code}`));
    });
  });
}

async function runRefreshExclusive(label, task) {
  while (refreshInFlight) {
    await refreshInFlight.catch(() => {});
  }
  const current = (async () => {
    console.log(`[${nowText()}] 开始刷新任务：${label}`);
    return task();
  })();
  const guard = current.catch(() => {}).finally(() => {
    if (refreshInFlight === guard) refreshInFlight = null;
  });
  refreshInFlight = guard;
  return current;
}

async function refreshActivity(activityId) {
  const output = await runCommand(process.execPath, ["scripts/refresh-meituan-data.mjs", String(activityId)], {
    timeoutMs: refreshTimeoutMs,
    env: {
      ...process.env,
      MEITUAN_RECORD_SNAPSHOT: "true"
    }
  });
  console.log(`[${nowText()}] ${output}`);
}

async function syncActivityList() {
  if (refreshInFlight || autoRefreshRunning || manualQueueRunning) {
    console.log(`[${nowText()}] 活动数据刷新正在运行，全量活动同步延后 5 分钟。`);
    if (activityListSyncTimer) clearTimeout(activityListSyncTimer);
    activityListSyncTimer = setTimeout(syncActivityList, 5 * 60 * 1000);
    return;
  }
  if (activityListSyncRunning) {
    console.log(`[${nowText()}] 活动列表同步仍在运行，跳过本轮。`);
    return;
  }
  activityListSyncRunning = true;
  try {
    const output = await runCommand(process.execPath, ["scripts/sync-meituan-activities.mjs"], {
      env: process.env
    });
    console.log(`[${nowText()}] ${output}`);
    if (readConfig().autoPush) await pushPublicFiles();
  } catch (error) {
    console.error(`[${nowText()}] 活动列表同步失败：${error.message}`);
    await notifyMeituanAuthError(error);
  } finally {
    activityListSyncRunning = false;
    scheduleNextActivityListSync();
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolvePromise => {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch {
        resolvePromise({});
      }
    });
  });
}

function enqueueManualRefresh(activityId, meta = {}) {
  return new Promise((resolvePromise, reject) => {
    manualRefreshQueue.push({ activityId, meta, resolvePromise, reject });
    processManualQueue();
  });
}

async function processManualQueue() {
  if (manualQueueRunning) return;
  manualQueueRunning = true;
  try {
    while (manualRefreshQueue.length) {
      if (autoRefreshRequested || autoRefreshRunning) break;
      const job = manualRefreshQueue.shift();
      try {
        const message = await runManualRefreshNow(job.activityId, job.meta);
        job.resolvePromise(message);
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    manualQueueRunning = false;
    if (manualRefreshQueue.length && !autoRefreshRequested && !autoRefreshRunning) {
      setTimeout(processManualQueue, 1000);
    }
  }
}

async function runManualRefresh(activityId, meta = {}) {
  return enqueueManualRefresh(activityId, meta);
}

async function runManualRefreshNow(activityId, meta = {}) {
  const now = Date.now();
  const id = String(activityId || "").trim();
  const previousRefreshAt = lastManualRefreshAtByActivity.get(id) || 0;
  const waitMs = manualRefreshIntervalMs - (now - previousRefreshAt);
  if (!meta.force && waitMs > 0) {
    throw new Error(`刷新太频繁，请 ${Math.ceil(waitMs / 1000)} 秒后再试。`);
  }
  lastManualRefreshAtByActivity.set(id, now);
  return runRefreshExclusive(`页面手动刷新 ${id}`, async () => {
    const env = {
      ...process.env,
      MEITUAN_ACTIVITY_TITLE: meta.title || "",
      MEITUAN_ACTIVITY_TIME: meta.activityTime || "",
      MEITUAN_RULE_IMAGE: meta.ruleImage || "",
      MEITUAN_FALLBACK_ROWS_JSON: JSON.stringify(meta.rows || []),
      MEITUAN_RECORD_SNAPSHOT: meta.recordSnapshot ? "true" : "false"
    };
    const args = ["scripts/refresh-meituan-data.mjs"];
    if (activityId) args.push(String(activityId));
    const output = await runCommand(process.execPath, args, { env, timeoutMs: refreshTimeoutMs });
    saveActivity({
      id: String(activityId),
      recordSnapshot: Boolean(meta.recordSnapshot)
    });
    if (meta.recordSnapshot) rememberActivity(activityId);
    console.log(`[${nowText()}] 页面手动刷新成功：${output}`);
    return output;
  });
}

function deleteActivity(activityId) {
  const id = String(activityId || "").trim();
  if (!id) throw new Error("缺少 activityId");
  const saved = readJson(savedActivitiesPath, {});
  if (!saved[id]) throw new Error(`没有找到活动 ${id}`);
  if (Object.keys(saved).length <= 1) throw new Error("至少需要保留一个活动。");

  delete saved[id];
  writeJson(savedActivitiesPath, saved);

  const overrides = readJson(overridesPath, {});
  delete overrides[id];
  writeJson(overridesPath, overrides);

  rmSync(resolve(root, "data", `hourly-snapshots-${id}.json`), { force: true });
  rmSync(resolve(root, "assets", `activity-rule-${id}.png`), { force: true });
  rmSync(resolve(root, `meituan-activity-${id}-latest.json`), { force: true });

  const config = readConfig();
  const remainingIds = Object.keys(saved).map(value => Number(value)).filter(value => Number.isFinite(value));
  let primaryActivityId = Number(config.primaryActivityId);
  if (primaryActivityId === Number(id)) {
    primaryActivityId = remainingIds.includes(1199) ? 1199 : remainingIds[0];
  }
  const nextConfig = normalizeConfigUpdate({
    activityIds: (config.activityIds || []).filter(value => Number(value) !== Number(id)),
    primaryActivityId
  });
  return { activities: saved, config: nextConfig };
}

function startRefreshServer() {
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/overrides") {
      const activityId = url.searchParams.get("activityId");
      if (req.method === "GET") {
        const saved = readJson(overridesPath, {});
        sendJson(res, 200, { ok: true, overrides: activityId ? (saved[activityId] || {}) : saved });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const id = String(body.activityId || activityId || "").trim();
        if (!id) {
          sendJson(res, 400, { ok: false, message: "缺少 activityId" });
          return;
        }
        const saved = readJson(overridesPath, {});
        saved[id] = body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
          ? body.overrides
          : {};
        writeJson(overridesPath, saved);
        sendJson(res, 200, { ok: true, overrides: saved[id] });
        return;
      }
      sendJson(res, 404, { ok: false, message: "只支持 GET/POST /overrides" });
      return;
    }

    if (url.pathname === "/activities") {
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, activities: readJson(savedActivitiesPath, {}) });
        return;
      }
      if (req.method === "DELETE") {
        try {
          const result = deleteActivity(url.searchParams.get("activityId"));
          scheduleNextRun();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 400, { ok: false, message: error.message });
        }
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const activities = saveActivity(body.activity || {});
        sendJson(res, 200, { ok: true, activities });
        return;
      }
      sendJson(res, 404, { ok: false, message: "只支持 GET/POST/DELETE /activities" });
      return;
    }

    if (url.pathname === "/config") {
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, config: readConfig() });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const config = normalizeConfigUpdate(body);
        scheduleNextRun();
        sendJson(res, 200, { ok: true, config });
        return;
      }
      sendJson(res, 404, { ok: false, message: "只支持 GET/POST /config" });
      return;
    }

    if (url.pathname === "/headers") {
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, headers: headersStatus() });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const rawHeaders = String(body.rawHeaders || "").trim();
        if (!rawHeaders) {
          sendJson(res, 400, { ok: false, message: "请先粘贴完整请求标头。" });
          return;
        }
        if (!/\bCookie:/i.test(rawHeaders)) {
          sendJson(res, 400, { ok: false, message: "请求标头里没有 Cookie，请复制完整请求标头。" });
          return;
        }
        if (!/^mtgsig:/im.test(rawHeaders)) {
          sendJson(res, 400, { ok: false, message: "请求标头里没有 mtgsig，请复制 pcActivityData 接口的完整请求标头。" });
          return;
        }
        writeFileSync(headersFilePath(), `${rawHeaders}\n`);
        sendJson(res, 200, { ok: true, headers: headersStatus() });
        return;
      }
      sendJson(res, 404, { ok: false, message: "只支持 GET/POST /headers" });
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/refresh") {
      sendJson(res, 404, { ok: false, message: "只支持 POST /refresh" });
      return;
    }
    try {
      const body = await readBody(req);
      const activityId = url.searchParams.get("activityId");
      const message = await runManualRefresh(activityId, body);
      sendJson(res, 200, { ok: true, message });
    } catch (error) {
      await notifyMeituanAuthError(error, url.searchParams.get("activityId"));
      sendJson(res, 500, { ok: false, message: error.message });
    }
  });

  server.on("error", error => {
    if (error.code === "EADDRINUSE") {
      console.error(`[${nowText()}] 本机刷新接口端口 ${port} 已被占用。页面刷新按钮可能由另一个服务处理。`);
      return;
    }
    console.error(`[${nowText()}] 本机刷新接口启动失败：${error.message}`);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[${nowText()}] 本机刷新接口已启动：http://127.0.0.1:${port}/refresh`);
  });
}

async function pushPublicFiles() {
  await runCommand("git", ["add", "index.html", "meituan-dashboard-preview.html", "README.md", ".gitignore", ".env.example", "scripts", "assets", "data"]);
  const status = await runCommand("git", ["status", "--short"]);
  if (!status) {
    console.log(`[${nowText()}] 没有需要推送的文件。`);
    return;
  }
  const message = `Update Meituan dashboard ${nowText()}`;
  await runCommand("git", ["commit", "-m", message]);
  await runCommand("git", ["push", "origin", "main"]);
  console.log(`[${nowText()}] 已推送到 GitHub。`);
}

async function runOnce() {
  if (autoRefreshRunning) {
    console.log(`[${nowText()}] 上一次刷新仍在运行，跳过本轮。`);
    return;
  }
  autoRefreshRequested = true;
  autoRefreshRunning = true;
  const config = readConfig();
  try {
    const primary = Number(config.primaryActivityId);
    const ids = [...config.activityIds];
    const ordered = ids.filter(id => Number(id) !== primary);
    if (ids.some(id => Number(id) === primary)) ordered.push(primary);
    if (!ordered.length) {
      console.log(`[${nowText()}] 没有开启自动刷新的活动，跳过本轮。`);
      return;
    }
    console.log(`[${nowText()}] 开始后台刷新：${ordered.join(", ")}`);
    for (const id of ordered) {
      try {
        await runRefreshExclusive(`后台自动刷新 ${id}`, () => refreshActivity(id));
      } catch (error) {
        console.error(`[${nowText()}] 已跳过活动 ${id}：${error.message}`);
        await notifyMeituanAuthError(error, id);
      }
    }
    if (config.autoPush) await pushPublicFiles();
  } catch (error) {
    console.error(`[${nowText()}] 后台刷新失败：${error.message}`);
  } finally {
    autoRefreshRunning = false;
    autoRefreshRequested = false;
    const next = new Date(Date.now() + readConfig().intervalMinutes * 60 * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    console.log(`[${nowText()}] 本轮结束。下次刷新：${next}`);
    scheduleNextRun();
    processManualQueue();
  }
}

function scheduleNextRun() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const interval = Math.max(1, readConfig().intervalMinutes);
  refreshTimer = setTimeout(runOnce, interval * 60 * 1000);
}

function nextActivityListSyncAt() {
  const now = new Date();
  const candidates = [8, 10, 12, 14, 16, 18, 20, 22].map(hour => {
    const date = new Date(now);
    date.setHours(hour, 0, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    return date;
  });
  return candidates.sort((a, b) => a - b)[0];
}

function scheduleNextActivityListSync() {
  if (activityListSyncTimer) clearTimeout(activityListSyncTimer);
  const next = nextActivityListSyncAt();
  activityListSyncTimer = setTimeout(syncActivityList, Math.max(1000, next.getTime() - Date.now()));
  console.log(`[${nowText()}] 下次全量活动同步：${next.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`);
}

const config = readConfig();
console.log(`[${nowText()}] 美团看板后台服务启动，每 ${config.intervalMinutes} 分钟刷新一次。`);
startRefreshServer();
runOnce().finally(() => syncActivityList());
