const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlatformRows } = require('../src/churnSync');

test('邮件平台联盟解析自动排除邮件当天并计算两个完整7日', () => {
  const dates = Array.from({ length: 16 }, (_, index) => {
    const day = new Date('2026-07-23T00:00:00Z');
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
  const rows = [
    ['用户ID', 'accounts_id', '当前版本', '套餐时间', '试用时间', '手机号', '注册时间', '姓名', '公司名称', '实名类型', '实名信息', '是否授权美团', ...dates, '合计'],
    [null, '合计', null, null, null, null, null, null, null, null, null, null, ...dates.map((_, index) => index + 1), 136],
    [74071935, 69777, '旗舰版', null, null, '17756985306', new Date('2025-07-16T00:00:00Z'), '朱岳坤', '测试公司', '公司', '审核成功', '已授权', ...dates.map((_, index) => index === 15 ? 999 : index + 1), 1120],
  ];
  const platform = parsePlatformRows(rows, { key: 'meituan', name: '美团外卖' }, '美团订单-数据统计-2026080709.xlsx', '2026-08-07');
  const user = platform.users[0];

  assert.equal(platform.completeThrough, '2026-08-06');
  assert.equal(platform.completeDates.length, 15);
  assert.equal(user.orders30.at(-1).value, 15);
  assert.equal(user.recentAverage, 12);
  assert.equal(user.previousAverage, 5);
  assert.equal(user.impactOrders, 7);
  assert.equal(user.changePct, 140);
  assert.equal(user.phone, '177****5306');
});
