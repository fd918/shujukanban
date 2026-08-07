const http = require('node:http');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const config = require('./config');
const { client } = require('./larkClient');
const { readJson, writeJson, appendLog } = require('./store');
const { saveUserTokens } = require('./tokens');
const { saveUserBinding, sendText } = require('./feishuMessages');

function getRedirectUri() {
  return config.redirectUri;
}

function createAuthUrl(userKey, chatId) {
  const oauthState = readJson('oauth-state.json', {});
  const state = crypto.randomBytes(16).toString('hex');
  oauthState[state] = {
    userKey,
    chatId,
    createdAt: new Date().toISOString(),
  };
  writeJson('oauth-state.json', oauthState);

  const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
  authUrl.searchParams.set('app_id', config.appId);
  authUrl.searchParams.set('redirect_uri', getRedirectUri());
  authUrl.searchParams.set('scope', config.scopes.join(' '));
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

async function handleOauthCallback(req, res) {
  try {
    const url = new URL(req.url, getRedirectUri());
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const oauthState = readJson('oauth-state.json', {});
    const stateRecord = oauthState[state];
    if (!state || !stateRecord) {
      throw new Error('授权状态不存在或已过期，请回到飞书重新发送“授权我”。');
    }
    if (!code) {
      throw new Error('飞书回调中没有 code。');
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

    saveUserTokens(stateRecord.userKey, tokenRes.data || {});
    const mailboxId = tokenRes.data?.enterprise_email || tokenRes.data?.email;
    if (mailboxId) {
      saveUserBinding(stateRecord.userKey, {
        chatId: stateRecord.chatId,
        mailboxId,
        userAuthorized: true,
      });
    }
    delete oauthState[state];
    writeJson('oauth-state.json', oauthState);

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('授权成功，可以关闭这个页面并回到飞书。');
    await sendText(`授权成功：${mailboxId || '已保存用户授权'}\n后续你可以用自己的邮箱自动回复邮件。`, {
      receive_id: stateRecord.chatId,
      receive_id_type: 'chat_id',
    });
  } catch (error) {
    appendLog('oauth_callback_failed', { error: error.message });
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`授权失败：${error.message}`);
  }
}

function startOauthServer() {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/callback')) {
      handleOauthCallback(req, res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('飞书邮件助手 OAuth 服务运行中。');
  });
  server.listen(3456, '127.0.0.1', () => {
    console.log(`OAuth 回调服务已启动：${getRedirectUri()}`);
  });
  return server;
}

module.exports = {
  createAuthUrl,
  startOauthServer,
};
