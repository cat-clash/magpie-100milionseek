// src/models.mjs — 静态模型目录 + 可选的在线刷新。
// 2026-11-26 实测：上游 /v1/models 只回两条 —— deepseek-v4.1-flash-free（chat，1x）
// 与 jev-1.13-free（judge，只服务 /v1/systemone，0.2x）。后者拿来 chat 会 400
// wrong_endpoint，所以**不并进模型表**（否则用户在 Magpie 里选中一个必然报错的项）。
// 缓存：进程内单例 TTL + singleflight，刷新模型列表最多每小时打一次上游。
import {
  DEFAULT_MODEL,
  MODEL_CONTEXT,
  MODEL_OUTPUT,
  MODEL_LABELS,
  CHAT_ENDPOINT_RE,
  PROVIDER_NAME,
  MODEL_LIST_TTL_MS,
  MODEL_LIST_TIMEOUT_MS,
} from "./config.mjs";
import { apiFetch } from "./http.mjs";
import { keyFingerprint } from "./cache-key.mjs";
import { createTtlCache, singleflight } from "./cache.mjs";

/** magpie 需要的模型条目形状。 */
export function modelEntry(id, live = {}) {
  const name =
    (typeof live.name === "string" && live.name.trim()) || MODEL_LABELS[id] || id;
  // 上游用的是 OpenAI 风格的 context_length / max_output_tokens；
  // 旧版只读 live.limit.*（上游从不给），于是永远落到默认值 —— 上游改窗口就跟不上。
  const context = Math.max(
    1,
    Number(live.context_length) || Number(live.limit?.context) || MODEL_CONTEXT,
  );
  const output = Math.max(
    1,
    Number(live.max_output_tokens) || Number(live.limit?.output) || MODEL_OUTPUT,
  );
  return {
    id,
    name,
    limit: { context, output },
    tool_call: true,
    reasoning: false,
    attachment: false,
    cost: {
      input: Number(live.cost?.input) || 0,
      output: Number(live.cost?.output) || 0,
      cache_read: 0,
      cache_write: 0,
    },
    // 上游的额度倍率（1x / 0.2x）；magpie 不认识，但 usage/诊断会用到
    ...(Number(live.quota_multiplier) ? { quota_multiplier: Number(live.quota_multiplier) } : {}),
  };
}

/**
 * 条目能不能当 chat 模型用。
 * 上游对 judge 模型给了 `endpoint: "/v1/systemone"`；没有 endpoint 字段的按 chat 算
 * （将来上游不写 endpoint 时不会误杀）。
 */
export function isChatModel(live) {
  if (!live || typeof live !== "object") return true;
  const endpoint = typeof live.endpoint === "string" ? live.endpoint.trim() : "";
  if (!endpoint) return true;
  return CHAT_ENDPOINT_RE.test(endpoint);
}

/** 静态兜底表（永远可用，不依赖网络）。表内容冻结，避免调用方改到共享对象。 */
const STATIC_TABLE = Object.freeze({ [DEFAULT_MODEL]: Object.freeze(modelEntry(DEFAULT_MODEL)) });

export function staticModelTable() {
  return { ...STATIC_TABLE };
}

/**
 * 解析 GET /v1/models 的 OpenAI 兼容响应。
 * @param {any} data
 * @param {{chatOnly?: boolean}} [opts] chatOnly 默认 true：把 judge 之类非 chat 端点剔掉
 */
export function parseModelList(data, opts = {}) {
  const chatOnly = opts.chatOnly !== false;
  const out = {};
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  for (const m of list) {
    const id = typeof m === "string" ? m : m?.id;
    if (typeof id !== "string" || !id) continue;
    const live = typeof m === "object" && m ? m : {};
    if (chatOnly && !isChatModel(live)) continue;
    out[id] = modelEntry(id, live);
  }
  return out;
}

/**
 * 在线取模型表；失败返回 null（由 index 回退到静态表）。
 */
export async function fetchModelTable(options = {}) {
  const base = String(options.base || "").replace(/\/+$/, "");
  const path = options.modelsPath || "/models";
  const key = options.apiKey || "";
  if (!base || !key) return null;
  try {
    const res = await apiFetch(`${base}${path}`, {
      method: "GET",
      timeoutMs: options.timeoutMs || MODEL_LIST_TIMEOUT_MS,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      dispatcher: options.dispatcher,
      proxy: options.proxy,
      headers: { authorization: `Bearer ${key}` },
    });
    const table = parseModelList(res.data);
    return Object.keys(table).length ? table : null;
  } catch {
    return null;
  }
}

