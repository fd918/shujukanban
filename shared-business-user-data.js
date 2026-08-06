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
    const saved = cache.get(key);
    if (!force && saved && Date.now() - saved.savedAt < ttlMs) return saved.data;
    if (!force && pending.has(key)) return pending.get(key);

    const fetchOptions = { ...options };
    delete fetchOptions.force;
    delete fetchOptions.ttlMs;
    // A shared request must not be cancelled by one iframe changing selection.
    if (method === "GET") delete fetchOptions.signal;
    const request = fetch(rawUrl, fetchOptions).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `接口请求失败：HTTP ${response.status}`);
      if (method === "GET") cache.set(key, { savedAt: Date.now(), data });
      emit("data", { key, data });
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
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

  const hub = { requestJson, subscribe, publish, invalidate, normalizedKey };
  root.__YUNZHAN_BUSINESS_USER_DATA_HUB__ = hub;
  window.BusinessUserDataHub = hub;
})();
