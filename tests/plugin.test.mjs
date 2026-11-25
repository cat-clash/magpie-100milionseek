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

