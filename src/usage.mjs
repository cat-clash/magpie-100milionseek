// src/usage.mjs — 读 x-quota-* 响应头，产出 magpie 的配额窗口。
import { QUOTA_HEADERS, QUOTA_WINDOW_MS, USAGE_TIMEOUT_MS } from "./config.mjs";
import { apiFetch, errorText, ApiError } from "./http.mjs";
import { apiKeyOf } from "./auth.mjs";
import { MODELS_PATH } from "./config.mjs";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readQuota(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  const limit = num(headers.get(QUOTA_HEADERS.limit));
  const used = num(headers.get(QUOTA_HEADERS.used));
  const remaining = num(headers.get(QUOTA_HEADERS.remaining));
  const resetRaw = headers.get(QUOTA_HEADERS.reset);
  if (limit == null && used == null && remaining == null) return null;
  let resetsAt = null;
  if (resetRaw) {
    const n = num(resetRaw);
    // 兼容秒级 epoch 与 ISO 字符串
    if (n != null) resetsAt = n < 1e12 ? n * 1000 : n;
    else {
      const t = Date.parse(resetRaw);
      if (Number.isFinite(t)) resetsAt = t;
    }
  }
  return { limit, used, remaining, resetsAt };
}

export function buildUsage(quota) {
  if (!quota) return { plan: "100 Million Seek", windows: [] };
  const limit = quota.limit ?? (quota.used != null && quota.remaining != null ? quota.used + quota.remaining : null);
  const used = quota.used ?? (limit != null && quota.remaining != null ? limit - quota.remaining : null);
  const resetsAt = quota.resetsAt ?? Date.now() + QUOTA_WINDOW_MS;
  const span = Math.max(0, resetsAt - Date.now()) || QUOTA_WINDOW_MS;
  return {
    plan: "100 Million Seek · 每日额度",
    windows: [
      {
        name: "每日 Token 额度（UTC）",
        used,
        limit,
        resetsAt,
        span: QUOTA_WINDOW_MS,
        unit: "token",
        display: used != null && limit != null ? `${used.toLocaleString()} / ${limit.toLocaleString()} tokens` : "",
      },
    ],
  };
}

export function usageError(error) {
  return { plan: "100 Million Seek", windows: [], error: errorText(error) };
}

/** magpie 的 usage hook：GET /v1/models 读响应头，TTL 缓存。 */
export function createUsage(getAuth, opts = {}) {
  const base = String(opts.base || "https://100milionseek.top/v1").replace(/\/+$/, "");
  const ttl = Math.max(10_000, Number(opts.ttlMs) || 30_000);
  let cache = { at: 0, value: null, keyFp: "" };

  return async function usage() {
    let auth;
    try {
      auth = await getAuth();
    } catch (e) {
      return usageError(e);
    }
    const key = apiKeyOf(auth);
    if (!key) return usageError("未登录");

    const now = Date.now();
    if (cache.value && now - cache.at < ttl && cache.keyFp === key) return cache.value;

    try {
      const res = await apiFetch(`${base}${MODELS_PATH}`, {
        method: "GET",
        timeoutMs: opts.timeoutMs || USAGE_TIMEOUT_MS,
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
        headers: { authorization: `Bearer ${key}` },
      });
      const quota = readQuota(res.headers) ?? readQuotaFromBody(res.data);
      const value = buildUsage(quota);
      cache = { at: now, value, keyFp: key };
      return value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        // 额度耗尽也算读到：remaining=0
        const value = buildUsage({ remaining: 0, used: 0, limit: 100_000_000, resetsAt: Date.now() + QUOTA_WINDOW_MS });
        cache = { at: now, value, keyFp: key };
        return value;
      }
      return usageError(e);
    }
  };
}

function readQuotaFromBody(data) {
  const q = data?.quota ?? data?.usage ?? data;
  if (!q || typeof q !== "object") return null;
  const limit = num(q.limit ?? q.total);
  const used = num(q.used);
  const remaining = num(q.remaining);
  if (limit == null && used == null && remaining == null) return null;
  return { limit, used, remaining, resetsAt: null };
}
