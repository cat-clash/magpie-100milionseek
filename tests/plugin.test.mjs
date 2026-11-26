import test from "node:test";
import assert from "node:assert/strict";
import {
  HundredMillionSeekPlugin,
  _internal,
} from "../index.mjs";
import { parseCredentialBlob, dedupeEntries, isValidKey } from "../src/bulk-import.mjs";
import { redact, maskKey } from "../src/http.mjs";
import { buildUsage } from "../src/usage.mjs";
import { authBody, uidOf, apiKeyOf } from "../src/auth.mjs";
import { staticModelTable, mergeModelTables } from "../src/models.mjs";

const KEY_A = "hms-abcdef123456";
const KEY_B = "hms-zyxwvu987654";

test("只导出工厂 + 非函数 _internal（readOptions 不再是独立导出）", async () => {
  const mod = await import("../index.mjs");
  for (const [name, value] of Object.entries(mod)) {
    if (name === "_internal") {
      assert.equal(typeof value, "object", "_internal 必须是非函数对象");
      continue;
    }
    assert.equal(typeof value, "function", `导出 ${name} 必须是函数`);
  }
  assert.equal(Object.keys(mod).includes("readOptions"), false);
});

test("工厂返回 config/auth/provider 三个 hook，且 provider id= hms", async () => {
  const hooks = await HundredMillionSeekPlugin({}, {});
  assert.ok(hooks.config && hooks.auth && hooks.provider);
  const cfg = { provider: {} };
  hooks.config(cfg);
  assert.equal(cfg.provider.hms.name, "100 Million Seek");
  assert.equal(cfg.provider.hms.api, "https://100milionseek.top/v1");
  assert.equal(cfg.provider.hms.npm, "@ai-sdk/openai-compatible");
  assert.ok(cfg.provider.hms.models["deepseek-v4.1-flash-free"]);
  assert.equal(hooks.auth.provider, "hms");
  assert.equal(hooks.auth.methods[0].type, "api");
});

test("自定义 providerId 生效（合法 id）", async () => {
  const hooks = await HundredMillionSeekPlugin({}, { providerId: "hms-pro" });
  const cfg = { provider: {} };
  hooks.config(cfg);
  assert.ok(cfg.provider["hms-pro"]);
  assert.equal(hooks.auth.provider, "hms-pro");
});

test("config 用 ??= 不覆盖用户已有配置", async () => {
  const hooks = await HundredMillionSeekPlugin({}, {});
  const cfg = { provider: { hms: { name: "Custom", api: "keep" } } };
  hooks.config(cfg);
  assert.equal(cfg.provider.hms.name, "Custom");
  assert.equal(cfg.provider.hms.api, "keep");
});

test("智能识别：一行一个 + 去重", () => {
  const r = parseCredentialBlob(`${KEY_A}\n${KEY_A}\n${KEY_B}`);
  assert.equal(r.stats.tokensFound, 3);
  assert.equal(r.stats.imported, 2);
  assert.equal(r.stats.duplicate, 1);
  assert.deepEqual(
    r.entries.map((e) => e.apiKey),
    [KEY_A, KEY_B]
  );
});

test("智能识别：备注/序号/分隔符/引号/JSON 都能抓", () => {
  const text = [
    "1. hms-aaaaaa111111  # 主账号",
    "备用, hms-bbbbbb222222",
    `["hms-cccccc333333", "hms-dddddd444444"]`,
    '{"key": "hms-eeeeee555555", "note":"x"}',
    `token: 'hms-ffffff666666'`,
  ].join("\n");
  const r = parseCredentialBlob(text);
  assert.equal(r.stats.imported, 6);
  assert.equal(r.stats.invalidShape, 0);
  assert.ok(r.entries.some((e) => e.label.includes("主账号")));
});

test("智能识别：注释行、空行、无 key 行被跳过并诊断", () => {
  const text = `# 这是注释\n\n${KEY_A}\n随便一行没有key\n// 另一个注释`;
  const r = parseCredentialBlob(text);
  assert.equal(r.stats.imported, 1);
  assert.equal(r.stats.linesWithoutKey, 1);
  assert.ok(r.errors.some((e) => e.reason.includes("未识别")));
});

