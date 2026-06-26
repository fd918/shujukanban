import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.MEITUAN_REFRESH_PORT || 8765);
let running = false;

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function runRefresh(activityId, meta = {}) {
  return new Promise((resolvePromise, reject) => {
    if (running) {
      reject(new Error("已有刷新任务正在运行。"));
      return;
    }
    running = true;
    let output = "";
    const args = ["scripts/refresh-meituan-data.mjs"];
    if (activityId) args.push(String(activityId));
    const child = spawn("node", args, {
      cwd: root,
      shell: true,
      env: {
        ...process.env,
        MEITUAN_ACTIVITY_TITLE: meta.title || "",
        MEITUAN_ACTIVITY_TIME: meta.activityTime || "",
        MEITUAN_RULE_IMAGE: meta.ruleImage || "",
        MEITUAN_FALLBACK_ROWS_JSON: JSON.stringify(meta.rows || [])
      }
    });
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.on("error", error => {
      running = false;
      reject(new Error(`无法启动刷新脚本：${error.message}`));
    });
    child.on("exit", code => {
      running = false;
      if (code === 0) resolvePromise(output.trim());
      else reject(new Error(output.trim() || `刷新失败，退出码 ${code}`));
    });
  });
}

createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 200, { ok: true });
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method !== "POST" || url.pathname !== "/refresh") {
    send(res, 404, { ok: false, message: "只支持 POST /refresh" });
    return;
  }
  try {
    const body = await readBody(req);
    const activityId = url.searchParams.get("activityId");
    const message = await runRefresh(activityId, body);
    send(res, 200, { ok: true, message });
  } catch (error) {
    send(res, 500, { ok: false, message: error.message });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`本机刷新服务已启动：http://127.0.0.1:${port}/refresh`);
});
