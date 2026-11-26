// src/key-health.mjs — 账号健康状态：谁在冷却、为什么、到什么时候。
//
// 为什么需要它：key-pool 只能给出"还有哪些 Key"，不知道哪把已经废了。
// 18 把账号里若有一半今日额度耗尽，每个请求都要从第一把开始白撞 429 ——
// 撞一次就是一次真实往返（实测每次 300~900ms），还额外给站点风控加计数。
// 这里把失败结果记下来（持久化），下一次直接跳过冷却中的账号。
//
// 设计取舍：
// · 只存 Key 的 SHA-256 指纹前缀，**绝不落盘明文 Key**；
// · 冷却到期自动失效，不需要人工清理；成功一次即清除该 Key 的所有记录；
// · 文件读不到 / 格式坏了 → 静默降级为"全部健康"，不影响请求；
// · 写盘用 临时文件 + rename 原子替换，避免半截文件。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_FILE = join(homedir(), ".config", "magpie", "100milionseek-health.json");

/** 各类失败的默认冷却时长（毫秒）；quota 走站点给的 reset_at，拿不到就等次日 UTC 0 点。 */
export const COOLDOWN_MS = Object.freeze({
  quota: 0, // 0 = 由 resolveUntil 按 reset_at / 次日零点算
  session: 2_000, // 429 session_limit_reached：并发槽位满，2s 后重算
  busy: 15_000, // 503 upstream_busy：站点过载，15s 后再说
  auth: 6 * 60 * 60_000, // 401：凭据失效，6h 内别再用它试
});

/** 下次 UTC 零点（站点额度按 UTC 日重置）。 */
function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** 把「重置时刻」归一成毫秒时间戳：支持 ISO 串 / 秒 / 毫秒。 */
function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1e12 ? value : value * 1000; // 秒 → 毫秒
  }
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** Key → 指纹（只留 16 位，足够区分，且不可反推）。 */
export function fingerprint(key) {
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
}

/**
 * @param {{file?:string, now?:() => number, persist?:boolean}} [opts]
 */
export function createKeyHealth(opts = {}) {
  const file = opts.file || process.env.HMS_HEALTH_FILE || DEFAULT_FILE;
  const now = opts.now || Date.now;
  const persist = opts.persist !== false;
  /** @type {Record<string,{until:number,kind:string,fails:number,at:number}>} */
  let state = null;

  const load = () => {
    if (state) return state;
    state = {};
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [fp, rec] of Object.entries(raw)) {
          const until = toMs(rec?.until) ?? 0;
          if (until > now()) {
            state[fp] = {
              until,
              kind: String(rec?.kind || "unknown"),
              fails: Math.max(1, Number(rec?.fails) || 1),
              at: Number(rec?.at) || now(),
            };
          }
        }
      }
    } catch {
      /* 读不到 / 坏 JSON：当作全部健康 */
    }
    return state;
  };

  const save = () => {
    if (!persist) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(load(), null, 2), "utf8");
      renameSync(tmp, file);
    } catch {
      /* 写盘失败不影响请求链路 */
    }
  };

  /** 现在还在冷却里的指纹集合（顺带清掉过期的）。 */
  function coolingSet() {
    const s = load();
    const t = now();
    const out = new Set();
    let dirty = false;
    for (const [fp, rec] of Object.entries(s)) {
      if (rec.until > t) out.add(fp);
      else {
        delete s[fp];
        dirty = true;
      }
    }
    if (dirty) save();
    return out;
  }

  /** 由失败信息算出冷却截止时刻。 */
  function resolveUntil(kind, { retryAfterSec, resetAt } = {}) {
    const t = now();
    const fixed = COOLDOWN_MS[kind] ?? COOLDOWN_MS.busy;
    if (kind === "quota") {
      const reset = toMs(resetAt);
      if (reset && reset > t) return reset;
      const fromRetry = Number(retryAfterSec);
      if (Number.isFinite(fromRetry) && fromRetry > 0) {
        return Math.min(t + fromRetry * 1000, nextUtcMidnight(t));
      }
      return nextUtcMidnight(t);
    }
    const fromRetry = Number(retryAfterSec);
    if (kind === "busy" && Number.isFinite(fromRetry) && fromRetry > 0) {
      // 站点建议 20s，但别超过 2 分钟
      return t + Math.min(fromRetry * 1000, 120_000);
    }
    return t + fixed;
  }

  return {
    /** 这把 Key 是否在冷却中 */
    isCooling(key) {
      return coolingSet().has(fingerprint(key));
    },

    /** 记一次失败（kind: quota | session | busy | auth） */
    markFailure(key, kind, info = {}) {
      const fp = fingerprint(key);
      const s = load();
      const prev = s[fp];
      const until = resolveUntil(kind, info);
      s[fp] = {
        until,
        kind: String(kind),
        fails: (prev?.fails ?? 0) + 1,
        at: now(),
      };
      save();
      return until;
    },

    /** 成功一次就清掉该 Key 的失败记录（半开探测成功的语义） */
    markSuccess(key) {
      const fp = fingerprint(key);
      const s = load();
      if (s[fp]) {
        delete s[fp];
        save();
        return true;
      }
      return false;
    },

    /** 诊断快照：给 usage / CLI 用 */
    snapshot() {
      const s = load();
      const t = now();
      const rows = Object.entries(s)
        .filter(([, rec]) => rec.until > t)
        .map(([fp, rec]) => ({
          fp,
          kind: rec.kind,
          fails: rec.fails,
          until: rec.until,
          secondsLeft: Math.max(0, Math.round((rec.until - t) / 1000)),
        }))
        .sort((a, b) => b.until - a.until);
      return { cooling: rows.length, rows };
    },

    /** 测试用：清空内存状态并重读文件 */
    reset() {
      state = null;
    },
  };
}
