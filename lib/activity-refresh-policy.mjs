export const AUTO_REFRESH_END_GRACE_MS = 24 * 60 * 60 * 1000;

export function activityEndTimeMs(activity = {}) {
  const numericEnd = Number(activity.activityEndTime);
  if (Number.isFinite(numericEnd) && numericEnd > 0) {
    return numericEnd >= 1_000_000_000_000 ? numericEnd : numericEnd * 1000;
  }

  const dateTimes = String(activity.activityTime || "")
    .match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g);
  const endText = dateTimes?.at(-1);
  if (!endText) return 0;
  const parsed = Date.parse(`${endText.replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isActivityAutoRefreshExpired(activity = {}, nowMs = Date.now()) {
  const endTimeMs = activityEndTimeMs(activity);
  return endTimeMs > 0 && nowMs >= endTimeMs + AUTO_REFRESH_END_GRACE_MS;
}

export function disableExpiredActivityRefresh(config = {}, activities = {}, nowMs = Date.now()) {
  const currentIds = [...new Set(
    (Array.isArray(config.activityIds) ? config.activityIds : [])
      .map(id => Number(id))
      .filter(id => Number.isFinite(id) && id > 0)
  )];
  const nextActivities = { ...activities };
  const disabledIds = [];
  let activitiesChanged = false;

  Object.entries(activities).forEach(([key, activity]) => {
    if (!activity || !isActivityAutoRefreshExpired(activity, nowMs)) return;
    const id = Number(activity.id ?? key);
    if (Number.isFinite(id) && currentIds.includes(id)) disabledIds.push(id);
    if (activity.recordSnapshot === true) {
      nextActivities[key] = { ...activity, recordSnapshot: false };
      activitiesChanged = true;
    }
  });

  const disabledSet = new Set(disabledIds);
  const nextIds = currentIds.filter(id => !disabledSet.has(id));
  const configChanged = nextIds.length !== currentIds.length;
  return {
    config: configChanged ? { ...config, activityIds: nextIds } : config,
    activities: nextActivities,
    disabledIds,
    changed: configChanged || activitiesChanged
  };
}
