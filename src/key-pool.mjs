// src/key-pool.mjs — 从 Magpie 登录态文件里取同供应商的其他 Key，供 429 时插件内换号。
// 不依赖宿主是否认识 x-magpie-failover：插件自己就能把请求重发到另一把 Key 上。
//
// 1.3.3 起与 key-health 联动：冷却中的账号（额度耗尽 / 过载 / 凭据失效）直接跳过，
// 不再让每个请求都从第一把 Key 开始白撞 429。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyHealth } from "./key-health.mjs";

const DEFAULT_PATH = join(homedir(), ".config", "magpie", "plugin-auth.json");
const TTL_MS = 30_000; // 半分钟缓存一次；用户在 Magpie 里改完账号最多等 30s

/** 只认站点签发的 hms- Key，其它供应商的登录态一律不碰。 */
const KEY_RE = /^hms-[A-Za-z0-9_\-]{6,}$/;

/**
 * @param {string} provider provider id（默认 hms）
 * @param {{path?:string, ttlMs?:number, health?:object, healthFile?:string, now?:() => number}} [opts]
 */
export function createKeyPool(provider = "hms", opts = {}) {
  const file = opts.path || process.env.MAGPIE_AUTH_FILE || DEFAULT_PATH;
  const ttlMs = Math.max(1_000, Number(opts.ttlMs) || TTL_MS);
  // 健康状态：调用方可注入共享实例；不注入就自建（测试可用 healthFile 隔离）
  const health = opts.health || createKeyHealth({ file: opts.healthFile, now: opts.now });
  let cached = null;
  let cachedAt = 0;

  function allKeys() {
    const now = Date.now();
    if (cached && now - cachedAt < ttlMs) return cached;
    let keys = [];
    try {
      const auth = JSON.parse(readFileSync(file, "utf8"));
      const prefix = `${provider}#`;
      keys = [...new Set(
        Object.entries(auth ?? {})
          .filter(([slot, v]) => (slot === provider || slot.startsWith(prefix)) && typeof v?.key === "string")
          .map(([, v]) => v.key)
          .filter((k) => KEY_RE.test(k)),
      )];
    } catch {
      // 文件读不到/格式坏了：返回空池，当前账号照常工作，只是不换号
      keys = [];
    }
    cached = keys;
    cachedAt = now;
    return keys;
  }

  return {
    health,
    /**
     * 除 currentKey 之外还可以试的 Key（稳定顺序，去重）。
     * 冷却中的账号排到最后：健康的先用；全都冷却时仍返回全部 ——
     * 宁可让调用方撞一次，也不要直接判定「没有可用账号」。
     */
    candidates(currentKey) {
      const rest = allKeys().filter((k) => k !== currentKey);
      const healthy = [];
      const cooling = [];
      for (const k of rest) {
        if (health.isCooling(k)) cooling.push(k);
        else healthy.push(k);
      }
      return healthy.length ? [...healthy, ...cooling] : rest;
    },
    /** 池子规模与冷却概览（给 usage / 诊断用） */
    summary() {
      const all = allKeys();
      const snap = health.snapshot();
      return { total: all.length, cooling: Math.min(snap.cooling, all.length), rows: snap.rows };
    },
    get size() {
      return allKeys().length;
    },
    /** 测试 / 用户改完账号后强制重读 */
    reset() {
      cached = null;
      cachedAt = 0;
      health.reset?.();
    },
  };
}
