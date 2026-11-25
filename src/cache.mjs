// src/cache.mjs — 两个极小的并发原语：TTL 缓存 + singleflight。
// 只依赖 Map/Date.now，不引第三方包；同一 Key 的并发请求在上游只算一次。

const HOUR = 60 * 60_000;

/**
 * @param {{ttlMs?:number, staleMs?:number, now?:()=>number, max?:number}} [opts]
 *   ttlMs   —— 条目在这段时间内算「新」，由 peek() 的 age 交给调用方判断
 *   staleMs —— 过期后还能被 getStale() 捞出来用的兜底窗口
 *   max     —— 条目上限，超出按最旧淘汰（防止多账号长期跑把内存撑大）
 */
export function createTtlCache(opts = {}) {
  const staleMs = Math.max(0, Number(opts.staleMs) || 0);
  const max = Math.max(1, Number(opts.max) || 512);
  const now = opts.now || Date.now;
  /** @type {Map<string, {value:any, at:number}>} */
  const store = new Map();

  function touch(key, entry) {
    // Map 保持插入顺序：删了再塞回去 = LRU 的「用到就挪到队尾」
    store.delete(key);
    store.set(key, entry);
  }

  function evict() {
    while (store.size > max) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }

  return {
    /** @returns {{value:any, at:number, age:number}|null} 不论新鲜与否都返回。 */
    peek(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { value: entry.value, at: entry.at, age: Math.max(0, now() - entry.at) };
    },
    /** 只在 staleMs 窗口内返回旧值，用于上游失败兜底。 */
    getStale(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (staleMs && now() - entry.at > staleMs) return null;
      return entry.value;
    },
    set(key, value, at) {
      touch(key, { value, at: at ?? now() });
      evict();
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    get size() {
      return store.size;
    },
  };
}

/**
 * 同 key 的并发调用合并成一次真实执行。
 * @template T
 * @param {Map<string, Promise<T>>} inflight
 * @param {string} key
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export function singleflight(inflight, key, run) {
  const existing = inflight.get(key);
  if (existing) return existing;
  let promise;
  try {
    promise = Promise.resolve(run());
  } catch (e) {
    promise = Promise.reject(e);
  }
  const settle = () => {
    if (inflight.get(key) === promise) inflight.delete(key);
  };
  // 成败都要清，否则一次失败会把后续请求永久挂在死 promise 上
  promise.then(settle, settle);
  inflight.set(key, promise);
  return promise;
}

export const CACHE_CONSTANTS = Object.freeze({ HOUR });
