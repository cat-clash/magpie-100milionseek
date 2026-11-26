/**
 * magpie-100milionseek — 100 Million Seek (100milionseek.top) 的 Magpie provider 插件。
 *
 * 只做一件事：把站的 hms- API Key 变成 magpie 里能登录、能用的模型供应商。
 * - 登录：只填 Key（GET /v1/models 校验），base 固定 https://100milionseek.top/v1。
 * - 批量导入：Magpie 宿主没有 auth.import hook，所以走独立 CLI（见 README +
 *   cli/import-keys.mjs），直接把多个 Key 写成 plugin-auth.json 的 hms / hms#slot 条目。
 *
 * 导出说明：Magpie 把「导出的每个函数」都当插件调用，故只导出一个工厂函数，
 * 测试用的内部对象叫 _internal（非函数）。
 *
 * 延迟/吞吐要点（相对上一版）：
 * - loader 的 fetch 只建一次（旧版每次请求都 createFetch，重复建闭包 + 重算模型表）。
 * - usage 缓存从「每次 hook 新建实例」改成进程级单例 + singleflight + 失败回退旧值。
 * - 模型表带 TTL + 单飞，且 GET /v1/models 直接命中进程内缓存，不再打上游。
 */
import {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  SDK,
  DOCS_URL,
  MODELS_PATH,
  DEFAULT_MODEL,
  DEFAULTS,
  CLAMP,
  PROVIDER_ID_RE,
  ICON,
  ACCOUNT_CONCURRENCY,
  MODEL_LIST_TTL_MS,
  USAGE_TTL_MS,
  USAGE_TIMEOUT_MS,
} from "./src/config.mjs";
import { parseCredentialBlob, dedupeEntries, isValidKey } from "./src/bulk-import.mjs";
import {
  keyOnlyLogin,
  apiKeyOf,
  verifyApiKey,
  successAuth,
  failedAuth,
  accountLabelOf,
  uidOf,
} from "./src/auth.mjs";
import { createFetch } from "./src/relay.mjs";
import { createKeyPool } from "./src/key-pool.mjs";
import {
  staticModelTable,
  fetchModelTable,
  mergeModelTables,
  cachedModelTable,
  peekModelTable,
  parseModelList,
  isChatModel,
} from "./src/models.mjs";
import { createUsage } from "./src/usage.mjs";
import { redact } from "./src/http.mjs";
import { getUpstreamDispatcher, ensureUpstreamDispatcher, poolInfo } from "./src/pool.mjs";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 收口所有 options；未知字段忽略，默认值来自 config。 */
function readOptions(raw = {}) {
  const providerId =
    typeof raw.providerId === "string" && PROVIDER_ID_RE.test(raw.providerId.trim())
      ? raw.providerId.trim().toLowerCase()
      : DEFAULTS.providerId;
  return {
    providerId,
    maxConcurrency: clampInt(
      raw.maxConcurrency,
      CLAMP.maxConcurrency[0],
      CLAMP.maxConcurrency[1],
      DEFAULTS.maxConcurrency
    ),
    usageCacheMs: clampInt(
      raw.usageCacheMs,
      CLAMP.usageCacheMs[0],
      CLAMP.usageCacheMs[1],
      DEFAULTS.usageCacheMs
    ),
    usageTimeoutMs: clampInt(
      raw.usageTimeoutMs,
      CLAMP.usageTimeoutMs[0],
      CLAMP.usageTimeoutMs[1],
      DEFAULTS.usageTimeoutMs
    ),
    liveModelList: raw.liveModelList !== false,
    modelListTtlMs: clampInt(
      raw.modelListTtlMs,
      CLAMP.modelListTtlMs[0],
      CLAMP.modelListTtlMs[1],
      DEFAULTS.modelListTtlMs
    ),
    importMax: clampInt(raw.importMax, CLAMP.importMax[0], CLAMP.importMax[1], DEFAULTS.importMax),
    keyLabel: typeof raw.keyLabel === "string" ? raw.keyLabel.trim() : DEFAULTS.keyLabel,
    debugTiming: raw.debugTiming === true,
    // 工具裁剪名单：精确名或 "前缀*"
    dropTools: Array.isArray(raw.dropTools)
      ? raw.dropTools.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
      : DEFAULTS.dropTools,
    // "direct" | "http://..." | ""（跟环境变量）
    proxy:
      raw.proxy === "direct"
        ? "direct"
        : typeof raw.proxy === "string"
          ? raw.proxy.trim()
          : DEFAULTS.proxy,
    // 429 并发限流时插件内重试次数（0 = 关，直接交给宿主）
    sessionRetry: clampInt(
      raw.sessionRetry,
      CLAMP.sessionRetry[0],
      CLAMP.sessionRetry[1],
      DEFAULTS.sessionRetry
    ),
    // 429 时插件内换 Key 重发（不依赖宿主是否认识 x-magpie-failover）
    keyFailover: raw.keyFailover !== false,
  };
}

