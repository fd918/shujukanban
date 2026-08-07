const http = require('node:http');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const config = require('./config');
const { client } = require('./larkClient');
const { saveTokens } = require('./tokens');

const state = crypto.randomBytes(12).toString('hex');
const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
authUrl.searchParams.set('app_id', config.appId);
authUrl.searchParams.set('redirect_uri', config.redirectUri);
authUrl.searchParams.set('scope', config.scopes.join(' '));
authUrl.searchParams.set('state', state);

const callbackUrl = new URL(config.redirectUri);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, config.redirectUri);
    if (url.pathname !== callbackUrl.pathname) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (url.searchParams.get('state') !== state) {
      throw new Error('state 不匹配，授权请求可能不是当前程序发起的。');
    }
    const code = url.searchParams.get('code');
    if (!code) {
      throw new Error(`回调中没有 code：${url.search}`);
    }

    const tokenRes = await client.authen.accessToken.create({
      data: {
        grant_type: 'authorization_code',
        code,
      },
    });

    if (tokenRes.code !== 0) {
      throw new Error(`换取 user_access_token 失败：${tokenRes.code} ${tokenRes.msg}`);
    }

    saveTokens(tokenRes.data || {});
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('授权成功，可以回到终端停止 auth 命令。');
    console.log('授权成功，已保存 token。授权用户：', tokenRes.data?.enterprise_email || tokenRes.data?.email || tokenRes.data?.name);
    setTimeout(() => server.close(() => process.exit(0)), 500);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`授权失败：${error.message}`);
    console.error(error);
  }
});

server.listen(Number(callbackUrl.port || 80), callbackUrl.hostname, () => {
  console.log('请在浏览器打开下面的授权链接，并同意授权：');
  console.log(authUrl.toString());
  console.log(`本地回调监听中：${config.redirectUri}`);
});
