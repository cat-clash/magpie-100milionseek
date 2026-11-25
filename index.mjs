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
import { staticModelTable, fetchModelTable, mergeModelTables } from "./src/models.mjs";
import { createUsage } from "./src/usage.mjs";
import { redact } from "./src/http.mjs";

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
    liveModelList: raw.liveModelList !== false,
    modelListTtlMs: clampInt(
      raw.modelListTtlMs,
      CLAMP.modelListTtlMs[0],
      CLAMP.modelListTtlMs[1],
      DEFAULTS.modelListTtlMs
    ),
    importMax: clampInt(raw.importMax, CLAMP.importMax[0], CLAMP.importMax[1], DEFAULTS.importMax),
    keyLabel: typeof raw.keyLabel === "string" ? raw.keyLabel.trim() : DEFAULTS.keyLabel,
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
        async fetch(input, init) {
          return createFetch(getAuth, { base: BASE })(input, init);
        },
      };
    },

    async usage(getAuth) {
      return createUsage(getAuth, {
        base: BASE,
        ttlMs: opts.usageCacheMs,
      })();
    },

    // 注意：Magpie/OpenCode 宿主不会调用 import/importFrom；保留仅为兼容 future，
    // 真正的批量导入走 cli/import-keys.mjs（见 README）。
    async import(texts, context = {}) {
      const { entries, errors, stats } = parseCredentialBlob(texts, {
        max: opts.importMax,
        label: opts.keyLabel,
      });
      const verify = context.verify !== false;
      const results = [];
      const unique = dedupeEntries(entries);
      for (const entry of unique) {
        try {
          if (verify) {
            const check = await verifyApiKey(entry.apiKey);
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
      return { results, stats };
    },
    importFrom: "粘贴 Key 列表（每行一个，或一段含 hms- Key 的文本）",
    importFroms: ["paste", "text"],
  };

  const providerHook = {
    id: provider,
    async models(providerCfg, { auth } = {}) {
      const staticTable = staticModelTable();
      if (!opts.liveModelList) return staticTable;
      const key = apiKeyOf(auth) || apiKeyOf(await ctx.client?.auth?.get?.({ path: { id: provider } })?.catch?.(() => null));
      if (!key) return staticTable;
      const live = await fetchModelTable({
        base: BASE,
        modelsPath: MODELS_PATH,
        apiKey: key,
      });
      if (!live) return staticTable;
      return mergeModelTables(staticTable, live, providerCfg?.models);
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
  staticModelTable,
  fetchModelTable,
  mergeModelTables,
  createUsage,
  DEFAULTS,
  DEFAULT_MODEL,
  PROVIDER,
  BASE,
};
