const { client } = require('./larkClient');
const config = require('./config');
const { readJson, writeJson } = require('./store');

function getNotifyTarget() {
  const state = readJson('state.json', {});
  if (state.notifyTarget?.receive_id) {
    return state.notifyTarget;
  }
  if (config.notifyReceiveId) {
    return {
      receive_id: config.notifyReceiveId,
      receive_id_type: config.notifyReceiveIdType,
    };
  }
  return null;
}

function saveNotifyTarget(receiveId, receiveIdType = 'chat_id') {
  const state = readJson('state.json', {});
  state.notifyTarget = {
    receive_id: receiveId,
    receive_id_type: receiveIdType,
    updated_at: new Date().toISOString(),
  };
  writeJson('state.json', state);
}

function saveUserBinding(userKey, binding) {
  const state = readJson('state.json', {});
  state.userBindings = state.userBindings || {};
  state.userBindings[userKey] = {
    ...state.userBindings[userKey],
    ...binding,
    updated_at: new Date().toISOString(),
  };
  writeJson('state.json', state);
}

function getUserBinding(userKey) {
  const state = readJson('state.json', {});
  return state.userBindings?.[userKey] || null;
}

function listUserBindings() {
  const state = readJson('state.json', {});
  return Object.entries(state.userBindings || {}).map(([userKey, binding]) => ({ userKey, ...binding }));
}

async function sendText(text, target = getNotifyTarget()) {
  if (!target?.receive_id) {
    console.log('未配置飞书通知目标，跳过发送：');
    console.log(text);
    return null;
  }

  const res = await client.im.message.create({
    params: {
      receive_id_type: target.receive_id_type || 'chat_id',
    },
    data: {
      receive_id: target.receive_id,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });

  if (res.code !== 0) {
    throw new Error(`发送飞书消息失败：${res.code} ${res.msg}`);
  }
  return res.data;
}

async function sendCard(card, target = getNotifyTarget()) {
  if (!target?.receive_id) {
    console.log('未配置飞书通知目标，跳过发送卡片：');
    console.log(JSON.stringify(card, null, 2));
    return null;
  }

  const res = await client.im.message.create({
    params: {
      receive_id_type: target.receive_id_type || 'chat_id',
    },
    data: {
      receive_id: target.receive_id,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });

  if (res.code !== 0) {
    throw new Error(`发送飞书卡片失败：${res.code} ${res.msg}`);
  }
  return res.data;
}

async function updateCard(messageId, card) {
  if (!messageId) return null;
  const res = await client.im.v1.message.patch({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify(card),
    },
  });

  if (res.code !== 0) {
    throw new Error(`更新飞书卡片失败：${res.code} ${res.msg}`);
  }
  return res.data;
}

module.exports = {
  getNotifyTarget,
  saveNotifyTarget,
  saveUserBinding,
  getUserBinding,
  listUserBindings,
  sendText,
  sendCard,
  updateCard,
};
