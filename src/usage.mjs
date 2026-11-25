// src/usage.mjs — 读 x-quota-* 响应头，产出 magpie 的配额窗口。
// 缓存是进程级单例：同一账号在多个 provider 实例 / 多次 hook 调用之间共享，
// 并发调用走 singleflight，上游失败时退回上次成功的旧值（stale-while-error），
// 避免把「暂时取不到额度」这种可容忍状态升级成 Magpie UI 的超时错误。
import { QUOTA_HEADERS, QUOTA_WINDOW_MS, USAGE_TIMEOUT_MS, USAGE_STALE_MS, MODELS_PATH } from "./config.mjs";
import { apiFetch, errorText, ApiError } from "./http.mjs";
import { apiKeyOf } from "./auth.mjs";
import { keyFingerprint } from "./cache-key.mjs";
import { createTtlCache, singleflight } from "./cache.mjs";

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

// ---- 进程内共享缓存 ---------------------------------------------------------
// 存 24h，实际新鲜度由调用方的 ttlMs 判定；stale 窗口用于失败兜底。
const usageStore = createTtlCache({ ttlMs: 24 * 60 * 60_000, staleMs: USAGE_STALE_MS });
const usageInflight = new Map();

export const usageStats = { hit: 0, miss: 0, upstream: 0, coalesced: 0, stale: 0, error: 0 };

export function resetUsageCache() {
  usageStore.clear();
  usageInflight.clear();
  for (const k of Object.keys(usageStats)) usageStats[k] = 0;
}

/** 从响应头 / 响应体读配额的共用逻辑。 */
function quotaOf(res) {
  return readQuota(res?.headers) ?? readQuotaFromBody(res?.data);
}

/**
 * magpie 的 usage hook 工厂。
 * @param {() => any} getAuth
 * @param {{base?:string,ttlMs?:number,staleMs?:number,timeoutMs?:number,signal?:AbortSignal,fetchImpl?:Function,dispatcher?:object,now?:()=>number}} [opts]
 */
export function createUsage(getAuth, opts = {}) {
  const base = String(opts.base || "https://100milionseek.top/v1").replace(/\/+$/, "");
  const ttl = Math.max(1_000, Number(opts.ttlMs) || 30_000);
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || USAGE_TIMEOUT_MS);
  const now = opts.now || Date.now;

  return async function usage() {
    let auth;
    try {
      auth = await getAuth();
    } catch (e) {
      return usageError(e);
    }
    const key = apiKeyOf(auth);
    if (!key) return usageError("未登录");

    const cacheKey = `${base}|${keyFingerprint(key)}`;
    const fresh = usageStore.peek(cacheKey);
    if (fresh && fresh.age < ttl) {
      usageStats.hit += 1;
      return fresh.value;
    }

    const pending = usageInflight.has(cacheKey);
    try {
      return await singleflight(usageInflight, cacheKey, async () => {
        if (pending) usageStats.coalesced += 1;
        // 排队期间别人可能已经刷好了
        const again = usageStore.peek(cacheKey);
        if (again && again.age < ttl) {
          usageStats.hit += 1;
          return again.value;
        }
        usageStats.miss += 1;
        try {
          const res = await apiFetch(`${base}${MODELS_PATH}`, {
            method: "GET",
            timeoutMs,
            signal: opts.signal,
            fetchImpl: opts.fetchImpl,
            dispatcher: opts.dispatcher,
            proxy: opts.proxy,
            headers: { authorization: `Bearer ${key}` },
          });
          const value = buildUsage(quotaOf(res));
          usageStore.set(cacheKey, value);
          usageStats.upstream += 1;
          return value;
        } catch (e) {
          if (e instanceof ApiError && e.status === 429) {
            // 额度耗尽也算读到：remaining=0
            const value = buildUsage({
              remaining: 0,
              used: 0,
              limit: 100_000_000,
              resetsAt: now() + QUOTA_WINDOW_MS,
            });
            usageStore.set(cacheKey, value);
            usageStats.upstream += 1;
            return value;
          }
          // 上游抖动 / 超时：只要还有上次成功的值就继续用，绝不让 UI 变红
          const stale = usageStore.getStale(cacheKey);
          if (stale) {
            usageStats.stale += 1;
            return stale;
          }
          usageStats.error += 1;
          return usageError(e);
        }
      });
    } catch (e) {
      const stale = usageStore.getStale(cacheKey);
      if (stale) {
        usageStats.stale += 1;
        return stale;
      }
      usageStats.error += 1;
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
