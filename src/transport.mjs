// src/transport.mjs — 上游连接复用：优先用 undici Agent（能 import 到才用），
// 拿不到就靠运行时自带的 keep-alive + 起点预热，不引入任何 npm 依赖。
// 目标：一次会话里只做一次 DNS + TLS 握手，之后所有 chat 请求复用同一条连接。
import {
  UPSTREAM_KEEPALIVE_MS,
  UPSTREAM_KEEPALIVE_MAX_MS,
  UPSTREAM_CONNECTIONS,
  UPSTREAM_CONNECT_TIMEOUT_MS,
} from "./config.mjs";

let resolved = false;
let dispatcher = null;
let mode = "runtime"; // "undici" | "runtime"

/** 有些运行时的 fetch 不认 dispatcher（会直接忽略），此时留着也没害处。 */
function fetchAcceptsDispatcher(fetchImpl) {
  if (typeof fetchImpl !== "function") return false;
  // undici 的 fetch 明说自己支持；Bun 的 fetch 也接受该字段（实测忽略即透传）。
  return true;
}

/**
 * 解析（并缓存）上游 dispatcher。
 * 只在真的能 import 到 undici 时创建 Agent；否则返回 null，由运行时默认 keep-alive 兜底。
 * @param {{fetchImpl?:Function}} [opts]
 * @returns {Promise<object|null>}
 */
export async function resolveDispatcher(opts = {}) {
  if (resolved) return dispatcher;
  resolved = true;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchAcceptsDispatcher(fetchImpl)) return null;
  try {
    // 动态 import：宿主没装 undici 时这里抛错，走 runtime 兜底，绝不影响插件加载。
    const mod = await import("undici");
    const Agent = mod?.Agent;
    if (typeof Agent !== "function") return null;
    dispatcher = new Agent({
      keepAliveTimeout: UPSTREAM_KEEPALIVE_MS,
      keepAliveMaxTimeout: UPSTREAM_KEEPALIVE_MAX_MS,
      connections: UPSTREAM_CONNECTIONS,
      pipelining: 0, // 上游按 SSE 计费，串行连接池比 pipeline 更安全
      connectTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
    });
    mode = "undici";
  } catch {
    dispatcher = null;
    mode = "runtime";
  }
  return dispatcher;
}

/** 同步读当前 transport 模式，仅用于 README / 观测，不触发 import。 */
export function transportMode() {
  return mode;
}

/** 测试用：重置单例，避免用例之间互相污染。 */
export function resetTransport() {
  resolved = false;
  dispatcher = null;
  mode = "runtime";
}

const warmed = new Set();

/**
 * 预热到上游的连接（DNS + TCP + TLS）。每个 origin 全进程只做一次。
 * 不发业务请求：优先 fetch.preconnect（Bun 提供），退路是 HEAD /models。
 * @param {string} base 例如 https://100milionseek.top/v1
 * @param {{fetchImpl?:Function, signal?:AbortSignal}} [opts]
 */
export function warmupOrigin(base, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return;
  let origin;
  try {
    origin = new URL(String(base)).origin;
  } catch {
    return;
  }
  if (warmed.has(origin)) return;
  warmed.add(origin);
  // 1) 运行时原生预热：零请求，只做握手
  try {
    if (typeof fetchImpl.preconnect === "function") {
      fetchImpl.preconnect(origin);
      return;
    }
  } catch {
    /* 落到退路 */
  }
  // 2) 退路：HEAD /models，不读 body、不计额度
  try {
    const p = fetchImpl(`${origin}/v1/models`, {
      method: "HEAD",
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    p?.then?.(
      (r) => r?.body?.cancel?.(),
      () => {}
    );
  } catch {
    /* 预热失败不影响主流程 */
  }
}

/** 测试用：清空预热记录。 */
export function resetWarmup() {
  warmed.clear();
}