test("形态校验：hms- 后至少 6 位", () => {
  assert.equal(isValidKey(KEY_A), true);
  assert.equal(isValidKey("hms-123"), false);
  assert.equal(isValidKey("sk-abcdef123456"), false);
  assert.equal(isValidKey("  hms-abcdef123456  "), true);
});

test("dedupeEntries 按指纹去重", () => {
  const list = [{ apiKey: KEY_A }, { apiKey: KEY_A }, { apiKey: KEY_B }];
  assert.equal(dedupeEntries(list).length, 2);
});

test("max 上限截断", () => {
  const text = Array.from({ length: 10 }, (_, i) => `hms-user${i}000000`).join("\n");
  const r = parseCredentialBlob(text, { max: 3 });
  assert.equal(r.stats.imported, 3);
  assert.equal(r.stats.truncated, 7);
});

test("脱敏：明文 Key 不出现在错误文案里", () => {
  const msg = `登录失败 key=${KEY_A} 已记录`;
  const safe = redact(msg);
  assert.equal(safe.includes(KEY_A), false);
  assert.ok(safe.includes("hms-"));
  assert.ok(maskKey(KEY_A).includes("…"));
});

test("登录态结构：authBody 扁平、用 type:api、uid 不含明文", () => {
  const body = authBody(KEY_A, { label: "测试" });
  assert.equal(body.type, "api");
  assert.equal(body.key, KEY_A);
  assert.equal(body.label, "测试");
  assert.equal(body.accountId.includes("hms-"), true);
  assert.equal(body.accountId.includes(KEY_A), false);
  assert.equal(uidOf(KEY_A), uidOf(KEY_A));
  assert.equal(apiKeyOf(body), KEY_A);
});

test("转发：GET /models 本地应答、用当前账号 key", async () => {
  const auth = authBody(KEY_A);
  const hooks = await HundredMillionSeekPlugin({}, {});
  const loader = await hooks.auth.loader(() => auth);
  const res = await loader.fetch("https://100milionseek.top/v1/models", { method: "GET" });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.data));
  assert.equal(data.data[0].id, "deepseek-v4.1-flash-free");
});

