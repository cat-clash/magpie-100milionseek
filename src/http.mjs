// 通用 HTTP / 错误 / 脱敏工具。除 config.mjs 外零依赖。
// 脱敏规则针对 hms- Key；绝不把明文 Key 写进日志或错误文案。
import { VERIFY_TIMEOUT_MS, USER_AGENT } from "./config.mjs";

export class ApiError extends Error {
  constructor(message, init = {}) {
    super(String(message ?? "请求失败"));
    this.name = "ApiError";
    this.status = Number(init.status) || 0;
    this.code = typeof init.code === "string" ? init.code : "";
    this.type = typeof init.type === "string" ? init.type : "";
    this.body = init.body ?? null;
    this.signIn = typeof init.signIn === "string" ? init.signIn : "";
    if (init.cause) this.cause = init.cause;
  }
}

export const abortError = (message = "已取消") =>
  Object.assign(new Error(message), { name: "AbortError" });

export function isAbort(e) {
  return e?.name === "AbortError" || e?.code === "ABORT_ERR" || String(e?.message ?? "").includes("aborted");
}

export function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers ?? undefined);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

export function errorResponse(status, message, type = "api_error", code = "", headers = {}) {
  return jsonResponse({ error: { message: String(message ?? ""), type: type || "api_error", code: code || "" } }, { status, headers });
}

function maskTail(str, keep) {
  const s = String(str ?? "");
  if (s.length <= keep + 2) return "*".repeat(Math.max(3, s.length));
  return `${s.slice(0, keep)}…${s.slice(-2)}`;
}

const REDACT_RULES = [
  [/\bhms-([A-Za-z0-9_\-{}]{4,})\b/gi, (_m, s) => `hms-${maskTail(s, 4)}`],
  [/\b(sk|tk)-([A-Za-z0-9_\-{}]{4,})\b/gi, (_m, p, s) => `${p}-${maskTail(s, 4)}`],
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, () => "jwt:****"],
  [/\b[0-9a-f]{28,}\b/gi, (m) => maskTail(m, 6)],
  [
    /(["']?(?:api[_-]?key|apikey|secret(?:[_-]?key)?|authorization|password|token)["']?\s*[:=]\s*["']?)([^\s"',;}&]{4,})/gi,
    (_m, head) => `${head}****`,
  ],
];

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 日志与错误文案里出现的一切凭据都必须先过这里。 */
export function redact(value) {
  let text = typeof value === "string" ? value : value == null ? "" : String(safeStringify(value));
  for (const [re, rep] of REDACT_RULES) text = text.replace(re, rep);
  return text;
}

/** 只保留前 6 后 4，用于账号显示名。 */
export function maskKey(value, head = 6, tail = 4) {
  const s = String(value ?? "");
  if (s.length <= head + tail) return "*".repeat(Math.max(4, s.length));
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function errorText(error) {
  if (!error) return "未知错误";
  if (error instanceof ApiError) {
    const parts = [error.message];
    if (error.code) parts.push(`code=${error.code}`);
    if (error.status) parts.push(`http=${error.status}`);
    return parts.join(" · ");
  }
  const nested = error?.error?.message ?? error?.response?.data?.error?.message;
  if (typeof nested === "string" && nested) return redact(nested);
  return redact(String(error?.message ?? error));
}

/** AbortSignal.timeout + 外部 signal 合成。 */
export function timeoutSignal(timeoutMs, signal) {
  const ms = Math.max(1, Number(timeoutMs) || VERIFY_TIMEOUT_MS);
  if (typeof AbortSignal === "undefined") return signal ?? undefined;
  const timer = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : null;
  if (!timer) return signal ?? undefined;
  if (!signal) return timer;
  if (typeof AbortSignal.any === "function") {
    try {
      return AbortSignal.any([timer, signal]);
    } catch {
      /* 手工合成 */
    }
  }
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (timer.aborted) abort(timer.reason);
  else timer.addEventListener?.("abort", () => abort(timer.reason), { once: true });
  if (signal.aborted) abort(signal.reason);
  else signal.addEventListener?.("abort", () => abort(signal.reason), { once: true });
  return controller.signal;
}

/** 从响应构造 ApiError，兼容 OpenAI {error:{…}} 外壳。 */
export function apiErrorFromResponse(response, payload, rawText) {
  const status = response?.status ?? 0;
  const body = payload ?? (rawText ? { raw: String(rawText).slice(0, 400) } : null);
  const openai = body?.error;
  let message =
    (typeof openai === "string" ? openai : openai?.message) ??
    body?.message ??
    (typeof body === "string" ? body : "") ??
    "";
  if (!message) message = `上游返回 HTTP ${status}`;
  const type = (typeof openai === "object" && openai?.type) || body?.type || "";
  const code = (typeof openai === "object" && String(openai?.code ?? "")) || String(body?.code ?? "");
  const error = new ApiError(redact(String(message)), { status, type, code, body });
  if (status === 401 || (status === 403 && /invalid_api_key|authentication/i.test(`${code} ${message}`))) {
    error.signIn = "expired";
  }
  return error;
}

/** 小请求统一入口：带超时、统一错误、返回 headers 供配额读取。 */
export async function apiFetch(url, init = {}) {
  const { timeoutMs = VERIFY_TIMEOUT_MS, signal, headers, method = "GET", body, fetchImpl } = init;
  const finalSignal = timeoutSignal(timeoutMs, signal);
  const doFetch = fetchImpl ?? fetch;
  let response;
  try {
    response = await doFetch(url, {
      method,
      body,
      signal: finalSignal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(headers ?? {}),
      },
    });
  } catch (e) {
    if (isAbort(e) && signal?.aborted) throw abortError();
    throw new ApiError(`请求失败：${errorText(e)}`, { status: 0, cause: e });
  }
  const text = await response.text().catch(() => "");
  const data = parseJson(text);
  if (!response.ok) throw apiErrorFromResponse(response, data, text);
  return { status: response.status, headers: response.headers, data, text };
}
