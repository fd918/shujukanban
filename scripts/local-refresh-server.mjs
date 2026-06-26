import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
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

function runRefresh() {
  return new Promise((resolvePromise, reject) => {
    if (running) {
      reject(new Error("已有刷新任务正在运行。"));
      return;
    }
    running = true;
    let output = "";
    const child = spawn(process.execPath, ["scripts/refresh-meituan-data.mjs"], {
      cwd: root
    });
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
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
  if (req.method !== "POST" || req.url !== "/refresh") {
    send(res, 404, { ok: false, message: "只支持 POST /refresh" });
    return;
  }
  try {
    const message = await runRefresh();
    send(res, 200, { ok: true, message });
  } catch (error) {
    send(res, 500, { ok: false, message: error.message });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`本机刷新服务已启动：http://127.0.0.1:${port}/refresh`);
});