test("转发：未登录时 /models 返回 401 + sign_in expired", async () => {
  const hooks = await HundredMillionSeekPlugin({}, {});
  const loader = await hooks.auth.loader(() => null);
  const res = await loader.fetch("https://100milionseek.top/v1/models", { method: "GET" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
});

test("转发：401 invalid_api_key 翻成 sign-in expired", async () => {
  const hooks = await HundredMillionSeekPlugin({}, {});
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: { message: "invalid_api_key", code: "invalid_api_key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  const auth = authBody(KEY_A);
  // 直接测 relay 层
  const { createFetch } = _internal;
  const fetchFn = createFetch(() => auth, { fetchImpl: fakeFetch });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", {
    method: "POST",
    body: "{}",
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
});

test("转发：429 日额度耗尽触发 failover + retry-after", async () => {
  const { createFetch } = _internal;
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: { message: "daily quota exceeded", code: "daily_quota_exceeded", retry_after_s: 120 } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  const fetchFn = createFetch(() => authBody(KEY_A), { fetchImpl: fakeFetch });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-magpie-failover"), "true");
  assert.equal(res.headers.get("retry-after"), "120");
});

test("转发：成功响应透传 x-quota-* 头", async () => {
  const { createFetch } = _internal;
  const fakeFetch = async () =>
    new Response(JSON.stringify({ id: "x", choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-quota-remaining": "999" },
    });
  const fetchFn = createFetch(() => authBody(KEY_A), { fetchImpl: fakeFetch });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-quota-remaining"), "999");
});

test("配额窗口：从 x-quota-* 构造 magpie usage", () => {
  const usage = buildUsage({ limit: 100000000, used: 25000000, remaining: 75000000, resetsAt: Date.now() + 86400000 });
  assert.equal(usage.windows.length, 1);
  // used 必须是百分比(0-100)，不能是绝对 token 数，否则宿主按 25000000% 算成「剩余 0%」。
  assert.equal(usage.windows[0].used, 25);
  assert.equal(usage.windows[0].amount, 25000000);
  assert.equal(usage.windows[0].limit, 100000000);
  assert.ok(usage.windows[0].display.includes("25,000,000"));
  assert.ok(usage.windows[0].display.includes("75,000,000 tokens left"));
});

test("配额窗口：用量极小时 used 是接近 0 的百分比而不是绝对数", () => {
  const usage = buildUsage({ limit: 100000000, used: 626038, remaining: 99373962, resetsAt: Date.now() + 86400000 });
  assert.equal(usage.windows[0].used, 0.63);
  assert.equal(usage.windows[0].amount, 626038);
  assert.ok(usage.windows[0].used < 100, "used 绝不能是绝对 token 数");
  assert.ok(usage.windows[0].display.includes("99,373,962 tokens left"));
});

test("模型表：静态兜底 + 在线合并 + 保留用户改动", () => {
  const base = staticModelTable();
  assert.ok(base["deepseek-v4.1-flash-free"]);
  const merged = mergeModelTables(base, { "new-model": { id: "new-model", name: "New" } }, {
    "deepseek-v4.1-flash-free": { disabled: true, limit: { context: 1000 } },
  });
  assert.equal(merged["deepseek-v4.1-flash-free"].disabled, true);
  assert.equal(merged["deepseek-v4.1-flash-free"].limit.context, 1000);
  assert.ok(merged["new-model"]);
});

test("options 收口：非法值回退默认值", () => {
  const o = _internal.readOptions({ maxConcurrency: 99999, usageCacheMs: -1, providerId: "Bad_ID", liveModelList: false });
  assert.equal(o.maxConcurrency, 1000);
  assert.equal(o.usageCacheMs, 10000);
  assert.equal(o.providerId, "");
  assert.equal(o.liveModelList, false);
});

test("多账号：不同 getAuth 的 fetch 各用各的 Key，不串号", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(String(init?.headers?.get?.("authorization") ?? init?.headers?.authorization ?? ""));
    return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { createFetch } = _internal;
  const fetchA = createFetch(() => authBody(KEY_A), { fetchImpl: fakeFetch });
  const fetchB = createFetch(() => authBody(KEY_B), { fetchImpl: fakeFetch });
  await fetchA("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  await fetchB("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  await fetchA("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(seen.length, 3);
  const keyA = apiKeyOf(authBody(KEY_A));
  const keyB = apiKeyOf(authBody(KEY_B));
  assert.ok(seen[0].includes(keyA.slice(-8)), "A 用 A 的 key");
  assert.ok(seen[1].includes(keyB.slice(-8)), "B 用 B 的 key");
  assert.equal(seen[2], seen[0], "第二次 A 仍是 A 的 key");
});

test("usage 缓存：TTL 内不重打上游；上游挂了回退旧值", async () => {
  const { createUsage, resetUsageCache, usageStats } = await import("../src/usage.mjs");
  resetUsageCache();
  let calls = 0;
  let fail = false;
  const fakeFetch = async () => {
    calls += 1;
    if (fail) throw new Error("upstream down");
    return new Response("{}", {
      status: 200,
      headers: {
        "x-quota-limit": "100000000",
        "x-quota-used": "1000",
        "x-quota-remaining": "99999000",
        "x-quota-reset": String(Math.floor(Date.now() / 1000) + 86400),
      },
    });
  };
  const usage = createUsage(() => authBody(KEY_A), { ttlMs: 1_000, timeoutMs: 2_000, fetchImpl: fakeFetch });
  const first = await usage();
  assert.equal(calls, 1);
  assert.equal(first.windows[0].amount, 1000);
  assert.equal(first.windows[0].used, 0); // 1000/100000000 → 0%，不是绝对数
  const second = await usage();
  assert.equal(calls, 1, "TTL 内命中缓存");
  assert.equal(second.windows[0].amount, 1000);
  await new Promise((r) => setTimeout(r, 1100)); // 等 TTL 过期
  fail = true;
  const third = await usage();
  assert.equal(calls, 2, "过期后重打");
  assert.equal(third.windows[0].amount, 1000, "上游失败回退旧值，不给 UI 报错");
  assert.ok(usageStats.stale >= 1);
});

test("dropTools：转发层裁掉命中的工具（精确名/前缀*/双形态），其余请求体不动", async () => {
  const { dropToolsFromBody } = await import("../src/relay.mjs");
  const payload = {
    model: "deepseek-v4.1-flash-free",
    tools: [
      { type: "function", function: { name: "mcp__big__tool1", description: "x".repeat(2000) } },
      { type: "function", function: { name: "keepme", description: "y" } },
      { name: "bare_tool", description: "z".repeat(1000) },
    ],
  };
  const raw = JSON.stringify(payload);
  // 精确名
  const a = JSON.parse(dropToolsFromBody(raw, ["bare_tool"]));
  assert.equal(a.tools.length, 2);
  // 前缀通配
  const b = JSON.parse(dropToolsFromBody(raw, ["mcp__big__*"]));
  assert.deepEqual(b.tools.map((t) => t.function?.name ?? t.name), ["keepme", "bare_tool"]);
  // 全部裁光
  const c = JSON.parse(dropToolsFromBody(raw, ["mcp__big__tool1", "keepme", "bare_tool"]));
  assert.equal(c.tools.length, 0);
  // 无命中 / 非 JSON / 无 tools 字段 → 原样返回
  assert.equal(dropToolsFromBody(raw, ["nope"]), raw);
  assert.equal(dropToolsFromBody("not json{", ["keepme"]), "not json{");
  assert.equal(dropToolsFromBody(JSON.stringify({ messages: [] }), ["keepme"]), JSON.stringify({ messages: [] }));
  // 空名单不碰 body
  assert.equal(dropToolsFromBody(raw, []), raw);
});

test("createFetch 支持 dropTools：chat 请求裁工具，/models 不受影响", async () => {
  const { createFetch } = _internal;
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchFn = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    dropTools: ["mcp__x*"],
  });
  const chatBody = JSON.stringify({
    model: "deepseek-v4.1-flash-free",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "mcp__x__heavy" } },
      { type: "function", function: { name: "stay" } },
    ],
  });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", {
    method: "POST",
    body: chatBody,
  });
  assert.equal(res.status, 200);
  const sent = JSON.parse(calls[0].body);
  assert.deepEqual(sent.tools.map((t) => t.function.name), ["stay"]);
  // /models 请求走本地模型表，不碰 body、也不产生上游调用
  const modelsRes = await fetchFn("https://100milionseek.top/v1/models");
  assert.equal(modelsRes.status, 200);
  assert.equal(calls.length, 1, "本地应答 /models，不打上游");
});

