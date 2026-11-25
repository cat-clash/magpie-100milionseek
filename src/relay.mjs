// src/relay.mjs — loader 的 fetch 包装：只拦 /models，其余原样转发上游。
// 错误按站点返回码分档：401 → sign-in expired；429 quota → 换账号；429 session → 退避。
import {
  BASE,
  CHAT_PATH,
  MODELS_PATH,
  CHAT_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  QUOTA_HEADERS,
} from "./config.mjs";
import { apiKeyOf } from "./auth.mjs";
import { staticModelTable } from "./models.mjs";
import {
  ApiError,
  abortError,
  isAbort,
  jsonResponse,
  errorResponse,
  redact,
  errorText,
  timeoutSignal,
} from "./http.mjs";

function tailOf(url) {
  try {
    const u = new URL(String(url), "http://local");
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(url).split("?")[0];
  }
}

function isChatRequest(url) {
  const tail = tailOf(url);
  return tail.endsWith(CHAT_PATH) || tail.endsWith("/chat") || tail.endsWith("/completions");
}

function isModelsRequest(url) {
  const tail = tailOf(url);
  return tail.endsWith(MODELS_PATH) || tail === "/models";
}

/** 抹掉进来请求里可能存在的鉴权头，改用当前账号的 Key。 */
function cleanHeaders(init) {
  const h = new Headers(init?.headers ?? undefined);
  for (const name of ["authorization", "x-api-key", "api-key", "authentication"]) h.delete(name);
  if (!h.has("content-type") && init?.body) h.set("content-type", "application/json");
  return h;
}

function quotaHeadersInto(target, source) {
  if (!source || typeof source.forEach !== "function") return;
  source.forEach((value, name) => {
    if (name.startsWith("x-quota-")) {
      try {
        target.set(name, value);
      } catch {
        /* ignore */
      }
    }
  });
}

/** 把站点错误翻成 magpie 能理解的分档。 */
function translateError(error) {
  const status = error?.status ?? 0;
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  const headers = new Headers();
  let finalStatus = status || 500;
  let signIn = "";

  if (status === 401 || /invalid_api_key|missing_api_key|unauthorized/i.test(`${code} ${message}`)) {
    finalStatus = 401;
    signIn = "expired";
    headers.set("x-magpie-sign-in", "expired");
  } else if (status === 429) {
    finalStatus = 429;
    const bodyErr = error?.body?.error ?? error?.body ?? {};
    const retryRaw =
      bodyErr?.retry_after_s ??
      bodyErr?.retry_after ??
      error?.body?.retry_after_s ??
      error?.body?.retry_after ??
      60;
    headers.set("retry-after", String(Math.max(1, Number(retryRaw) || 60)));
    if (/session_limit/i.test(`${code} ${message}`)) {
      headers.set("x-magpie-retry", "backoff");
    } else {
      headers.set("x-magpie-failover", "true"); // 日额度耗尽 → magpie 换下一个账号
    }
  } else if (status === 503 || /saturated|upstream_busy/i.test(`${code} ${message}`)) {
    finalStatus = 503;
    const bodyErr = error?.body?.error ?? error?.body ?? {};
    const retryRaw = bodyErr?.retry_after_s ?? error?.body?.retry_after_s ?? 5;
    headers.set("retry-after", String(Math.max(1, Number(retryRaw) || 5)));
  } else if (status >= 500) {
    finalStatus = status;
  }

  const body = {
    error: {
      message: redact(message || errorText(error)),
      type: error?.type || "upstream_error",
      code: code || String(status),
    },
  };
  if (signIn) body.error.sign_in = signIn;
  if (error?.body?.reset_at) body.error.reset_at = error.body.reset_at;
  return errorResponse(finalStatus, body.error.message, body.error.type, body.error.code, headers);
}

/**
 * 生成 loader 用的 fetch。
 * @param {() => any} getAuth 返回当前账号登录态
 * @param {{base?:string,modelsPath?:string,fetchImpl?:Function,signal?:AbortSignal}} opts
 */
export function createFetch(getAuth, opts = {}) {
  const base = String(opts.base || BASE).replace(/\/+$/, "");
  const modelsPath = opts.modelsPath || MODELS_PATH;
  const upstreamFetch = opts.fetchImpl || globalThis.fetch;
  const staticTable = staticModelTable();

  return async function magpieFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const externalSignal = init?.signal ?? opts.signal;

    // GET /models：本地应答，免得每次都打上游 + 顺带鉴权校验都由登录阶段做了
    if (isModelsRequest(url) && (init?.method ?? "GET").toUpperCase() === "GET") {
      const auth = await getAuth();
      const key = apiKeyOf(auth);
      if (!key) {
        return errorResponse(401, "未登录或 Key 缺失", "sign_in_required", "missing_api_key", {
          "x-magpie-sign-in": "expired",
        });
      }
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      headers.set("cache-control", "no-store");
      const data = Object.values(staticTable).map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "100milionseek",
        name: m.name,
        limit: m.limit,
      }));
      return jsonResponse({ object: "list", data }, { status: 200, headers });
    }

    const auth = await getAuth();
    const key = apiKeyOf(auth);
    if (!key) {
      return errorResponse(401, "未登录或 Key 缺失", "sign_in_required", "missing_api_key", {
        "x-magpie-sign-in": "expired",
      });
    }

    const headers = cleanHeaders(init);
    headers.set("authorization", `Bearer ${key}`);

    const target = /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith("/") ? url : `/${url}`}`;
    const timeoutMs = isChatRequest(url) ? CHAT_TIMEOUT_MS : VERIFY_TIMEOUT_MS;
    let signal;
    try {
      signal = timeoutSignal(timeoutMs, externalSignal);
    } catch {
      signal = externalSignal;
    }

    let res;
    try {
      res = await upstreamFetch(target, { ...init, headers, signal });
    } catch (e) {
      if (isAbort(e) && externalSignal?.aborted) throw abortError();
      return translateError(new ApiError(errorText(e), { status: 0, cause: e }));
    }

    if (!res?.ok) {
      let body = null;
      try {
        const text = await res.clone().text();
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 300) };
        }
      } catch {
        /* ignore */
      }
      const err = new ApiError(body?.error?.message || body?.message || `HTTP ${res?.status}`, {
        status: res?.status ?? 0,
        code: body?.error?.code || body?.code || "",
        type: body?.error?.type || body?.type || "",
        body,
      });
      if (res?.status === 401) err.signIn = "expired";
      return translateError(err);
    }

    // 成功响应：把配额响应头透传出去，Usage hook 也能读到
    const outHeaders = new Headers(res.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    quotaHeadersInto(outHeaders, res.headers);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders });
  };
}