// ---- 进程内单例缓存 ---------------------------------------------------------
// 存 24h 原始条目，TTL 由调用方按 options.modelListTtlMs 判断，故一份缓存可服务多种 TTL。
const modelStore = createTtlCache({ ttlMs: 24 * 60 * 60_000, staleMs: 24 * 60 * 60_000 });
const modelInflight = new Map();

/** 测试与 README 共用的计数口径。 */
export const modelTableStats = { hit: 0, miss: 0, upstream: 0, coalesced: 0, stale: 0 };

export function resetModelTableCache() {
  modelStore.clear();
  modelInflight.clear();
  lastTable = null;
  modelTableStats.hit = 0;
  modelTableStats.miss = 0;
  modelTableStats.upstream = 0;
  modelTableStats.coalesced = 0;
  modelTableStats.stale = 0;
}

/**
 * 带 TTL + 单飞 + 失败回退旧值的模型表读取。
 * @returns {Promise<{table:object|null, cached:boolean, stale?:boolean, ageMs?:number}>}
 */
export async function cachedModelTable(options = {}) {
  const base = String(options.base || "").replace(/\/+$/, "");
  const apiKey = options.apiKey || "";
  const ttlMs = Math.max(1_000, Number(options.ttlMs) || MODEL_LIST_TTL_MS);
  if (!base || !apiKey) return { table: null, cached: false };

  const key = `${base}|${keyFingerprint(apiKey)}`;
  const fresh = modelStore.peek(key);
  if (fresh && fresh.age < ttlMs) {
    modelTableStats.hit += 1;
    return { table: fresh.value, cached: true, ageMs: fresh.age };
  }

  const already = modelInflight.size > 0 && modelInflight.has(key);
  return singleflight(modelInflight, key, async () => {
    if (already) modelTableStats.coalesced += 1;
    // 拿到锁后二次检查：排队期间别的请求可能已经填好了
    const again = modelStore.peek(key);
    if (again && again.age < ttlMs) {
      modelTableStats.hit += 1;
      return { table: again.value, cached: true, ageMs: again.age };
    }
    modelTableStats.miss += 1;
    const table = await fetchModelTable({
      base,
      modelsPath: options.modelsPath,
      apiKey,
      timeoutMs: options.timeoutMs || MODEL_LIST_TIMEOUT_MS,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      dispatcher: options.dispatcher,
    });
    if (table) {
      modelStore.set(key, table);
      setPeekModelTable(table);
      modelTableStats.upstream += 1;
      return { table, cached: false };
    }
    // 上游挂了：只要还有旧值就继续用，模型列表不该因此变空
    const stale = modelStore.getStale(key);
    if (stale) {
      modelTableStats.stale += 1;
      return { table: stale, cached: true, stale: true, ageMs: modelStore.peek(key)?.age ?? 0 };
    }
    return { table: null, cached: false };
  });
}

/**
 * 合并静态 + 在线 + 用户改动。优先级：**用户 providerCfg.models > 在线上游 > 静态兜底**。
 * （1.3.0 修：以前 `if (!merged[id])` 让静态条目挡住在线条目，于是上游的
 *  context_length / name / quota_multiplier 永远进不来，改了窗口也跟不上。）
 */
export function mergeModelTables(staticTable, liveTable, previous = {}) {
  const merged = {};
  for (const [id, model] of Object.entries(staticTable ?? {})) merged[id] = model;
  for (const [id, model] of Object.entries(liveTable ?? {})) {
    if (!model || typeof model !== "object") continue;
    const base = merged[id];
    merged[id] = base
      ? { ...base, ...model, limit: { ...(base.limit ?? {}), ...(model.limit ?? {}) } }
      : model;
  }
  for (const [id, prev] of Object.entries(previous ?? {})) {
    if (merged[id] && prev && typeof prev === "object") {
      merged[id] = { ...merged[id], ...prev, limit: { ...merged[id].limit, ...(prev.limit ?? {}) } };
    }
  }
  return merged;
}

export const providerIdentity = { name: PROVIDER_NAME };

/**
 * 同步窥一眼最近一次成功刷到的模型表（可能是旧值），拿不到返回 null。
 * loader 里的 GET /models 用它，避免为了一个本地应答去等网络。
 */
let lastTable = null;
export function peekModelTable() {
  return lastTable;
}
/** 由 cachedModelTable 成功后写入；供 relay 的本地 /models 应答使用。 */
export function setPeekModelTable(table) {
  if (table && typeof table === "object") lastTable = table;
}