/**
 * 插件工厂。
 * @param {object} input Magpie/OpenCode 注入（client、directory、serverUrl 等）
 * @param {object} options plugins.json 的 options
 */
export const HundredMillionSeekPlugin = async (input = {}, options = {}) => {
  const opts = readOptions(options);
  const provider = opts.providerId || PROVIDER;
  const ctx = input ?? {};

  const log = (...args) => {
    try {
      ctx.client?.app?.log?.("[hms]", ...args);
    } catch {
      /* ignore */
    }
  };

  // 进程内共享连接池：拿得到就用，拿不到下次再说（不阻塞首次请求太久）
  let dispatcher = getUpstreamDispatcher();
  if (!dispatcher) {
    dispatcher = await ensureUpstreamDispatcher();
    if (dispatcher) log(`上游连接池已启用：${JSON.stringify(poolInfo())}`);
  }

  // 429 换号用的 Key 池：读 Magpie 登录态文件，按 provider 取同站的其他 hms- Key。
  // 只在插件工厂构造一次；读盘有 30s 缓存，不进请求热路径。
  const keyPool = opts.keyFailover ? createKeyPool(provider) : null;
  const fallbackKeysFor = (currentKey) => keyPool?.candidates(currentKey) ?? [];

  // loader 的 fetch 只创建一次，后续所有请求复用同一闭包。
  // 按 getAuth 函数引用缓存：宿主给每个账号传不同 getAuth 时不会串号；
  // 宿主对同一账号重复调用时仍然复用同一个 fetch 闭包。
  const fetchCache = new Map();
  const fetchFor = (getAuth) => {
    let sharedFetch = fetchCache.get(getAuth);
    if (!sharedFetch) {
      sharedFetch = createFetch(getAuth, {
        base: BASE,
        modelsPath: MODELS_PATH,
        dispatcher,
        debugTiming: opts.debugTiming,
        dropTools: opts.dropTools,
        proxy: opts.proxy,
        sessionRetry: opts.sessionRetry,
        keyFailover: opts.keyFailover,
        fallbackKeys: fallbackKeysFor,
      });
      fetchCache.set(getAuth, sharedFetch);
    }
    return sharedFetch;
  };

  // usage hook：缓存挂在模块级 store 上（跨实例共享），这里只省闭包构造。
  // 同样按 getAuth 引用缓存，避免多账号额度互相读错。
  const usageCache = new Map();
  const usageFor = (getAuth) => {
    let sharedUsage = usageCache.get(getAuth);
    if (!sharedUsage) {
      sharedUsage = createUsage(getAuth, {
        base: BASE,
        ttlMs: opts.usageCacheMs,
        timeoutMs: opts.usageTimeoutMs,
        dispatcher,
        proxy: opts.proxy === "direct" ? false : opts.proxy || undefined,
      });
      usageCache.set(getAuth, sharedUsage);
    }
    return sharedUsage;
  };

  const authHook = {
    provider,
    maxConcurrency: Math.min(ACCOUNT_CONCURRENCY, opts.maxConcurrency),
    icon: ICON,

    methods: [
      {
        type: "api",
        label: "API Key",
        placeholder: "hms-…",
        prompts: [
          {
            type: "password",
            key: "key",
            message: "100 Million Seek API Key",
            placeholder: "hms-xxxxxxxxxxxx",
            validate: (v) => (isValidKey(v) ? true : "Key 应以 hms- 开头（至少 6 位）"),
          },
        ],
        async authorize(inputs = {}) {
          const result = await keyOnlyLogin(inputs, { defaultLabel: opts.keyLabel });
          if (result.type === "success") {
            log(`账号已登录：${accountLabelOf(result.key, result.metadata?.label)}`);
          }
          return result;
        },
      },
    ],

    async loader(getAuth) {
      return {
        baseURL: BASE,
        // 复用同一个函数引用；宿主每次 model 调用都会走它
        fetch: fetchFor(getAuth),
      };
    },

    async usage(getAuth) {
      return usageFor(getAuth)();
    },

    // Magpie 宿主 importFiles 契约：auth.import(texts, { signal }) 返回
    // [{type:"success",key,metadata} | {type:"failed",error}] 数组，
    // 宿主逐条 save() 到 plugin-auth.json。CLI 仍是更快的批量通道。
    async import(texts, context = {}) {
      const list = Array.isArray(texts) ? texts : [texts];
      const blob = list.filter((t) => typeof t === "string").join("\n");
      const { entries, errors } = parseCredentialBlob(blob, {
        max: opts.importMax,
        label: opts.keyLabel,
      });
      const verify = context.verify !== false;
      const proxyOpt = opts.proxy === "direct" ? false : opts.proxy || undefined;
      const results = [];
      const unique = dedupeEntries(entries);
      for (const entry of unique) {
        try {
          if (verify) {
            const check = await verifyApiKey(entry.apiKey, { proxy: proxyOpt, signal: context.signal });
            if (!check.ok) {
              results.push({ type: "failed", error: `${accountLabelOf(entry.apiKey, entry.label)}：${check.reason}` });
              continue;
            }
          }
          results.push(successAuth(entry.apiKey, { label: entry.label }));
        } catch (e) {
          results.push({ type: "failed", error: `${accountLabelOf(entry.apiKey, entry.label)}：${redact(e?.message ?? e)}` });
        }
      }
      for (const err of errors) {
        results.push({ type: "failed", error: `第 ${err.line || "?"} 行：${err.reason}` });
      }
      return results;
    },
    importFrom: "粘贴 Key 列表（每行一个，或一段含 hms- Key 的文本）",
    importFroms: {
      zh: "粘贴 Key 列表（每行一个 hms- Key，支持混排/备注/JSON，自动去重）",
      en: "Paste keys, one hms- per line (notes, JSON and mixed text are fine)",
    },
  };

  const providerHook = {
    id: provider,
    async models(providerCfg, { auth } = {}) {
      const staticTable = staticModelTable();
      if (!opts.liveModelList) return staticTable;
      let key = apiKeyOf(auth);
      if (!key) {
        const stored = await ctx.client?.auth?.get?.({ path: { id: provider } })?.catch?.(() => null);
        key = apiKeyOf(stored);
      }
      if (!key) return staticTable;
      // 带 TTL + 单飞 + 失败回退：连续打开模型列表不会每次都打上游
      const { table } = await cachedModelTable({
        base: BASE,
        modelsPath: MODELS_PATH,
        apiKey: key,
        ttlMs: opts.modelListTtlMs,
        dispatcher,
        proxy: opts.proxy === "direct" ? false : opts.proxy || undefined,
      });
      if (!table) return mergeModelTables(staticTable, peekModelTable() ?? {}, providerCfg?.models);
      return mergeModelTables(staticTable, table, providerCfg?.models);
    },
  };

  return {
    config(cfg) {
      cfg.provider ??= {};
      cfg.provider[provider] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModelTable(),
        doc: DOCS_URL,
        options: {},
      };
    },
    auth: authHook,
    provider: providerHook,
  };
};

/** 非函数，测试用；Magpie 不会把它当插件调用。 */
export const _internal = {
  readOptions,
  parseCredentialBlob,
  dedupeEntries,
  isValidKey,
  verifyApiKey,
  keyOnlyLogin,
  successAuth,
  failedAuth,
  apiKeyOf,
  createFetch,
  createKeyPool,
  staticModelTable,
  fetchModelTable,
  mergeModelTables,
  cachedModelTable,
  peekModelTable,
  parseModelList,
  isChatModel,
  createUsage,
  poolInfo,
  DEFAULTS,
  DEFAULT_MODEL,
  PROVIDER,
  BASE,
  MODEL_LIST_TTL_MS,
  USAGE_TTL_MS,
  USAGE_TIMEOUT_MS,
};
