(function () {
  "use strict";

  const root = (() => {
    try {
      return window.top && window.top.location.origin === window.location.origin ? window.top : window;
    } catch {
      return window;
    }
  })();

  if (root.__YUNZHAN_BUSINESS_USER_DATA_HUB__) {
    window.BusinessUserDataHub = root.__YUNZHAN_BUSINESS_USER_DATA_HUB__;
    return;
  }

  const cache = new Map();
  const pending = new Map();
  const listeners = new Map();
  const DEFAULT_TTL_MS = 120000;
  const DEFAULT_TIMEOUT_MS = 20000;

  function normalizedKey(rawUrl) {
    const url = new URL(rawUrl, window.location.href);
    url.searchParams.delete("_");
    if (url.searchParams.get("refresh") === "0") url.searchParams.delete("refresh");
    const entries = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    url.search = new URLSearchParams(entries).toString();
    return `${url.origin}${url.pathname}${url.search ? `?${url.search}` : ""}`;
  }

  function emit(type, detail) {
    (listeners.get(type) || new Set()).forEach(listener => {
      try { listener(detail); } catch (error) { console.error(error); }
    });
  }

  async function requestJson(rawUrl, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const key = normalizedKey(rawUrl);
    const url = new URL(rawUrl, window.location.href);
    const force = method !== "GET" || options.force === true || url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
    const ttlMs = Number(options.ttlMs ?? DEFAULT_TTL_MS);
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const staleWhileRevalidate = options.staleWhileRevalidate === true;
    const saved = cache.get(key);
    if (!force && saved && Date.now() - saved.savedAt < ttlMs) return saved.data;
    if (!force && pending.has(key)) return pending.get(key);

    const fetchOptions = { ...options };
    delete fetchOptions.force;
    delete fetchOptions.ttlMs;
    delete fetchOptions.timeoutMs;
    delete fetchOptions.staleWhileRevalidate;
    // A shared request must not be cancelled by one iframe changing selection.
    if (method === "GET") {
      delete fetchOptions.signal;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
        fetchOptions.signal = AbortSignal.timeout(timeoutMs);
      }
    }
    const request = fetch(rawUrl, fetchOptions).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `接口请求失败：HTTP ${response.status}`);
      if (method === "GET") cache.set(key, { savedAt: Date.now(), data });
      emit("data", { key, data });
      return data;
    }).catch(error => {
      if (!force && saved?.data) {
        emit("stale", { key, data: saved.data, error });
        return saved.data;
      }
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error("共享用户数据读取超时，请稍后重试；已保存的数据不会被清空");
      }
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    if (!force && saved?.data && staleWhileRevalidate) {
      request.catch(() => {});
      return saved.data;
    }
    return request;
  }

  function subscribe(type, listener) {
    const set = listeners.get(type) || new Set();
    set.add(listener);
    listeners.set(type, set);
    return () => set.delete(listener);
  }

  function publish(type, detail) {
    emit(type, detail);
  }

  function invalidate(rawUrl = "") {
    if (!rawUrl) return cache.clear();
    const key = normalizedKey(rawUrl);
    cache.delete(key);
  }

  function dataTimeValue(value) {
    return Date.parse(String(value || "").replace(/\//g, "-")) || 0;
  }

  function mergeHistoricalDays(base = {}, incoming = {}) {
    const merged = { ...base };
    Object.entries(incoming || {}).forEach(([date, value]) => {
      if (Number(value || 0) === 0 && Number(merged[date] || 0) > 0) return;
      merged[date] = value;
    });
    return merged;
  }

  function mergeHistory(base = {}, incoming = {}) {
    const dates = [...new Set([...(base.dates || []), ...(incoming.dates || [])])].sort();
    const rowsById = new Map((base.rows || []).map(row => [String(row.id || row.userId || ""), { ...row, days: { ...(row.days || {}) } }]));
    (incoming.rows || []).forEach(row => {
      const id = String(row.id || row.userId || "");
      if (!id) return;
      const current = rowsById.get(id) || {};
      rowsById.set(id, { ...current, ...row, days: mergeHistoricalDays(current.days, row.days) });
    });
    const latestDataTime = [incoming.latestDataTime, base.latestDataTime]
      .filter(Boolean)
      .sort((a, b) => dataTimeValue(a) - dataTimeValue(b))
      .at(-1) || "-";
    return {
      ...base,
      ...incoming,
      dates,
      rows: [...rowsById.values()],
      total: Math.max(Number(base.total || 0), Number(incoming.total || 0), rowsById.size),
      latestDataTime
    };
  }

  function focusDataRangeKey(data = {}) {
    const range = data.range || {};
    return `${range.preset || ""}:${range.startDate || ""}:${range.endDate || ""}`;
  }

  function focusDataQuality(data = {}) {
    const rows = data.businessRows || data.rows || [];
    let positiveCells = 0;
    let historySum = 0;
    rows.forEach(row => {
      const days = row.metrics?.orders?.days || row.days || {};
      Object.values(days).forEach(value => {
        const amount = Number(value || 0);
        if (amount > 0) positiveCells += 1;
        historySum += amount;
      });
    });
    return { users: (data.users || []).length, relations: rows.length, positiveCells, historySum };
  }

  function focusDataRegressed(current, incoming) {
    if (!current || !incoming || focusDataRangeKey(current) !== focusDataRangeKey(incoming)) return false;
    const oldQuality = focusDataQuality(current);
    const nextQuality = focusDataQuality(incoming);
    if (oldQuality.relations > 0 && nextQuality.relations === 0) return true;
    if (oldQuality.users >= 4 && nextQuality.users < oldQuality.users * 0.5) return true;
    if (oldQuality.positiveCells >= 8 && nextQuality.positiveCells < oldQuality.positiveCells * 0.3) return true;
    return oldQuality.historySum > 100 && nextQuality.historySum < oldQuality.historySum * 0.15;
  }

  function synchronizedUsers(data = {}, today = "") {
    const reportingMode = data.reportingMode || "realtime";
    const sameTimeUsers = data.sameTimeUsers || {};
    const historyRows = (data.history?.rows || []).map(user => ({
      ...user,
      sameTime: user.sameTime || sameTimeUsers[String(user.id || user.userId || "")] || undefined
    }));
    const historyById = new Map(historyRows.map(user => [String(user.id || user.userId || ""), user]));
    const synchronizedById = new Map();
    (data.users || []).forEach(user => {
      const id = String(user.id || user.userId || "");
      synchronizedById.set(id, { ...user, sameTime: user.sameTime || sameTimeUsers[id] || undefined });
    });
    historyRows.forEach(user => {
      const id = String(user.id || user.userId || "");
      if (id && !synchronizedById.has(id)) synchronizedById.set(id, user);
    });
    return [...synchronizedById.values()].map(user => {
      const historyUser = historyById.get(String(user.id || user.userId || ""));
      const realtimeToday = Boolean(user.realtimeToday);
      if (reportingMode === "t1") return {
        ...(historyUser || {}),
        ...user,
        days: mergeHistoricalDays(historyUser?.days, user.days),
        todayOrders: Number(user.todayOrders || 0),
        realtimeToday: true,
        _hasHistory: Boolean(historyUser)
      };
      if (!historyUser) return { ...user, _hasHistory: false };
      return {
        ...historyUser,
        ...user,
        // 当前用户接口本身也会携带已发生日期。它可能比 history 对象更新，
        // 但异常分页也可能返回 0；统一按“非零优先”合并，避免二次渲染归零。
        days: mergeHistoricalDays(
          mergeHistoricalDays(historyUser.days, user.days),
          realtimeToday && today ? { [today]: Number(user.todayOrders || 0) } : {}
        ),
        todayOrders: realtimeToday ? Number(user.todayOrders || 0) : Number(historyUser.days?.[today] || 0),
        realtimeToday,
        _hasHistory: true
      };
    });
  }

  async function copyText(value) {
    const text = String(value || "");
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("复制失败");
    }
    return true;
  }

  const hub = { requestJson, subscribe, publish, invalidate, normalizedKey, mergeHistoricalDays, mergeHistory, focusDataRegressed, synchronizedUsers, copyText };
  root.__YUNZHAN_BUSINESS_USER_DATA_HUB__ = hub;
  window.BusinessUserDataHub = hub;
})();
