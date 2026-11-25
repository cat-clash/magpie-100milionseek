// src/config.mjs — 100 Million Seek（100milionseek.top）Magpie 插件常量表。
// 硬规矩：本文件不 import 任何东西、不发请求、不读凭据；改任何值都要同步 README.md。

export const PROVIDER = "hms";
export const PROVIDER_NAME = "100 Million Seek";
export const VERSION = "1.0.0";

// ---- 上游端点（base 固定，不提供自定义入口）---------------------------------
export const BASE = "https://100milionseek.top/v1";
export const SDK = "@ai-sdk/openai-compatible";
export const DOCS_URL = "https://100milionseek.top/docs";
export const STATUS_URL = "https://100milionseek.top/status";

// ---- 路径 -------------------------------------------------------------------
export const MODELS_PATH = "/models"; // GET，需 Bearer，响应头带 x-quota-*
export const CHAT_PATH = "/chat/completions"; // POST，计入额度

// ---- Key 形态 ----------------------------------------------------------------
// 站点签发的 Key 形如 hms-xxxxxxxx。宽松一点便于「智能识别」时从整段文本里抓。
export const KEY_RE = /^hms-[A-Za-z0-9_\-]{6,}$/;
export const KEY_GLOBAL_RE = /hms-[A-Za-z0-9_\-]{6,}/g;

// ---- 模型 -------------------------------------------------------------------
export const DEFAULT_MODEL = "deepseek-v4.1-flash-free";
export const MODEL_CONTEXT = 198_000; // 198K
export const MODEL_OUTPUT = 64_000; // 64K

// ---- 配额（响应头，见 docs：x-quota-limit/used/remaining/reset）--------------
export const QUOTA_HEADERS = {
  limit: "x-quota-limit",
  used: "x-quota-used",
  remaining: "x-quota-remaining",
  reset: "x-quota-reset",
};
export const QUOTA_WINDOW_MS = 24 * 60 * 60_000; // 每账号每 UTC 日重置

// ---- 超时 / 缓存 ------------------------------------------------------------
export const CHAT_TIMEOUT_MS = 600_000;
export const VERIFY_TIMEOUT_MS = 15_000;
export const USAGE_TIMEOUT_MS = 15_000;
export const USAGE_TTL_MS = 30_000;
export const MODEL_LIST_TTL_MS = 60 * 60_000;

// ---- 并发：站点硬限每账号 5 个并行，第 6 个 429 ------------------------------
export const ACCOUNT_CONCURRENCY = 5;
export const IMPORT_CONCURRENCY = 4;

// ---- options（README「插件配置」表必须与这里一致）---------------------------
export const DEFAULTS = {
  providerId: "", // 空 = PROVIDER (hms)
  maxConcurrency: ACCOUNT_CONCURRENCY,
  usageCacheMs: USAGE_TTL_MS,
  liveModelList: true,
  modelListTtlMs: MODEL_LIST_TTL_MS,
  importMax: 200,
  keyLabel: "",
};

export const CLAMP = {
  maxConcurrency: [1, 1000],
  usageCacheMs: [10_000, 600_000],
  modelListTtlMs: [60_000, 24 * 60 * 60_000],
  importMax: [1, 1000],
  providerIdPrefix: 40,
};

// 供应商 id 只能含小写字母、数字、连字符
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// 与 package.json 的 magpie.icon 逐字节一致（有测试断言）。
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzBiMTEyMCIvPjxwYXRoIGQ9Ik0xMyA0MWw5LTE4IDkgMTggOS0xOCA5IDE4IiBmaWxsPSJub25lIiBzdHJva2U9IiMzOGJkZjgiIHN0cm9rZS13aWR0aD0iNC41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjIzIiByPSIzLjIiIGZpbGw9IiNhNzhiZmEiLz48L3N2Zz4=";

export const USER_AGENT = `magpie-100milionseek/${VERSION} (+https://100milionseek.top/docs)`;
