// src/relay.mjs — loader 的 fetch 包装：只拦 /models，其余原样转发上游。
// 错误按站点返回码分档：401 → sign-in expired；429 quota → 换账号；429 session → 退避。
//
// 延迟相关要点（本文件是热路径，每个请求都走这里）：
// 1. createFetch 由 index.mjs 建一次并复用，不再每次 fetch 重新构造闭包/模型表。
// 2. GET /models 直接读进程内模型表缓存（TTL 由 provider hook 维护），零上游请求。
// 3. 成功路径是「Response 直通」，不 clone、不读 body；只有失败分支读一次 text()。
// 4. 有 undici 时挂共享 dispatcher（连接复用）；没有就完全不传该字段。
// 5. debugTiming 打开才打点，关闭时零分支开销（timing.enabled 为 false 直接 return）。
import {
  BASE,
  CHAT_PATH,
  MODELS_PATH,
  CHAT_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  QUOTA_HEADERS,
  DEFAULTS,
  SESSION_RETRY_MAX,
  SESSION_RETRY_BASE_MS,
  SESSION_RETRY_MAX_WAIT_MS,
  KEY_FAILOVER_MAX,
  BUSY_RETRY_BASE_MS,
} from "./config.mjs";
import { apiKeyOf } from "./auth.mjs";
import { staticModelTable, peekModelTable } from "./models.mjs";
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
import { createTiming, tapStream } from "./timing.mjs";
import { getUpstreamDispatcher, ensureUpstreamDispatcher } from "./pool.mjs";

function tailOf(url) {
  try {
    const u = new URL(String(url), "http://local");
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(url).split("?")[0];
  }
}

// ---- dropTools：转发层裁工具（system prompt 动不了，tools 是唯一能安全瘦身的地方）----
function toolNameOf(t) {
  return String(t?.function?.name ?? t?.name ?? "");
}