// ─────────────────────────────────────────────────────────────
// 1.3.0：模型目录按「真能 chat」过滤 + 上游元数据 + 并发 429 插件内重试
// ─────────────────────────────────────────────────────────────

test("模型目录：/v1/models 里的 judge 条目（endpoint=/v1/systemone）不进模型表", () => {
  const { parseModelList, isChatModel } = _internal;
  const raw = {
    data: [
      {
        id: "deepseek-v4.1-flash-free",
        object: "model",
        context_length: 198000,
        max_output_tokens: 65536,
        quota_multiplier: 1,
      },
      {
        id: "jev-1.13-free",
        object: "model",
        name: "JEV",
        endpoint: "/v1/systemone",
        quota_multiplier: 0.2,
      },
    ],
  };
  const table = parseModelList(raw);
  assert.deepEqual(Object.keys(table), ["deepseek-v4.1-flash-free"], "judge 模型不能进 chat 模型表");
  assert.equal(isChatModel(raw.data[1]), false);
  assert.equal(isChatModel(raw.data[0]), true);
  // chatOnly:false 时才给全表（诊断/CLI 用）
  assert.equal(Object.keys(parseModelList(raw, { chatOnly: false })).length, 2);
});

test("模型目录：上游 context_length / max_output_tokens 被采用（不再永远套默认值）", () => {
  const { parseModelList } = _internal;
  const table = parseModelList({
    data: [{ id: "deepseek-v4.1-flash-free", context_length: 131072, max_output_tokens: 8192 }],
  });
  assert.equal(table["deepseek-v4.1-flash-free"].limit.context, 131072);
  assert.equal(table["deepseek-v4.1-flash-free"].limit.output, 8192);
  // 上游不给就用 198K / 64K 兜底
  const fallback = parseModelList({ data: [{ id: "deepseek-v4.1-flash-free" }] });
  assert.equal(fallback["deepseek-v4.1-flash-free"].limit.context, 198000);
  assert.equal(fallback["deepseek-v4.1-flash-free"].limit.output, 64000);
});

