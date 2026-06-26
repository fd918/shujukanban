import { spawn } from "node:child_process";

const minutes = Number(process.argv[2] || 10);
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error("用法：node scripts/watch-refresh.mjs 10");
  process.exit(1);
}

function runOnce() {
  const child = spawn(process.execPath, ["scripts/refresh-meituan-data.mjs"], {
    stdio: "inherit"
  });
  child.on("exit", code => {
    const next = new Date(Date.now() + minutes * 60 * 1000).toLocaleString("zh-CN", { hour12: false });
    console.log(`刷新任务结束，退出码 ${code}。下次刷新：${next}`);
  });
}

runOnce();
setInterval(runOnce, minutes * 60 * 1000);
