import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(root, "data/watch-config.json");
const overridesPath = resolve(root, "data/manual-overrides.json");
const port = Number(process.env.MEITUAN_REFRESH_PORT || 8765);
let running = false;

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
  writeFileSync(path, JSON.stringify(value, null, 2));
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
    env: process.env
  });
  console.log(`[${nowText()}] ${output}`);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  running = true;
  try {
    const env = {
      ...process.env,
      MEITUAN_ACTIVITY_TITLE: meta.title || "",
      MEITUAN_ACTIVITY_TIME: meta.activityTime || "",
      MEITUAN_RULE_IMAGE: meta.ruleImage || "",
      MEITUAN_FALLBACK_ROWS_JSON: JSON.stringify(meta.rows || [])
    };
    const args = ["scripts/refresh-meituan-data.mjs"];
    if (activityId) args.push(String(activityId));
    const output = await runCommand(process.execPath, args, { env });
    if (meta.recordSnapshot) rememberActivity(activityId, { primary: true });
    console.log(`[${nowText()}] 页面手动刷新成功：${output}`);
    return output;
  } finally {
    running = false;
  }
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
    const ids = [...config.activityIds];
    if (config.primaryActivityId && !ids.includes(Number(config.primaryActivityId))) ids.push(Number(config.primaryActivityId));
    const ordered = ids.filter(id => id !== Number(config.primaryActivityId));
    if (config.primaryActivityId) ordered.push(Number(config.primaryActivityId));
    console.log(`[${nowText()}] 开始后台刷新：${ordered.join(", ")}`);
    for (const id of ordered) await refreshActivity(id);
    if (config.autoPush) await pushPublicFiles();
  } catch (error) {
    console.error(`[${nowText()}] 后台刷新失败：${error.message}`);
  } finally {
    running = false;
    const next = new Date(Date.now() + readConfig().intervalMinutes * 60 * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    console.log(`[${nowText()}] 本轮结束。下次刷新：${next}`);
  }
}

const config = readConfig();
console.log(`[${nowText()}] 美团看板后台服务启动，每 ${config.intervalMinutes} 分钟刷新一次。`);
startRefreshServer();
runOnce();
setInterval(runOnce, Math.max(1, config.intervalMinutes) * 60 * 1000);
