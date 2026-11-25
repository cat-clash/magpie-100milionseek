// src/models.mjs — 静态模型目录 + 可选的在线刷新。
// docs 明确只给一个模型；在线 /v1/models 若返回更多，作为附加项合并。
import {
  DEFAULT_MODEL,
  MODEL_CONTEXT,
  MODEL_OUTPUT,
  PROVIDER_NAME,
} from "./config.mjs";
import { apiFetch } from "./http.mjs";

/** magpie 需要的模型条目形状。 */
export function modelEntry(id, live = {}) {
  const name = typeof live.name === "string" && live.name.trim() ? live.name.trim() : id;
  const context = Math.max(1, Number(live.limit?.context) || MODEL_CONTEXT);
  const output = Math.max(1, Number(live.limit?.output) || MODEL_OUTPUT);
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
  };
}

/** 静态兜底表（永远可用，不依赖网络）。 */
export function staticModelTable() {
  return { [DEFAULT_MODEL]: modelEntry(DEFAULT_MODEL) };
}

/** 解析 GET /v1/models 的 OpenAI 兼容响应。 */
export function parseModelList(data) {
  const out = {};
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  for (const m of list) {
    const id = typeof m === "string" ? m : m?.id;
    if (typeof id !== "string" || !id) continue;
    out[id] = modelEntry(id, typeof m === "object" ? m : {});
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
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      headers: { authorization: `Bearer ${key}` },
    });
    const table = parseModelList(res.data);
    return Object.keys(table).length ? table : null;
  } catch {
    return null;
  }
}

/**
 * 合并静态 + 在线：静态默认模型永远保留，用户改过的字段（disabled/limit/name）保留。
 */
export function mergeModelTables(staticTable, liveTable, previous = {}) {
  const merged = { ...staticTable };
  for (const [id, model] of Object.entries(liveTable ?? {})) {
    if (!merged[id]) merged[id] = model;
  }
  for (const [id, prev] of Object.entries(previous ?? {})) {
    if (merged[id] && prev && typeof prev === "object") {
      merged[id] = { ...merged[id], ...prev, limit: { ...merged[id].limit, ...(prev.limit ?? {}) } };
    }
  }
  return merged;
}

export const providerIdentity = { name: PROVIDER_NAME };