test("转发：429 session_limit_reached 先插件内重试，成功则宿主完全看不到 429", async () => {
  const { createFetch } = _internal;
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: { message: "too many concurrent requests", code: "session_limit_reached" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchFn = createFetch(() => authBody(KEY_A), { fetchImpl: fakeFetch, sessionRetry: 2 });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4.1-flash-free", messages: [] }),
  });
  assert.equal(res.status, 200, "重试成功后必须是 200");
  assert.equal(calls, 2, "恰好重试一次");
});

test("转发：429 session_limit 重试用尽后返回 429，并同时带上 failover + retry-after", async () => {
  const { createFetch } = _internal;
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { message: "too many concurrent requests", code: "session_limit_reached", retry_after_s: 3 } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  };
  const fetchFn = createFetch(() => authBody(KEY_A), { fetchImpl: fakeFetch, sessionRetry: 1 });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 429);
  assert.equal(calls, 2, "sessionRetry=1 → 共 2 次尝试");
  assert.equal(res.headers.get("x-magpie-failover"), "true", "挤不出槽位就让宿主换号（池子还有别的账号）");
  assert.equal(res.headers.get("x-magpie-retry"), "backoff");
  assert.equal(res.headers.get("retry-after"), "3");
});

test("转发：sessionRetry=0 关闭重试，一次 429 直接透出", async () => {
  const { createFetch } = _internal;
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "busy", code: "session_limit_reached" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchFn = createFetch(() => authBody(KEY_A), { fetchImpl: fakeFetch, sessionRetry: 0 });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 429);
  assert.equal(calls, 1);
});

test("转发：不可重放的 body（ReadableStream）不重试，避免把空 body 再发一次", async () => {
  const { createFetch } = _internal;
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "busy", code: "session_limit_reached" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchFn = createFetch(() => authBody(KEY_A), { fetchImpl: fakeFetch, sessionRetry: 2 });
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("{}"));
      c.close();
    },
  });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: stream });
  assert.equal(res.status, 429);
  assert.equal(calls, 1, "流式 body 不能重发");
});

test("模型表：合并优先级 在线元数据 > 静态兜底，用户改动 > 两者", () => {
  const base = staticModelTable();
  // 在线上游给了更小的窗口 → 必须覆盖静态兜底（旧版被 `if (!merged[id])` 挡住）
  const merged = mergeModelTables(
    base,
    { "deepseek-v4.1-flash-free": { id: "deepseek-v4.1-flash-free", name: "在线名", limit: { context: 131072, output: 8192 } } },
    {},
  );
  assert.equal(merged["deepseek-v4.1-flash-free"].limit.context, 131072);
  assert.equal(merged["deepseek-v4.1-flash-free"].limit.output, 8192);
  assert.equal(merged["deepseek-v4.1-flash-free"].name, "在线名");
  // 用户显式改动再压过在线
  const userWins = mergeModelTables(
    base,
    { "deepseek-v4.1-flash-free": { id: "deepseek-v4.1-flash-free", limit: { context: 131072 } } },
    { "deepseek-v4.1-flash-free": { disabled: true, limit: { context: 1000 } } },
  );
  assert.equal(userWins["deepseek-v4.1-flash-free"].limit.context, 1000);
  assert.equal(userWins["deepseek-v4.1-flash-free"].disabled, true);
});

