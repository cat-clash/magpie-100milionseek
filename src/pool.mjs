// src/pool.mjs — 上游连接复用。
// Bun/Node 原生 fetch 自身有 keep-alive，但并发高时连接池太小会反复握手；
// 有 undici 就显式给一个 Agent，没有就返回 undefined（调用方原样透传，行为不变）。
import {
  UPSTREAM_KEEPALIVE_MS,
  UPSTREAM_KEEPALIVE_MAX_MS,
  UPSTREAM_CONNECTIONS,
  UPSTREAM_CONNECT_TIMEOUT_MS,
} from "./config.mjs";

let cachedPool;
let poolProbed = false;

function buildAgent(undici) {
  const Agent = undici?.Agent;
  if (typeof Agent !== "function") return undefined;
  try {
    return new Agent({
      keepAliveTimeout: UPSTREAM_KEEPALIVE_MS,
      keepAliveMaxTimeout: UPSTREAM_KEEPALIVE_MAX_MS,
      connections: UPSTREAM_CONNECTIONS,
      connect: { timeout: UPSTREAM_CONNECT_TIMEOUT_MS },
      // 复用前先探活，避免拿到已被上游掐断的 socket 才失败重试
      pipelining: 1,
    });
  } catch {
    return undefined;
  }
}

/**
 * 同步拿共享 Agent（第一次调用时尝试加载 undici）。
 * 用同步 require 风格：Bun 支持 createRequire 直接加载内置 undici。
 * @returns {object|undefined}
 */
export function getUpstreamDispatcher() {
  if (poolProbed) return cachedPool;
  poolProbed = true;
  try {
    // Bun 把 undici 作为内置模块；Node 18+ 也可 require("undici")（若已安装）
    const req = typeof require === "function" ? require : null;
    if (!req) return (cachedPool = undefined);
    cachedPool = buildAgent(req("undici"));
  } catch {
    cachedPool = undefined;
  }
  return cachedPool;
}

/** 异步版：宿主只支持 import() 时用（模型表 / 用量探测这类一次性请求）。 */
export async function ensureUpstreamDispatcher() {
  const sync = getUpstreamDispatcher();
  if (sync) return sync;
  try {
    const undici = await import("undici");
    cachedPool = buildAgent(undici);
    poolProbed = true;
  } catch {
    cachedPool = undefined;
  }
  return cachedPool;
}

export function poolInfo() {
  return {
    enabled: Boolean(cachedPool),
    connections: UPSTREAM_CONNECTIONS,
    keepAliveMs: UPSTREAM_KEEPALIVE_MS,
  };
}
