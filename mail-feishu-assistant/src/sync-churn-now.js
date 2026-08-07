const { syncMailChurn } = require('./churnSync');

syncMailChurn({ force: process.argv.includes('--force') })
  .then((result) => {
    const payload = result.payload || {};
    const summary = (payload.platforms || []).map((item) => `${item.name} ${item.userCount}人`).join('，');
    console.log(`${result.cached ? '已是最新邮件' : '邮件流失数据已更新'}：${payload.sourceMail?.subject || '-'}；${summary}`);
    if ((result.syncResults || []).some((item) => !item.ok)) process.exitCode = 2;
  })
  .catch((error) => {
    console.error(`邮件流失数据同步失败：${error.message}`);
    process.exitCode = 1;
  });