test("options：sessionRetry 收口（0 合法、超界截断、非法回退默认）", () => {
  assert.equal(_internal.readOptions({ sessionRetry: 0 }).sessionRetry, 0);
  assert.equal(_internal.readOptions({ sessionRetry: 99 }).sessionRetry, 5);
  assert.equal(_internal.readOptions({ sessionRetry: "x" }).sessionRetry, 2);
  assert.equal(_internal.readOptions({ keyFailover: false }).keyFailover, false);
  assert.equal(_internal.readOptions({}).keyFailover, true);
});

test("429 换 Key：第一把 Key 撞日额度，插件内换第二把，宿主看到 200", async () => {
  const { createFetch } = _internal;
  const seen = [];
  const fakeFetch = async (url, init = {}) => {
    const auth = String(init?.headers?.get?.("authorization") ?? "");
    seen.push(auth.slice(-8));
    if (auth.includes(KEY_A.slice(-8))) {
      return new Response(JSON.stringify({ error: { message: "daily quota exceeded", code: "daily_quota_exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchFn = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    fallbackKeys: () => [KEY_B],
    sessionRetry: 0,
  });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 200, "换号成功后宿主拿到 200");
  assert.deepEqual(seen, [KEY_A.slice(-8), KEY_B.slice(-8)]);
});

test("429 换 Key：同账号重试耗尽才换；新账号自己也有独立重试额度", async () => {
  const { createFetch } = _internal;
  const seen = [];
  const fakeFetch = async (url, init = {}) => {
    const auth = String(init?.headers?.get?.("authorization") ?? "");
    seen.push(auth.slice(-8));
    // 前两次都是 A 且撞限；换到 B 之后才 200 —— 这样才需要「A 的重试额度用完 → 换号」
    if (auth.includes(KEY_A.slice(-8))) {
      return new Response(JSON.stringify({ error: { message: "busy", code: "session_limit_reached" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchFn = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    fallbackKeys: () => [KEY_B],
    sessionRetry: 1,
  });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 3, "A 试 2 次（1 次重试）→ 换 B");
  assert.equal(seen[2], KEY_B.slice(-8));
});

test("429 换 Key：keyFailover:false / 不可重放 body 时都不换号", async () => {
  const { createFetch } = _internal;
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "daily quota exceeded", code: "daily_quota_exceeded" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };
  const off = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    fallbackKeys: () => [KEY_B],
    keyFailover: false,
  });
  assert.equal((await off("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" })).status, 429);
  assert.equal(calls, 1);

  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{}")); c.close(); } });
  const streamFetch = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    fallbackKeys: () => [KEY_B],
  });
  assert.equal((await streamFetch("https://100milionseek.top/v1/chat/completions", { method: "POST", body: stream })).status, 429);
  assert.equal(calls, 2, "流式 body 不换号");
});

test("503 upstream_busy（站点过载）：先退避重试，仍失败换 Key，宿主拿到 200", async () => {
  const { createFetch } = _internal;
  const seen = [];
  const fakeFetch = async (url, init = {}) => {
    const auth = String(init?.headers?.get?.("authorization") ?? "");
    seen.push(auth.slice(-8));
    if (seen.length <= 2) {
      return new Response(
        JSON.stringify({ error: { message: "The service is busy right now.", code: "upstream_busy" } }),
        { status: 503, headers: { "content-type": "application/json", "retry-after": "20" } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  // busyRetryBaseMs 收小让测试跑得快；sessionRetry=1 → A 退避重试 1 次仍 503 → 换 B
  const fetchFn = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    fallbackKeys: () => [KEY_B],
    busyRetryBaseMs: 10,
    sessionRetry: 1,
  });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 200, "退避 1 次 + 换号后应成功");
  assert.deepEqual(seen, [KEY_A.slice(-8), KEY_A.slice(-8), KEY_B.slice(-8)], "A 重试 1 次仍 503 → 换 B");
});

test("503 upstream_busy：换号两次仍忙 → 503 透出（带 retry-after）", async () => {
  const { createFetch } = _internal;
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: { message: "busy", code: "upstream_busy" } }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "20" },
    });
  const fetchFn = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    fallbackKeys: () => [KEY_B, "hms-third333333"],
    busyRetryBaseMs: 5,
    sessionRetry: 0,
    keyFailoverMax: 2,
  });
  const res = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "20");
});

