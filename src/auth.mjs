// src/auth.mjs — 单 Key 登录、校验，以及批量导入写盘所用的登录态结构。
// 站点只有一种登录：Authorization: Bearer hms-…（无 OAuth / AK-SK）。
import {
  BASE,
  MODELS_PATH,
  PROVIDER,
  PROVIDER_NAME,
  VERIFY_TIMEOUT_MS,
  QUOTA_HEADERS,
} from "./config.mjs";
import { keyFingerprint } from "./cache-key.mjs";
import { isValidKey } from "./bulk-import.mjs";
import { apiFetch, ApiError, errorText, maskKey } from "./http.mjs";

export const looksApiKey = (v) => isValidKey(v);

/** 账号显示名：keyLabel 优先，否则脱敏 Key + 指纹尾号。 */
export function accountLabelOf(key, label = "") {
  if (typeof label === "string" && label.trim()) return label.trim().slice(0, 48);
  return `${PROVIDER_NAME} · ${maskKey(key, 7, 4)}`;
}

/** 稳定账号 uid：指纹即可，绝不落明文。 */
export function uidOf(key) {
  return `hms-${keyFingerprint(key)}`;
}

export function quotaFromHeaders(headers) {
  if (!headers) return null;
  const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
  const limit = Number(get(QUOTA_HEADERS.limit));
  const used = Number(get(QUOTA_HEADERS.used));
  const remaining = Number(get(QUOTA_HEADERS.remaining));
  const reset = get(QUOTA_HEADERS.reset);
  if (![limit, used, remaining].some((n) => Number.isFinite(n))) return null;
  return {
    limit: Number.isFinite(limit) ? limit : null,
    used: Number.isFinite(used) ? used : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    reset: reset || "",
  };
}

/**
 * 在线校验 Key：GET /v1/models 带 Bearer；200 视为有效。
 * 用 models 而非 chat/completions，避免校验扣额度。
 * @returns {{ok:boolean, reason?:string, quota?:Object}}
 */
export async function verifyApiKey(apiKey, options = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!looksApiKey(key)) return { ok: false, reason: "Key 形态不合法" };

  const base = (options.base || BASE).replace(/\/+$/, "");
  const url = `${base}${MODELS_PATH}`;
  try {
    const res = await apiFetch(url, {
      method: "GET",
      timeoutMs: options.timeoutMs || VERIFY_TIMEOUT_MS,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      proxy: options.proxy,
      headers: { authorization: `Bearer ${key}` },
    });
    const quota = quotaFromHeaders(res.headers);
    return { ok: true, quota: quota ?? undefined };
  } catch (e) {
    let reason = errorText(e);
    if (e instanceof ApiError) {
      if (e.signIn === "expired" || /invalid_api_key|missing_api_key/i.test(`${e.code} ${reason}`)) {
        reason = "Key 无效或已失效（invalid_api_key）";
      } else if (e.status === 429) {
        // 配额耗尽也算有效 Key——只是当天没额度了，仍允许导入
        return { ok: true, quota: quotaFromHeaders(e?.response?.headers), limited: true };
      }
    }
    return { ok: false, reason };
  }
}

/** authorize 返回值：{type:"success", key, metadata} 供宿主存盘。 */
export function successAuth(key, options = {}) {
  const clean = String(key).trim();
  return {
    type: "success",
    key: clean,
    metadata: {
      provider: options.provider || PROVIDER,
      accountId: uidOf(clean),
      uid: uidOf(clean),
      label: accountLabelOf(clean, options.label),
      mode: "api",
      ...(options.quota ? { lastQuota: options.quota } : {}),
    },
  };
}

export function failedAuth(error) {
  return { type: "failed", error: errorText(error) || "登录失败" };
}

/** 供 CLI 直接写 plugin-auth.json 的登录态 body（OpenCode/magpie api 同形）。 */
export function authBody(key, options = {}) {
  const clean = String(key).trim();
  return {
    type: "api",
    key: clean,
    accountId: uidOf(clean),
    ...(options.label ? { label: String(options.label).slice(0, 48) } : {}),
  };
}

/** 从任意登录态里取出可用的 apiKey。 */
export function apiKeyOf(auth) {
  if (!auth) return "";
  const candidates = [auth.key, auth.apiKey, auth.access, auth.token];
  for (const c of candidates) {
    if (typeof c === "string" && looksApiKey(c.trim())) return c.trim();
  }
  return "";
}

export function isUsableAuth(auth) {
  return Boolean(apiKeyOf(auth));
}

/** api method 的 authorize：magpie 登录框只填 key。 */
export async function keyOnlyLogin(inputs = {}, context = {}) {
  const key = String(inputs.key ?? inputs.apiKey ?? inputs.token ?? "").trim();
  if (!looksApiKey(key)) return failedAuth("请输入 hms- 开头的 API Key");
  const result = await verifyApiKey(key, {
    base: context.base,
    fetchImpl: context.fetchImpl,
    signal: context.signal,
    timeoutMs: context.timeoutMs,
  });
  if (!result.ok) return failedAuth(result.reason);
  return successAuth(key, { label: inputs.label || context.defaultLabel, quota: result.quota });
}
