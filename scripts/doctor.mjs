#!/usr/bin/env node
// scripts/doctor.mjs — 一条命令自检：出口 → 站点 → 账号池健康 → 额度 → 模型表。
//
// 风格对齐 magpie-marvis 的 scripts/doctor.mjs：逐项 ✓ / ⓘ / ✗ + 可执行的修复提示 + 总结 exit code。
// 只读环境变量与本地文件；网络探测只发最小请求。**绝不打印明文 Key**（一律指纹/尾号）。
//
// 用法：
//   node scripts/doctor.mjs              全量自检（含网络）
//   node scripts/doctor.mjs --quick      只查本地（池子/账本/配置），不打网络
//   node scripts/doctor.mjs --all        逐个账号打额度（慢，18 个号 ≈ 10s）
//   node scripts/doctor.mjs --json       机器可读输出
//   node scripts/doctor.mjs --proxy http://127.0.0.1:10090   走代理（CONNECT 隧道）
//   node scripts/doctor.mjs --direct     强制直连（默认）
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import net from "node:net";

import { VERSION, BASE, DEFAULT_MODEL, JUDGE_MODEL } from "../src/config.mjs";
import { createKeyPool } from "../src/key-pool.mjs";
import { parseModelList, staticModelTable } from "../src/models.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AUTH_FILE = join(homedir(), ".config", "magpie", "plugin-auth.json");
const HEALTH_FILE = process.env.HMS_HEALTH_FILE || join(homedir(), ".config", "magpie", "100milionseek-health.json");
const TIMEOUT = 8_000;

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const QUICK = has("--quick");
const ALL = has("--all");
const JSON_OUT = has("--json");
const PROXY = has("--direct") ? "" : argOf("--proxy") || "";

// ── 输出（JSON 模式下全部静默，最后一次性输出）────────────────────────────────
const rows = [];
const failures = [];
const warns = [];
const say = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

/** 兜底脱敏：任何可能被回显的凭据都不外泄。 */
function scrub(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer ***")
    .replace(/\bhms-[A-Za-z0-9_-]{6,}\b/g, (m) => `hms-…${m.slice(-4)}`)
    .replace(/\b(key|token|secret)\s*[:=]\s*["']?[^\s,;"'}]{6,}/gi, "$1=***");
}

function ok(label, detail) {
  rows.push({ level: "ok", label, detail: detail ? scrub(detail) : "" });
  say(`✓ ${label}${detail ? `：${scrub(detail)}` : ""}`);
}
function info(label, detail) {
  rows.push({ level: "info", label, detail: detail ? scrub(detail) : "" });
  say(`ⓘ ${label}${detail ? `：${scrub(detail)}` : ""}`);
}
function warn(label, detail, hint) {
  rows.push({ level: "warn", label, detail: detail ? scrub(detail) : "", hint: hint ? scrub(hint) : "" });
  warns.push({ label, detail, hint });
  say(`⚠ ${label}${detail ? `：${scrub(detail)}` : ""}`);
  if (hint) say(`   → ${scrub(hint)}`);
}
function bad(label, detail, hint) {
  rows.push({ level: "bad", label, detail: detail ? scrub(detail) : "", hint: hint ? scrub(hint) : "" });
  failures.push({ label, detail, hint });
  say(`✗ ${label}${detail ? `：${scrub(detail)}` : ""}`);
  if (hint) say(`   → 修复：${scrub(hint)}`);
}

// ── HTTP（默认直连；--proxy 走 CONNECT 隧道）──────────────────────────────────
function httpRequest(url, { method = "GET", headers = {}, body, timeoutMs = TIMEOUT } = {}) {
  const u = new URL(url);
  const opts = {
    method,
    headers: { ...headers },
    timeout: timeoutMs,
  };
  if (body != null) {
    opts.headers["content-length"] = Buffer.byteLength(body);
  }
  const t0 = Date.now();
  const finish = (status, text, rawHeaders) =>
    ({ status, text, ms: Date.now() - t0, headers: rawHeaders ?? {} });
  const rawHeadersOf = (res) => {
    const h = {};
    for (const [k, v] of Object.entries(res.headers || {})) h[k] = Array.isArray(v) ? v.join(", ") : v;
    return h;
  };

  const doDirect = () => {
    const mod = u.protocol === "http:" ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        { hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, ...opts },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(finish(res.statusCode, Buffer.concat(chunks).toString("utf8"), rawHeadersOf(res))));
        },
      );
      req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
      req.on("error", reject);
      if (body != null) req.write(body);
      req.end();
    });
  };

  // HTTPS 走代理：先 CONNECT 建隧道，再在隧道上跑 TLS
  const doProxy = () => {
    const p = new URL(PROXY);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: p.hostname,
        port: p.port || 80,
        method: "CONNECT",
        path: `${u.hostname}:${u.port || 443}`,
        timeout: timeoutMs,
      });
      req.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`proxy CONNECT ${res.statusCode}`));
          return;
        }
        const tlsReq = https.request(
          { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, ...opts, agent: false, createConnection: () => socket },
          (r) => {
            const chunks = [];
            r.on("data", (c) => chunks.push(c));
            r.on("end", () => resolve(finish(r.statusCode, Buffer.concat(chunks).toString("utf8"), rawHeadersOf(r))));
          },
        );
        tlsReq.on("timeout", () => tlsReq.destroy(new Error(`timeout ${timeoutMs}ms`)));
        tlsReq.on("error", reject);
        if (body != null) tlsReq.write(body);
        tlsReq.end();
      });
      req.on("timeout", () => req.destroy(new Error(`proxy timeout ${timeoutMs}ms`)));
      req.on("error", reject);
      req.end();
    });
  };

  return PROXY ? doProxy() : doDirect();
}

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const done = (okFlag, err) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok: okFlag, ms: Date.now() - t0, error: err });
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false, "timeout"));
    sock.on("error", (e) => done(false, e.code || e.message));
  });
}

