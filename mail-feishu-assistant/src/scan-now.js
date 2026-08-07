const { scanOnce } = require('./scanner');

scanOnce({ notify: true })
  .then((result) => {
    console.log(`巡检完成，接口读取 ${result.fetchedTotal} 封，今日邮件 ${result.checkedToday} 封，今日已处理 ${result.processedToday} 封，今日待处理 ${result.pendingToday} 封，新发现 ${result.candidates.length} 封待处理邮件。`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