test("Key 健康：额度耗尽的账号被记冷却，池子把它排到最后（不再白撞）", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKeyPool } = _internal;
  const KA = "hms-aaa111bbb222";
  const KB = "hms-bbb222ccc333";
  const KC = "hms-ccc333ddd444";
  const dir = mkdtempSync(join(tmpdir(), "hms-health-"));
  const authFile = join(dir, "auth.json");
  const healthFile = join(dir, "health.json");
  writeFileSync(authFile, JSON.stringify({
    hms: { key: KA },
    "hms#b": { key: KB },
    "hms#c": { key: KC },
  }), "utf8");

  const pool = createKeyPool("hms", { path: authFile, healthFile });
  assert.deepEqual(pool.candidates(KA), [KB, KC], "初始全健康，保持原顺序");

  // B 额度耗尽 → 记到站点 reset_at
  pool.health.markFailure(KB, "quota", { resetAt: Date.now() + 24 * 3600_000 });
  assert.deepEqual(pool.candidates(KA), [KC, KB], "冷却中的 B 必须排到最后，健康账号优先");
  assert.equal(pool.summary().cooling, 1);

  // 落盘校验：只存指纹，不存明文 Key
  const raw = readFileSync(healthFile, "utf8");
  assert.equal(raw.includes(KB), false, "健康账本绝不能写明文 Key");

  // 成功一次即解除冷却
  pool.health.markSuccess(KB);
  assert.deepEqual(pool.candidates(KA), [KB, KC]);
  assert.equal(pool.summary().cooling, 0);
});

test("Key 健康：冷却状态跨实例持久化（重启插件后仍然记得谁废了）", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKeyHealth } = _internal;
  const dir = mkdtempSync(join(tmpdir(), "hms-health-persist-"));
  const file = join(dir, "h.json");
  const K = "hms-zzz999yyy888";

  const a = createKeyHealth({ file });
  a.markFailure(K, "quota", { resetAt: Date.now() + 3600_000 });
  assert.equal(a.isCooling(K), true);

  // 新实例（模拟插件重启 / 另一进程）读同一文件
  const b = createKeyHealth({ file });
  assert.equal(b.isCooling(K), true, "冷却必须持久化，不能只活在一个进程里");
  assert.equal(b.snapshot().cooling, 1);
  assert.equal(b.snapshot().rows[0].kind, "quota");
});

test("Key 健康：冷却到期自动失效；不同 kind 用不同时长", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKeyHealth } = _internal;
  const dir = mkdtempSync(join(tmpdir(), "hms-health2-"));
  let clock = 1_000_000;
  const health = createKeyHealth({ file: join(dir, "h.json"), now: () => clock, persist: false });

  const until = health.markFailure("hms-aaa111bbb222", "busy", { retryAfterSec: 20 });
  assert.equal(until, clock + 20_000);
  assert.equal(health.isCooling("hms-aaa111bbb222"), true);
  clock += 20_001;
  assert.equal(health.isCooling("hms-aaa111bbb222"), false, "到期即自动失效，无需清理");

  // session 类只冷 2s
  const s = health.markFailure("hms-bbb222ccc333", "session", {});
  assert.equal(s, clock + 2_000);
  // auth 类冷 6h
  const a = health.markFailure("hms-ccc333ddd444", "auth", {});
  assert.equal(a, clock + 6 * 3600_000);
});