// ── 本地读取 ────────────────────────────────────────────────────────────────
function readAuth() {
  try {
    const j = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    const entries = Object.entries(j ?? {}).filter(
      ([slot, v]) => (slot === "hms" || slot.startsWith("hms#")) && typeof v?.key === "string",
    );
    return { exists: true, entries };
  } catch (e) {
    return { exists: existsSync(AUTH_FILE), entries: [], error: e.message };
  }
}

const tail = (k) => `…${String(k).slice(-4)}`;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  say(`100 Million Seek 插件自检 v${VERSION}`);
  say(`平台 ${process.platform} · ${process.version}`);
  say(`插件目录 ${ROOT}`);
  say("");

  // 1) 本地配置 / 登录态
  const auth = readAuth();
  if (!auth.exists) {
    bad("登录态文件", AUTH_FILE, "magpie plugin login hms（或 bun cli/import-keys.mjs keys.txt 批量导入）");
  } else if (auth.error) {
    bad("登录态文件解析失败", auth.error, "检查 plugin-auth.json 是否为合法 JSON；损坏时用备份 .bak 还原");
  } else if (auth.entries.length === 0) {
    bad("未找到 hms 账号", "plugin-auth.json 里没有 hms / hms# 条目", "magpie plugin login hms");
  } else {
    ok("登录态", `${auth.entries.length} 个 hms 账号`);
  }

  // 2) 账号池 + 健康账本
  const pool = createKeyPool("hms");
  const sum = pool.summary();
  if (auth.entries.length > 1) {
    if (sum.cooling === 0) ok("账号池", `${sum.total} 把全部健康`);
    else if (sum.total - sum.cooling === 0)
      bad("账号池", `${sum.total} 把全在冷却`, "等冷却结束（quota 类等到 UTC 0 点），或删掉 " + HEALTH_FILE + " 强制重置");
    else warn("账号池", `${sum.total} 把，${sum.cooling} 把冷却中，可用 ${sum.total - sum.cooling}`, "冷却中的账号会被排到最后，不必手动处理");

    for (const r of sum.rows.slice(0, 8)) {
      const left = r.secondsLeft > 3600 ? `${Math.round(r.secondsLeft / 360) / 10}h` : `${r.secondsLeft}s`;
      say(`   · ${r.fp}… ${r.kind} 剩 ${left}（失败 ${r.fails} 次）`);
    }
    if (sum.rows.length > 8) say(`   · …另有 ${sum.rows.length - 8} 条`);
  } else {
    info("账号池", "只有 1 个账号，换号无意义（限流时只能等）");
  }

  if (existsSync(HEALTH_FILE)) info("健康账本", HEALTH_FILE);
  else info("健康账本", "尚未生成（没有失败记录，属正常）");

  if (QUICK) {
    say("");
    return summarize();
  }

  // 3) 出口
  const host = new URL(BASE).hostname;
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const via = PROXY ? `代理 ${PROXY}` : "直连";
  const tcp = await tcpProbe(host, 443);
  if (tcp.ok) ok("出口", `${via} · ${host}:443 可达 ${tcp.ms}ms`);
  else warn("出口", `${via} · ${host}:443 不可达（${tcp.error}）`, "试试 --proxy http://127.0.0.1:10090（clash 挂了会走死代理）");
  if (!PROXY && envProxy) info("环境代理", `${envProxy}（本脚本默认直连，不受它影响）`);

  // 4) 站点公开状态（无需 Key）
  try {
    const st = await httpRequest("https://100milionseek.top/api/status");
    if (st.status === 200) {
      const j = JSON.parse(st.text);
      const state = j?.state || "?";
      const allow = j?.allowance?.daily_tokens;
      const rate = j?.last_24h?.success_rate;
      const detail = [
        `state=${state}`,
        allow ? `日额度 ${Number(allow).toLocaleString()}` : "",
        rate != null ? `24h 成功率 ${(rate * 100).toFixed(1)}%` : "",
      ].filter(Boolean).join(" · ");
      if (state === "ok" || state === "operational") ok("站点状态", detail);
      else warn("站点状态", detail, "站点降级时 503 upstream_busy 会变多；插件会退避+换号，属正常");
      if (j?.model?.id && j.model.id !== DEFAULT_MODEL) {
        warn("上游模型变更", `站点主模型是 ${j.model.id}，插件默认是 ${DEFAULT_MODEL}`, "检查 /v1/models 后更新 config.mjs 的 DEFAULT_MODEL");
      }
    } else {
      warn("站点状态", `/api/status HTTP ${st.status}`, "公开状态接口异常，通常是站点自身问题");
    }
  } catch (e) {
    warn("站点状态", `探测失败：${e.message}`, "网络或代理问题；不影响插件已生效的配置");
  }

  // 5) 额度（当前账号；--all 逐账号）
  const firstKey = auth.entries[0]?.[1]?.key;
  const quotaOf = async (key) => {
    const res = await httpRequest(`${BASE}/models`, { headers: { authorization: `Bearer ${key}` } });
    const g = (n) => res.headers[n.toLowerCase()];
    const used = Number(g("x-quota-used"));
    const limit = Number(g("x-quota-limit"));
    const remain = Number(g("x-quota-remaining"));
    return { status: res.status, used, limit, remain, reset: g("x-quota-reset") };
  };
  if (firstKey) {
    const targets = ALL ? auth.entries.slice(0, 20).map(([, v]) => v.key) : [firstKey];
    let okCount = 0;
    for (const key of targets) {
      try {
        const q = await quotaOf(key);
        if (q.status === 200 && Number.isFinite(q.remain)) {
          okCount += 1;
          const pct = q.limit ? ((q.used / q.limit) * 100).toFixed(2) : "?";
          ok(
            ALL ? `额度 ${tail(key)}` : "额度",
            `${Number(q.used).toLocaleString()} / ${Number(q.limit).toLocaleString()}（${pct}%）· 剩 ${Number(q.remain).toLocaleString()} · 重置 ${q.reset || "?"}`,
          );
        } else {
          const hint =
            q.status === 401 ? "这个 Key 失效了，重新登录或从池子里移除"
            : q.status === 429 ? "额度已耗尽，等 UTC 0 点"
            : "上游异常，稍后重试";
          warn(`额度 ${tail(key)}`, `HTTP ${q.status}`, hint);
        }
      } catch (e) {
        warn(`额度 ${tail(key)}`, e.message, "网络/代理问题");
      }
    }
    if (ALL) info("额度汇总", `${okCount}/${targets.length} 个账号应答正常`);
  }

  // 6) 模型表：上游原始 vs 过滤后
  if (firstKey) {
    try {
      const res = await httpRequest(`${BASE}/models`, { headers: { authorization: `Bearer ${firstKey}` } });
      if (res.status === 200) {
        const data = JSON.parse(res.text);
        const rawIds = (data?.data ?? []).map((m) => m?.id).filter(Boolean);
        const chatTable = parseModelList(data);
        const chatIds = Object.keys(chatTable);
        const staticIds = Object.keys(staticModelTable());
        const dropped = rawIds.filter((id) => !chatIds.includes(id));
        if (chatIds.length === 0) {
          bad("模型表", `上游 ${rawIds.length} 条，但没有可用 chat 模型`, "检查 /v1/models 响应；或把 liveModelList 设为 false 用静态表");
        } else {
          ok("模型表", `上游 ${rawIds.length} 条 → 可用 ${chatIds.length} 条（${chatIds.join(", ")}）`);
          if (dropped.length) info("已过滤", `${dropped.join(", ")}（非 chat 端点，选了会 400）`);
          if (dropped.includes(JUDGE_MODEL)) info("judge 模型", `${JUDGE_MODEL} 正确剔除（只能走 /v1/systemone）`);
          const missing = staticIds.filter((id) => !chatIds.includes(id));
          if (missing.length) warn("静态表与上游不一致", `静态有而上游没有：${missing.join(", ")}`, "上游可能下线了该模型");
          for (const id of chatIds) {
            const m = chatTable[id];
            say(`   · ${id}  ctx=${m.limit.context} out=${m.limit.output}`);
          }
        }
      } else {
        warn("模型表", `GET /models HTTP ${res.status}`, res.status === 401 ? "Key 失效" : "上游异常，插件会回退静态表");
      }
    } catch (e) {
      warn("模型表", e.message, "网络/代理问题；插件会回退静态表，不影响已配置的模型");
    }
  }

  say("");
  return summarize();
}

function summarize() {
  const total = rows.length;
  const line = `检查 ${total} 项：${rows.filter((r) => r.level === "ok").length} 正常、${
    rows.filter((r) => r.level === "warn").length
  } 警告、${failures.length} 失败`;
  if (JSON_OUT) {
    console.log(JSON.stringify({ version: VERSION, ok: failures.length === 0, summary: line, rows, failures, warnings: warns }, null, 2));
  } else {
    say(line);
    if (failures.length) {
      say("");
      say("需要处理：");
      for (const f of failures) say(`  · ${f.label}${f.hint ? ` → ${f.hint}` : ""}`);
    }
  }
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (JSON_OUT) console.log(JSON.stringify({ version: VERSION, ok: false, error: String(e?.message ?? e) }));
    else console.error(`✗ 自检脚本自身出错：${e?.message ?? e}`);
    process.exit(2);
  });
