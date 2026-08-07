const cron = require('node-cron');
const { lark, baseConfig } = require('./larkClient');
const config = require('./config');
const { scanOnce } = require('./scanner');
const { handleMessageEvent, handleCardActionEvent } = require('./commands');
const { appendLog, readJson, writeJson } = require('./store');
const { listUserBindings, sendText, sendCard } = require('./feishuMessages');
const { startOauthServer } = require('./oauth');
const { buildScanSummaryCard } = require('./cards');
const { isWithinSchedule, scheduledScanKey } = require('./schedule');
const { syncMailChurn } = require('./churnSync');

function safeErrorMessage(error) {
  return error?.response?.data?.msg || error?.message || String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const message = safeErrorMessage(error);
  return /rate limit|频率|try again later/i.test(message);
}

async function scanWithRetry(options) {
  try {
    return await scanOnce(options);
  } catch (error) {
    if (!isRateLimitError(error)) throw error;
    await delay(60000);
    return scanOnce(options);
  }
}

function buildScanSummary(label, mailboxId, result) {
  return [
    `已完成一次${label}巡检。`,
    mailboxId ? `检查邮箱：${mailboxId}` : null,
    `本次接口读取：${result.fetchedTotal} 封`,
    `其中今日邮件：${result.checkedToday} 封`,
    `今日已处理：${result.processedToday} 封`,
    `今日待处理：${result.pendingToday} 封`,
    `新发现待处理：${result.candidates.length} 封`,
  ].filter(Boolean).join('\n');
}

async function runScan(label, selectedBindings = null) {
  console.log(`[${new Date().toLocaleString()}] 开始${label}巡检`);
  const shouldSendSummary = label === '定时';
  const bindings = selectedBindings || listUserBindings().filter((binding) => binding.mailboxId && binding.chatId);
  if (bindings.length === 0) {
    try {
      const result = await scanWithRetry({ notify: true });
      console.log(`巡检完成，接口读取 ${result.fetchedTotal} 封，今日邮件 ${result.checkedToday} 封，今日已处理 ${result.processedToday} 封，今日待处理 ${result.pendingToday} 封，新发现 ${result.candidates.length} 封待处理邮件。`);
      if (shouldSendSummary) {
        await sendCard(buildScanSummaryCard(label, '', result));
      }
    } catch (error) {
      const message = safeErrorMessage(error);
      console.error(`${label}巡检失败：${message}`);
      appendLog('scan_failed', { label, error: message });
      if (shouldSendSummary) {
        await sendText(`${label}巡检失败：${message}`);
      }
    }
    return;
  }

  for (const binding of bindings) {
    const target = { receive_id: binding.chatId, receive_id_type: 'chat_id' };
    try {
      const result = await scanWithRetry({
        notify: true,
        mailboxId: binding.mailboxId,
        ownerKey: binding.userKey,
        target,
      });
      console.log(`${binding.mailboxId} 巡检完成，接口读取 ${result.fetchedTotal} 封，今日邮件 ${result.checkedToday} 封，今日已处理 ${result.processedToday} 封，今日待处理 ${result.pendingToday} 封，新发现 ${result.candidates.length} 封待处理邮件。`);
      if (shouldSendSummary) {
        await sendCard(buildScanSummaryCard(label, binding.mailboxId, result), target);
      }
    } catch (error) {
      const message = safeErrorMessage(error);
      console.error(`${binding.mailboxId} ${label}巡检失败：${message}`);
      appendLog('scan_failed', { label, mailboxId: binding.mailboxId, error: message });
      if (shouldSendSummary) {
        await sendText(`${label}巡检失败。\n检查邮箱：${binding.mailboxId}\n错误信息：${message}`, target);
      }
    }
  }
}

async function runScheduledScan() {
  const now = new Date();
  if (now.getMinutes() !== 0) return;

  const state = readJson('state.json', {});
  state.lastScheduledScanByUser = state.lastScheduledScanByUser || {};
  const bindings = listUserBindings()
    .filter((binding) => binding.mailboxId && binding.chatId)
    .filter((binding) => isWithinSchedule(binding.scheduleWindows, now))
    .filter((binding) => {
      const key = scheduledScanKey(binding.userKey, now);
      return state.lastScheduledScanByUser[binding.userKey] !== key;
    });

  if (bindings.length === 0) return;

  for (const binding of bindings) {
    state.lastScheduledScanByUser[binding.userKey] = scheduledScanKey(binding.userKey, now);
  }
  writeJson('state.json', state);
  await runScan('定时', bindings);
}

const wsClient = new lark.WSClient({
  ...baseConfig,
  loggerLevel: lark.LoggerLevel.info,
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        await handleMessageEvent(data);
      } catch (error) {
        const message = safeErrorMessage(error);
        console.error(`处理飞书消息失败：${message}`);
        appendLog('message_handle_failed', { error: message });
      }
    },
    'card.action.trigger': async (data) => {
      try {
        await handleCardActionEvent(data);
      } catch (error) {
        const message = safeErrorMessage(error);
        console.error(`处理飞书卡片按钮失败：${message}`);
        appendLog('card_action_failed', { error: message });
      }
    },
  }),
});

startOauthServer();

cron.schedule('* * * * *', () => runScheduledScan(), {
  timezone: config.timezone,
});

cron.schedule(config.churnSyncCron, () => {
  syncMailChurn().then((result) => {
    console.log(result.cached ? '邮件流失数据无需更新。' : '邮件流失数据已自动更新。');
  }).catch((error) => {
    console.error(`邮件流失数据自动更新失败：${safeErrorMessage(error)}`);
    appendLog('mail_churn_sync_failed', { error: safeErrorMessage(error) });
  });
}, { timezone: config.timezone });

console.log('邮件审批助手已启动。');
console.log(`定时规则：每分钟检查，到用户配置时间段的整点巡检；默认 08:00-22:00，每小时一次；时区：${config.timezone}`);
console.log('在飞书里给机器人发送“绑定我”可设置通知目标；发送“巡检”可手动扫描。');

runScan('启动');
syncMailChurn({ force: true }).catch((error) => {
  console.error(`启动时同步邮件流失数据失败：${safeErrorMessage(error)}`);
  appendLog('mail_churn_sync_failed', { phase: 'startup', error: safeErrorMessage(error) });
});