test("Key 健康：quota 冷却按站点 reset_at 算，拿不到就落到次日 UTC 0 点", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKeyHealth } = _internal;
  const dir = mkdtempSync(join(tmpdir(), "hms-health3-"));
  const nowMs = Date.UTC(2026, 10, 27, 6, 0, 0); // 2026-11-27 06:00 UTC
  const health = createKeyHealth({ file: join(dir, "h.json"), now: () => nowMs, persist: false });

  const withReset = health.markFailure("hms-aaaaaa111111", "quota", { resetAt: "2026-11-27T08:00:00.000Z" });
  assert.equal(withReset, Date.UTC(2026, 10, 27, 8, 0, 0), "按站点 reset_at 精确冷却");

  const withoutReset = health.markFailure("hms-bbbbbb222222", "quota", {});
  assert.equal(withoutReset, Date.UTC(2026, 10, 28, 0, 0, 0), "没 reset_at 就等次日 UTC 0 点");
});

test("relay × 健康账本：429 额度耗尽会记账（成功换号不会误清被废账号）", async () => {
  const { createFetch, createKeyHealth } = _internal;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const health = createKeyHealth({ file: join(mkdtempSync(join(tmpdir(), "hms-relay-health-")), "h.json") });

  const fakeFetch = async (url, init = {}) => {
    const key = String(init?.headers?.get?.("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (key === KEY_A) {
      return new Response(
        JSON.stringify({
          error: {
            message: "daily quota exceeded",
            code: "daily_quota_exceeded",
            reset_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const fetchFn = createFetch(() => authBody(KEY_A), {
    fetchImpl: fakeFetch,
    health,
    fallbackKeys: (cur) => (cur === KEY_A ? [KEY_B] : []),
    sessionRetry: 0,
  });

  const r = await fetchFn("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(r.status, 200, "A 额度耗尽 → 换 B 成功");
  assert.equal(health.isCooling(KEY_A), true, "被废的 A 必须记为冷却");
  assert.equal(health.isCooling(KEY_B), false, "换号成功不能把 B 记成冷却");
});

test("relay × 健康账本：503 upstream_busy 记短冷却；2xx 会清掉自己的记录", async () => {
  const { createFetch, createKeyHealth } = _internal;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const health = createKeyHealth({ file: join(mkdtempSync(join(tmpdir(), "hms-relay-busy-")), "h.json") });

  // 全忙：重试与换号都失败 → 最终 503，currentKey 被记 busy
  const alwaysBusy = async () =>
    new Response(JSON.stringify({ error: { message: "busy", code: "upstream_busy" } }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "20" },
    });
  const f1 = createFetch(() => authBody(KEY_A), {
    fetchImpl: alwaysBusy,
    health,
    busyRetryBaseMs: 1,
    sessionRetry: 0,
    fallbackKeys: () => [],
  });
  assert.equal((await f1("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" })).status, 503);
  assert.equal(health.isCooling(KEY_A), true, "过载后应记冷却");

  // 之后成功一次 → 记录被清
  const f2 = createFetch(() => authBody(KEY_A), {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    health,
    sessionRetry: 0,
  });
  await f2("https://100milionseek.top/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(health.isCooling(KEY_A), false, "成功即清记录（半开探测通过）");
});

test("Key 池：从 plugin-auth.json 只取本供应商的 hms- Key，去重，可重置", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createKeyPool } = _internal;
  const dir = mkdtempSync(join(tmpdir(), "hms-pool-"));
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({
    hms: { key: "hms-aaaaaa111111" },
    "hms#b": { key: "hms-bbbbbb222222" },
    "hms#c": { key: "hms-cccccc333333" },
    "hms#d": { key: "hms-bbbbbb222222" }, // 重复
    other: { key: "hms-zzzzzz999999" },
    broken: { key: "hms-short" },
  }), "utf8");
  const pool = createKeyPool("hms", { path: file });
  assert.equal(pool.size, 3);
  assert.deepEqual(pool.candidates("hms-aaaaaa111111"), ["hms-bbbbbb222222", "hms-cccccc333333"]);
  writeFileSync(file, JSON.stringify({ hms: { key: "hms-dddddd444444" } }), "utf8");
  assert.equal(pool.size, 3, "TTL 内仍用缓存");
  pool.reset();
  assert.equal(pool.size, 1);
  assert.deepEqual(pool.candidates("hms-dddddd444444"), []);
});

