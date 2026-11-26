// src/key-pool.mjs — 从 Magpie 登录态文件里取同供应商的其他 Key，供 429 时插件内换号。
// 不依赖宿主是否认识 x-magpie-failover：插件自己就能把请求重发到另一把 Key 上。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "magpie", "plugin-auth.json");
const TTL_MS = 30_000; // 半分钟缓存一次；用户在 Magpie 里改完账号最多等 30s

/** 只认站点签发的 hms- Key，其它供应商的登录态一律不碰。 */
const KEY_RE = /^hms-[A-Za-z0-9_\-]{6,}$/;

/**
 * @param {string} provider provider id（默认 hms）
 * @param {{path?:string, ttlMs?:number}} [opts]
 */
export function createKeyPool(provider = "hms", opts = {}) {
  const file = opts.path || process.env.MAGPIE_AUTH_FILE || DEFAULT_PATH;
  const ttlMs = Math.max(1_000, Number(opts.ttlMs) || TTL_MS);
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
    /** 除 currentKey 之外还可以试的 Key（稳定顺序，去重） */
    candidates(currentKey) {
      return allKeys().filter((k) => k !== currentKey);
    },
    get size() {
      return allKeys().length;
    },
    /** 测试 / 用户改完账号后强制重读 */
    reset() {
      cached = null;
      cachedAt = 0;
    },
  };
}
