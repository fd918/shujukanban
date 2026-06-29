import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(root, "data/watch-config.json");
const overridesPath = resolve(root, "data/manual-overrides.json");
const savedActivitiesPath = resolve(root, "data/saved-activities.json");
const port = Number(process.env.MEITUAN_REFRESH_PORT || 8765);
const manualRefreshIntervalMs = 60 * 1000;
let running = false;
let activityListSyncRunning = false;
const lastManualRefreshAtByActivity = new Map();
let refreshTimer = null;
let activityListSyncTimer = null;

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
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      ...options
    });
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk.toString(); });
    child.stderr?.on("data", chunk => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolvePromise(output.trim());
      else reject(new Error(output.trim() || `${command} 退出码 ${code}`));
    });
  });
}

async function refreshActivity(activityId) {
  const output = await runCommand(process.execPath, ["scripts/refresh-meituan-data.mjs", String(activityId)], {
    env: {
      ...process.env,
      MEITUAN_RECORD_SNAPSHOT: "true"
    }
  });
  console.log(`[${nowText()}] ${output}`);
}

async function syncActivityList() {
  if (running) {
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

async function runManualRefresh(activityId, meta = {}) {
  if (running) throw new Error("已有刷新任务正在运行，请稍后再试。");
  const now = Date.now();
  const id = String(activityId || "").trim();
  const previousRefreshAt = lastManualRefreshAtByActivity.get(id) || 0;
  const waitMs = manualRefreshIntervalMs - (now - previousRefreshAt);
  if (waitMs > 0) {
    throw new Error(`刷新太频繁，请 ${Math.ceil(waitMs / 1000)} 秒后再试。`);
  }
  lastManualRefreshAtByActivity.set(id, now);
  running = true;
  try {
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
    const output = await runCommand(process.execPath, args, { env });
    saveActivity({
      id: String(activityId),
      recordSnapshot: Boolean(meta.recordSnapshot)
    });
    if (meta.recordSnapshot) rememberActivity(activityId);
    console.log(`[${nowText()}] 页面手动刷新成功：${output}`);
    return output;
  } finally {
    running = false;
  }
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
  if (running) {
    console.log(`[${nowText()}] 上一次刷新仍在运行，跳过本轮。`);
    return;
  }
  running = true;
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
    for (const id of ordered) await refreshActivity(id);
    if (config.autoPush) await pushPublicFiles();
  } catch (error) {
    console.error(`[${nowText()}] 后台刷新失败：${error.message}`);
  } finally {
    running = false;
    const next = new Date(Date.now() + readConfig().intervalMinutes * 60 * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    console.log(`[${nowText()}] 本轮结束。下次刷新：${next}`);
    scheduleNextRun();
  }
}

function scheduleNextRun() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const interval = Math.max(1, readConfig().intervalMinutes);
  refreshTimer = setTimeout(runOnce, interval * 60 * 1000);
}

function nextActivityListSyncAt() {
  const now = new Date();
  const candidates = [9, 21].map(hour => {
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
