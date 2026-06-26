import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(root, "data/watch-config.json");
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
runOnce();
setInterval(runOnce, Math.max(1, config.intervalMinutes) * 60 * 1000);
