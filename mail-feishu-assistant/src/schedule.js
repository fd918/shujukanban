const DEFAULT_WINDOWS = [{ start: 8, end: 22 }];

function normalizeHour(value) {
  const hour = Number.parseInt(String(value), 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return hour;
}

function normalizeScheduleWindows(windows) {
  const normalized = (windows || [])
    .map((item) => ({
      start: normalizeHour(item.start),
      end: normalizeHour(item.end),
    }))
    .filter((item) => item.start !== null && item.end !== null && item.start <= item.end)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const item of normalized) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end + 1) {
      last.end = Math.max(last.end, item.end);
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

function parseScheduleWindows(raw) {
  const text = String(raw || '')
    .replace(/[：:]/g, ' ')
    .replace(/点钟/g, '点')
    .replace(/时/g, '点')
    .replace(/[—－~～至到]/g, '-')
    .replace(/[，、；;\n]+/g, ',')
    .trim();
  if (!text) return [];

  const windows = [];
  for (const part of text.split(',').map((item) => item.trim()).filter(Boolean)) {
    const cleaned = part.replace(/点/g, '').trim();
    const rangeMatch = cleaned.match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
    if (!rangeMatch) return [];
    const start = normalizeHour(rangeMatch[1]);
    const end = normalizeHour(rangeMatch[2] || rangeMatch[1]);
    if (start === null || end === null || start > end) return [];
    windows.push({ start, end });
  }
  return normalizeScheduleWindows(windows);
}

function scheduleWindowsForBinding(binding) {
  const custom = normalizeScheduleWindows(binding?.scheduleWindows);
  return custom.length ? custom : DEFAULT_WINDOWS;
}

function scheduleWindowsText(windows) {
  const normalized = normalizeScheduleWindows(windows);
  const target = normalized.length ? normalized : DEFAULT_WINDOWS;
  return target.map((item) => `${String(item.start).padStart(2, '0')}:00-${String(item.end).padStart(2, '0')}:00`).join('、');
}

function isWithinSchedule(windows, date = new Date()) {
  const target = scheduleWindowsForBinding({ scheduleWindows: windows });
  const hour = date.getHours();
  return target.some((item) => hour >= item.start && hour <= item.end);
}

function scheduledScanKey(userKey, date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${userKey}:${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}`;
}

module.exports = {
  DEFAULT_WINDOWS,
  normalizeScheduleWindows,
  parseScheduleWindows,
  scheduleWindowsForBinding,
  scheduleWindowsText,
  isWithinSchedule,
  scheduledScanKey,
};
