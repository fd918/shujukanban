const fs = require('node:fs');
const path = require('node:path');
const localtunnel = require('localtunnel');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const urlFile = path.join(dataDir, 'public-url.txt');
const preferredSubdomain = process.env.PUBLIC_TUNNEL_SUBDOMAIN || 'tanwenjie-mail-assistant';

async function start() {
  fs.mkdirSync(dataDir, { recursive: true });
  const tunnel = await localtunnel({
    port: 3456,
    local_host: '127.0.0.1',
    subdomain: preferredSubdomain,
  });

  fs.writeFileSync(urlFile, `${tunnel.url}\n`);
  console.log(`公网 HTTPS 地址：${tunnel.url}`);
  console.log(`飞书回调地址应配置为：${tunnel.url}/callback`);

  tunnel.on('close', () => {
    console.error('localtunnel 已关闭。');
    process.exit(1);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
