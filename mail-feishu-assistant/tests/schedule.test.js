const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseScheduleWindows,
  scheduleWindowsText,
  isWithinSchedule,
  scheduledScanKey,
} = require('../src/schedule');

test('解析多个巡检时间段并合并相邻区间', () => {
  const windows = parseScheduleWindows('8点-12点，14-18\n20～22');

  assert.deepEqual(windows, [
    { start: 8, end: 12 },
    { start: 14, end: 18 },
    { start: 20, end: 22 },
  ]);
  assert.equal(scheduleWindowsText(windows), '08:00-12:00、14:00-18:00、20:00-22:00');
});

test('支持按单个整点配置巡检时间', () => {
  const windows = parseScheduleWindows('9,14,19,22');

  assert.deepEqual(windows, [
    { start: 9, end: 9 },
    { start: 14, end: 14 },
    { start: 19, end: 19 },
    { start: 22, end: 22 },
  ]);
});

test('拒绝无效巡检时间段', () => {
  assert.deepEqual(parseScheduleWindows('23-8'), []);
  assert.deepEqual(parseScheduleWindows('8-25'), []);
  assert.deepEqual(parseScheduleWindows('上午'), []);
});

test('判断当前时间是否落在巡检时间段内', () => {
  const windows = parseScheduleWindows('8-12,14-18');

  assert.equal(isWithinSchedule(windows, new Date('2026-08-05T09:00:00+08:00')), true);
  assert.equal(isWithinSchedule(windows, new Date('2026-08-05T13:00:00+08:00')), false);
});

test('同一用户同一小时生成相同去重键', () => {
  assert.equal(
    scheduledScanKey('user-a', new Date('2026-08-05T09:15:00+08:00')),
    scheduledScanKey('user-a', new Date('2026-08-05T09:59:00+08:00')),
  );
});
