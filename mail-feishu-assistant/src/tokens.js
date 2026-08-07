const { client } = require('./larkClient');
const { readJson, writeJson } = require('./store');

function getSavedTokens() {
  return readJson('tokens.json', {});
}

function saveTokens(tokens) {
  const current = getSavedTokens();
  writeJson('tokens.json', { ...current, ...tokens, updated_at: new Date().toISOString() });
}

function getAllUserTokens() {
  return readJson('user-tokens.json', {});
}

function getUserTokens(userKey) {
  if (!userKey) return null;
  return getAllUserTokens()[userKey] || null;
}

async function getUserAuthStatus(userKey, { validate = false } = {}) {
  const tokens = getUserTokens(userKey);
  if (!tokens?.refresh_token) {
    return { authorized: false };
  }
  if (validate) {
    try {
      await getUserAccessToken(userKey);
    } catch (error) {
      return {
        authorized: false,
        error: error?.response?.data?.msg || error.message || String(error),
      };
    }
  }
  const currentTokens = getUserTokens(userKey) || tokens;
  return {
    authorized: true,
    mailboxId: currentTokens.enterprise_email || currentTokens.email || '',
    updatedAt: currentTokens.updated_at || '',
  };
}

function saveUserTokens(userKey, tokens) {
  const allTokens = getAllUserTokens();
  allTokens[userKey] = {
    ...allTokens[userKey],
    ...tokens,
    updated_at: new Date().toISOString(),
  };
  writeJson('user-tokens.json', allTokens);
}

async function getUserAccessToken(userKey) {
  const userTokens = getUserTokens(userKey);
  const tokens = userTokens || getSavedTokens();
  if (!tokens.refresh_token) {
    throw new Error('还没有飞书用户授权。请先发送“授权我”完成授权。');
  }

  const res = await client.authen.refreshAccessToken.create({
    data: {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    },
  });

  if (res.code !== 0) {
    throw new Error(`刷新 user_access_token 失败：${res.code} ${res.msg}`);
  }

  if (userKey && userTokens) {
    saveUserTokens(userKey, res.data || {});
  } else {
    saveTokens(res.data || {});
  }
  return res.data.access_token;
}

module.exports = {
  getSavedTokens,
  saveTokens,
  getUserTokens,
  getUserAuthStatus,
  saveUserTokens,
  getUserAccessToken,
};