/** 从 chat 请求体里剔除命中规则的 tools。任何异常都回退原始 body。 */
export function dropToolsFromBody(raw, rules) {
  try {
    if (typeof raw !== "string" || !raw || !Array.isArray(rules) || rules.length === 0) return raw;
    const j = JSON.parse(raw);
    if (!Array.isArray(j?.tools) || j.tools.length === 0) return raw;
    const hit = (name) =>
      rules.some((r) => (r.endsWith("*") ? name.startsWith(r.slice(0, -1)) : name === r));
    const kept = j.tools.filter((t) => !hit(toolNameOf(t)));
    if (kept.length === j.tools.length) return raw;
    j.tools = kept;
    return JSON.stringify(j);
  } catch {
    return raw;
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

/** 未登录统一出口，两处调用共用一份响应构造。 */
function missingKeyResponse() {
  return errorResponse(401, "未登录或 Key 缺失", "sign_in_required", "missing_api_key", {
    "x-magpie-sign-in": "expired",
  });
}

/** 把站点错误翻成 magpie 能理解的分档。 */
function translateError(error) {
  const status = error?.status ?? 0;
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  const bodyErr = error?.body?.error ?? error?.body ?? {};
  const headers = new Headers();
  let finalStatus = status || 500;
  let signIn = "";
  const retryRawOf = (...values) => {
    for (const v of values) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };

  if (status === 401 || /invalid_api_key|missing_api_key|unauthorized/i.test(`${code} ${message}`)) {
    finalStatus = 401;
    signIn = "expired";
    headers.set("x-magpie-sign-in", "expired");
  } else if (status === 429) {
    finalStatus = 429;
    if (/session_limit/i.test(`${code} ${message}`)) {
      // 并发槽位满（站点硬限 5/账号）。插件内已经重试过了，这里仍返回说明真挤：
      // 同时挂 failover —— 池子里还有别的账号，换号比让这个账号干等更快。
      const wait = retryRawOf(bodyErr?.retry_after_s, bodyErr?.retry_after, 2);
      headers.set("retry-after", String(Math.max(1, Math.min(30, Math.round(wait)))));
      headers.set("x-magpie-retry", "backoff");
      headers.set("x-magpie-failover", "true");
    } else {
      const retryRaw = retryRawOf(
        bodyErr?.retry_after_s,
        bodyErr?.retry_after,
        error?.body?.retry_after_s,
        error?.body?.retry_after,
        60,
      );
      headers.set("retry-after", String(Math.max(1, retryRaw)));
      headers.set("x-magpie-failover", "true"); // 日额度耗尽 → magpie 换下一个账号
    }
  } else if (status === 503 || /saturated|upstream_busy/i.test(`${code} ${message}`)) {
    finalStatus = 503;
    // 站点的 retry-after 头（如 upstream_busy 的 20s）原样透传给宿主；拿不到再兜底 5s
    const retryRaw = retryRawOf(bodyErr?.retry_after_s, error?.retryAfterHeader, 5);
    headers.set("retry-after", String(Math.max(1, retryRaw)));
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

/** 429 里「并发槽位满」这一类：等一下就有位置，值得插件内重试。 */
function isSessionLimited(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return error?.status === 429 && /session_limit/i.test(`${code} ${message}`);
}

/**
 * 503 upstream_busy / upstream_saturated（2026-11-27 真机实测的重载形态）：
 * 站点过载时连 5 并发以内也会随机吃到 503，带 retry-after: 20，docs 明说
 * "Retry after the Retry-After seconds"。与 429 同属「等一等再打」的可重试类。
 * 换号也合理：别的账号可能正好分到不忙的节点。
 */
function isUpstreamBusy(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return error?.status === 503 && /upstream_busy|upstream_saturated/i.test(`${code} ${message}`);
}

/** 判定这次失败要不要进「等一等再打」的重试链（429 并发 / 503 过载）。 */
function isTransient(error) {
  return isSessionLimited(error) || isUpstreamBusy(error);
}

/** 从错误里读站点建议的等待秒数（retry-after 头 → body.retry_after_s → 兜底）。 */
function suggestedWaitSec(error) {
  const bodyErr = error?.body?.error ?? error?.body ?? {};
  for (const v of [bodyErr?.retry_after_s, bodyErr?.retry_after, error?.retryAfterHeader]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return isSessionLimited(error) ? 1 : 5;
}

/**
 * 请求体能不能重发。
 * host 传进来的通常是 string / Buffer；ReadableStream 这种一次性 body 不能重试
 * （再发一次会是空 body），退化成直接返回 429。
 */
function isReplayableBody(body) {
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(body))
  );
}

/** 指数退避 + ±20% jitter；外部 abort 时立刻结束等待。 */
function retryWaitMs(attempt) {
  const base = SESSION_RETRY_BASE_MS * 2 ** attempt;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1, Math.min(SESSION_RETRY_MAX_WAIT_MS, Math.round(base + jitter)));
}

function sleepMs(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(abortError());
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * 生成 loader 用的 fetch。**调用方应建一次并复用**。
 * @param {() => any} getAuth 返回当前账号登录态
 * @param {{base?:string,modelsPath?:string,fetchImpl?:Function,signal?:AbortSignal,
 *          dispatcher?:object,debugTiming?:boolean,dropTools?:string[],
 *          timingSink?:(line:string)=>void}} opts
 */
export function createFetch(getAuth, opts = {}) {
  const base = String(opts.base || BASE).replace(/\/+$/, "");
  const modelsPath = opts.modelsPath || MODELS_PATH;
  const upstreamFetch = opts.fetchImpl || globalThis.fetch;
  // 模型表在闭包里只快照一次；静态表本身不可变，在线刷新由 provider hook 写入 peekModelTable()
  const staticTable = staticModelTable();
  const staticListBody = Object.freeze({ object: "list", data: buildModelList(staticTable) });
  const debugTiming = opts.debugTiming === true;
  const dropRules = Array.isArray(opts.dropTools)
    ? opts.dropTools.filter((s) => typeof s === "string" && s)
    : [];
  // 429 并发限流 / 503 过载：插件内重试几次（默认 2；0 = 关掉）
  const sessionRetryMax = Number.isFinite(Number(opts.sessionRetry))
    ? Math.max(0, Math.min(5, Math.trunc(Number(opts.sessionRetry))))
    : SESSION_RETRY_MAX;
  // 503 upstream_busy 的退避基准：站点建议 20s，等满太久；按 docs 打折等（默认 5s 起步）
  const busyRetryBaseMs = Number.isFinite(Number(opts.busyRetryBaseMs))
    ? Math.max(1, Math.min(30_000, Math.trunc(Number(opts.busyRetryBaseMs))))
    : BUSY_RETRY_BASE_MS;

  // 429 时插件内换 Key 重发：opts.fallbackKeys(currentKey) → 其它 Key 数组
  // 由 index.mjs 从 plugin-auth.json 构造；传 null/不传 = 不换号（测试可精确控制）
  const fallbackKeys = typeof opts.fallbackKeys === "function" ? opts.fallbackKeys : null;
  const keyFailoverMax = opts.keyFailover === false
    ? 0
    : Number.isFinite(Number(opts.keyFailoverMax))
      ? Math.max(0, Math.min(10, Math.trunc(Number(opts.keyFailoverMax))))
      : KEY_FAILOVER_MAX;

  return async function magpieFetch(input, init = {}) {
    const timing = debugTiming ? createTiming({ enabled: true, sink: opts.timingSink }) : null;
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const externalSignal = init?.signal ?? opts.signal;
    const path = tailOf(url);

    // GET /models：本地应答。优先用 provider hook 刷进缓存的在线表，否则静态表。
    if (isModelsRequest(url) && (init?.method ?? "GET").toUpperCase() === "GET") {
      const auth = await getAuth();
      if (!apiKeyOf(auth)) return missingKeyResponse();
      const live = peekModelTable();
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      headers.set("cache-control", "no-store");
      const payload = live ? { object: "list", data: buildModelList(live) } : staticListBody;
      timing?.finish(path, 200);
      return jsonResponse(payload, { status: 200, headers });
    }

    const auth = await getAuth();
    const key = apiKeyOf(auth);
    if (!key) return missingKeyResponse();

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

    // 请求体：默认原样透传；配置了 dropTools 才在转发层裁工具（只动 body.tools）
    let body = init?.body;
    if (dropRules.length && body && isChatRequest(url)) {
      body = dropToolsFromBody(body, dropRules);
    }
    const reqInit = { ...init, headers, signal };
    if (body !== init?.body) reqInit.body = body;
    // 同步拿共享连接池；第一次拿不到就异步补一次（本次仍走运行时默认池）
    let dispatcher = opts.dispatcher ?? getUpstreamDispatcher();
    if (!dispatcher) dispatcher = await ensureUpstreamDispatcher();
    if (dispatcher) reqInit.dispatcher = dispatcher;
    else delete reqInit.dispatcher;
    // 代理策略：direct = 强制直连（Bun 唯一可靠写法 proxy:false）；URL = 指定代理；空 = 跟随 env。
    if (opts.proxy === "direct") reqInit.proxy = false;
    else if (typeof opts.proxy === "string" && opts.proxy) reqInit.proxy = opts.proxy;
    else delete reqInit.proxy;

    let currentKey = key;
    let res;
    const replayable = isReplayableBody(body ?? init?.body);
    const canRetrySession = replayable && sessionRetryMax > 0;
    const canFailoverKey = replayable && keyFailoverMax > 0 && Boolean(fallbackKeys);
    const triedKeys = new Set([key]);
    let sessionAttempt = 0;
    let busyAttempt = 0;
    let keyAttempt = 0;
    for (;;) {
      try {
        res = await upstreamFetch(target, reqInit);
      } catch (e) {
        if (isAbort(e) && externalSignal?.aborted) throw abortError();
        timing?.finish(path, 0);
        return translateError(new ApiError(errorText(e), { status: 0, cause: e }));
      }
      if (res?.ok) break;

      // 失败分支不需要保留 body，直接读 text（不 clone，省一次 tee）
      let text = "";
      try {
        text = await res.text();
      } catch {
        /* ignore */
      }
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.slice(0, 300) };
        }
      }
      const err = new ApiError(parsed?.error?.message || parsed?.message || `HTTP ${res?.status}`, {
        status: res?.status ?? 0,
        code: parsed?.error?.code || parsed?.code || "",
        type: parsed?.error?.type || parsed?.type || "",
        body: parsed,
      });
      // 站点原始 retry-after 头挂到错误上：translateError 原样透传给宿主
      try {
        const ra = res?.headers?.get?.("retry-after");
        if (ra) err.retryAfterHeader = ra;
      } catch {
        /* headers 不可读就算了 */
      }
      if (res?.status === 401) err.signIn = "expired";

      if (err.status === 429 && !externalSignal?.aborted) {
        if (isSessionLimited(err)) {
          // ① 同账号短退避：并发槽位满（每账号 5 并发），等一下通常就有位置
          if (canRetrySession && sessionAttempt < sessionRetryMax) {
            const wait = retryWaitMs(sessionAttempt);
            sessionAttempt += 1;
            try {
              await sleepMs(wait, externalSignal);
            } catch {
              if (externalSignal?.aborted) throw abortError();
            }
            continue;
          }
        }
        // ② 换一把 Key 重发：不依赖 magpie 宿主认不认 x-magpie-failover。
        //    session 类重试已耗尽、日额度直接耗尽（daily_quota_exceeded，不等 reset）
        //    —— 都换号，另一把 Key 是独立的额度与并发槽位。
        if (canFailoverKey && keyAttempt < keyFailoverMax) {
          const pool = fallbackKeys(currentKey);
          const nextKey = Array.isArray(pool)
            ? pool.find((candidate) => typeof candidate === "string" && candidate && !triedKeys.has(candidate))
            : null;
          if (nextKey) {
            triedKeys.add(nextKey);
            currentKey = nextKey;
            keyAttempt += 1;
            sessionAttempt = 0; // 新账号给它自己的重试额度
            headers.set("authorization", `Bearer ${nextKey}`); // reqInit.headers 是同一个对象
            continue;
          }
        }
      } else if (err.status === 503 && isUpstreamBusy(err) && !externalSignal?.aborted) {
        // ① 同账号退避：站点过载（实测 ≤5 并发也随机吃到 503 upstream_busy，retry-after:20）。
        //    不用等满 20s：按 5s 基准翻倍等，等的同时别的请求会消化掉队列。
        if (canRetrySession && busyAttempt < sessionRetryMax) {
          const base = busyRetryBaseMs * 2 ** busyAttempt;
          busyAttempt += 1;
          try {
            await sleepMs(base + Math.round(base * 0.2 * (Math.random() * 2 - 1)), externalSignal);
          } catch {
            if (externalSignal?.aborted) throw abortError();
          }
          continue;
        }
        // ② 换 Key：另一把 Key 可能正打在不忙的节点上（无粘性，值得一试）。
        if (canFailoverKey && keyAttempt < keyFailoverMax) {
          const pool = fallbackKeys(currentKey);
          const nextKey = Array.isArray(pool)
            ? pool.find((candidate) => typeof candidate === "string" && candidate && !triedKeys.has(candidate))
            : null;
          if (nextKey) {
            triedKeys.add(nextKey);
            currentKey = nextKey;
            keyAttempt += 1;
            busyAttempt = 0;
            headers.set("authorization", `Bearer ${nextKey}`);
            continue;
          }
        }
      }

      timing?.finish(path, res?.status ?? 0);
      return translateError(err);
    }

    // 成功响应：Response 直通。headers 只做必要修补，body 不碰（除非 debugTiming 打点）。
    // res.headers 已经是 Headers 实例，直接改它比重建一份再复制便宜，且不影响 body 流。
    let outHeaders = res.headers;
    try {
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-length");
      quotaHeadersInto(outHeaders, res.headers);
    } catch {
      // 少数运行时的 headers 是只读的，退回复制一份
      outHeaders = new Headers(res.headers);
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-length");
      quotaHeadersInto(outHeaders, res.headers);
    }

    const outBody = timing ? tapStream(res.body, timing) : res.body;
    const out = new Response(outBody, { status: res.status, statusText: res.statusText, headers: outHeaders });
    // 只打点不等待：body 还没消费完，finish 由 tapStream 在流结束时输出总耗时
    return out;
  };
}

/** 把模型表转成 OpenAI /v1/models 的 data 数组（只在表变化时算一次）。 */
function buildModelList(table) {
  return Object.values(table).map((m) => ({
    id: m.id,
    object: "model",
    owned_by: "100milionseek",
    name: m.name,
    limit: m.limit,
  }));
}
