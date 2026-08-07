const test = require('node:test');
const assert = require('node:assert/strict');
const { PLATFORM_FILES, buildStalePayload, parsePlatformRows } = require('../src/churnSync');

test('邮件流失看板只读取美团、淘宝和京东两个指定来源', () => {
  const files = [
    '美团订单-数据统计-2026080709.xlsx',
    '淘宝闪购订单-数据统计-2026080709.xlsx',
    '京东订单-万单-数据统计-2026080709.xlsx',
    '京东订单-四川云瞻（非密令业务）-数据统计-2026080709.xlsx',
  ];
  assert.deepEqual(PLATFORM_FILES.map((item) => item.name), ['美团外卖', '淘宝闪购', '京东万单', '京东四川云瞻']);
  assert.deepEqual(PLATFORM_FILES.map((item, index) => item.pattern.test(files[index])), [true, true, true, true]);
  assert.equal(PLATFORM_FILES.some((item) => item.pattern.test('京东订单-数据统计-2026080709.xlsx')), false);
});

test('当天邮件缺失时保留上一份平台数据并记录滞后原因', () => {
  const existing = {
    schemaVersion: 2,
    sourceMail: { mailDay: '2026-08-05' },
    platforms: [{ name: '美团外卖', users: [{ id: '1' }] }],
  };
  const payload = buildStalePayload(existing, '尚未收到今日邮件。', '2026-08-07', '2026-08-07T01:15:00.000Z');
  assert.equal(payload.platforms, existing.platforms);
  assert.deepEqual(payload.refreshStatus, {
    ok: false,
    checkedAt: '2026-08-07T01:15:00.000Z',
    checkedDay: '2026-08-07',
    expectedMailDay: '2026-08-07',
    dataMailDay: '2026-08-05',
    dataAgeDays: 2,
    reason: '尚未收到今日邮件。',
  });
});

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
  assert.equal(user.orders15.at(-1).value, 15);
  assert.equal(user.recentAverage, 12);
  assert.equal(user.previousAverage, 5);
  assert.equal(user.impactOrders, 7);
  assert.equal(user.changePct, 140);
  assert.equal(user.phone, '177****5306');
});
