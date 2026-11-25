#!/usr/bin/env node
/**
 * magpie-100milionseek 批量导入 CLI
 *
 * 背景：Magpie 宿主没有 auth.import hook，登录态统一存在
 *   ~/.config/magpie/plugin-auth.json
 * 结构（扁平对象）：第一个账号在 "hms" 键，其余在 "hms#<slot>" 键。
 * 本脚本把「粘贴的一段文本」智能识别成 hms- Key，逐条校验后写进这个文件。
 *
 * 用法：
 *   node cli/import-keys.mjs                       # 读剪贴板/交互输入
 *   node cli/import-keys.mjs keys.txt              # 从文件读
 *   echo "hms-aaa\nhms-bbb" | node cli/import-keys.mjs
 *   node cli/import-keys.mjs --no-verify keys.txt  # 跳过在线校验（离线快导）
 *   node cli/import-keys.mjs --dry-run keys.txt    # 只预览不写盘
 *   node cli/import-keys.mjs --config /path/plugin-auth.json keys.txt
 *
 * 选项：
 *   --provider <id>       默认 hms（与插件 providerId 保持一致）
 *   --no-verify           不在线校验 Key（默认会 GET /v1/models 校验）
 *   --dry-run             只解析+校验并打印，不写文件
 *   --config <path>       指定 plugin-auth.json 路径
 *   --reset               清空现有同 provider 账号后再写（默认追加去重）
 *   --json                结果以 JSON 输出
 *   -h, --help
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseCredentialBlob } from "../src/bulk-import.mjs";
import { verifyApiKey, authBody, uidOf } from "../src/auth.mjs";
import { PROVIDER, BASE } from "../src/config.mjs";

const ARGS = process.argv.slice(2);

function parseArgs(args) {
  const out = {
    files: [],
    provider: PROVIDER,
    verify: true,
    dryRun: false,
    reset: false,
    json: false,
    config: "",
    help: false,
    stdin: false,
    proxy: "",
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--no-verify") out.verify = false;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--reset") out.reset = true;
    else if (a === "--json") out.json = true;
    else if (a === "--stdin") out.stdin = true;
    else if (a === "--direct") out.proxy = "direct";
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--provider" || a === "--config" || a === "--proxy") {
      const v = args[++i];
      if (v) out[a.slice(2)] = v;
    } else if (a.startsWith("--provider=")) out.provider = a.split("=")[1];
    else if (a.startsWith("--config=")) out.config = a.slice(a.indexOf("=") + 1);
    else if (a.startsWith("--proxy=")) out.proxy = a.slice(a.indexOf("=") + 1);
    else if (!a.startsWith("-")) out.files.push(a);
  }
  return out;
}

function defaultConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config");
  return join(base, "magpie", "plugin-auth.json");
}

function readAuthFile(path) {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function slotSuffix(key) {
  // 用指纹前 6 位做稳定 slot；同一把 key 永远落到同一个条目
  return uidOf(key).replace("hms-", "").slice(0, 6);
}

function collectInput(files, opt) {
  if (files.length) {
    return files.map((f) => {
      try {
        return readFileSync(resolve(f), "utf8");
      } catch (e) {
        throw new Error(`读取文件失败 ${f}：${e.message}`);
      }
    }).join("\n");
  }
  if (opt.stdin || !process.stdin.isTTY) {
    try {
      return readFileSync(0, "utf8");
    } catch {
      return "";
    }
  }
  return "";
}

const HELP = `
magpie-100milionseek 批量导入

把一段文本里的 hms- Key 智能识别出来，逐条校验后写入 Magpie 登录态文件。
支持：一行一个、带序号/备注、逗号/空格分隔、JSON、中英文混排、自动去重。

用法:
  node cli/import-keys.mjs [文件...] [选项]

选项:
  --no-verify        跳过在线校验（默认 GET ${BASE}/models 校验）
  --dry-run          只预览，不写盘
  --config <path>    指定 plugin-auth.json（默认 ${defaultConfigPath()}）
  --provider <id>    登录态 provider id（默认 ${PROVIDER}）
  --reset            先清空现有同 provider 账号再写
  --json             以 JSON 输出结果
  --stdin            强制从 stdin 读取
  --direct           强制直连上游（Bun proxy:false），忽略环境变量代理
  --proxy <url>      指定代理（如 http://127.0.0.1:7897）
  -h, --help         显示帮助
`.trim();

async function main() {
  const opt = parseArgs(ARGS);
  if (opt.help) {
    console.log(HELP);
    return;
  }

  const text = collectInput(opt.files, opt);
  if (!text.trim()) {
    console.error("没有读到任何输入。请把 Key 粘贴进来，或传入文件；详见 --help。");
    process.exitCode = 2;
    return;
  }

  const { entries, errors, stats } = parseCredentialBlob(text, { max: 1000 });
  if (!entries.length) {
    console.error("未从输入中识别出任何合法的 hms- Key。");
    for (const e of errors) console.error(`  第 ${e.line || "?"} 行：${e.reason}`);
    process.exitCode = 2;
    return;
  }

  const configPath = resolve(opt.config || defaultConfigPath());
  const authFile = readAuthFile(configPath);
  const provider = opt.provider;
  const prefix = `${provider}#`;

  // 现有同 provider 的 key 集合（用于去重 + --reset）
  const existingKeys = new Set();
  for (const [name, auth] of Object.entries(authFile)) {
    if (name === provider || name.startsWith(prefix)) {
      const k = auth?.key || auth?.apiKey;
      if (typeof k === "string" && k) existingKeys.add(k.trim());
    }
  }

  const results = [];
  const verified = [];
  for (const entry of entries) {
    const key = entry.apiKey;
    if (existingKeys.has(key) && !opt.reset) {
      results.push({ key, status: "skip", reason: "已存在" });
      continue;
    }
    if (opt.verify) {
      const check = await verifyApiKey(key, { proxy: options.proxy });
      if (!check.ok) {
        results.push({ key, status: "invalid", reason: check.reason });
        continue;
      }
    }
    verified.push(entry);
    results.push({ key, status: "ok", reason: opt.verify ? "校验通过" : "未校验" });
  }

  const okCount = verified.length;
  const report = {
    config: configPath,
    provider,
    stats,
    results: results.map((r) => ({
      key: `${r.key.slice(0, 8)}…${r.key.slice(-4)}`,
      status: r.status,
      reason: r.reason,
    })),
    written: 0,
    dryRun: opt.dryRun,
  };

  if (!opt.dryRun && verified.length) {
    const next = { ...authFile };
    if (opt.reset) {
      for (const name of Object.keys(next)) {
        if (name === provider || name.startsWith(prefix)) delete next[name];
      }
    }
    // 第一个账号放 provider 主键，其余放 provider#slot；主键被占则都走 slot
    const primaryFree = !next[provider] || opt.reset;
    verified.forEach((entry, idx) => {
      const body = authBody(entry.apiKey, { label: entry.label });
      let name;
      if (primaryFree && idx === 0) name = provider;
      else {
        let slot = slotSuffix(entry.apiKey);
        while (next[name = `${provider}#${slot}`]) slot = createHash("sha1").update(slot).digest("hex").slice(0, 6);
      }
      next[name] = body;
    });

    mkdirSync(dirname(configPath), { recursive: true });
    if (existsSync(configPath)) {
      try {
        copyFileSync(configPath, `${configPath}.bak`);
      } catch {
        /* ignore */
      }
    }
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    report.written = verified.length;
  }

  if (opt.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n识别：${stats.tokensFound} 个 Key，重复 ${stats.duplicate}，形态错误 ${stats.invalidShape}`);
  console.log(`结果：成功 ${results.filter((r) => r.status === "ok").length}，跳过 ${results.filter((r) => r.status === "skip").length}，无效 ${results.filter((r) => r.status === "invalid").length}`);
  for (const r of results) {
    const tag = { ok: "OK  ", skip: "SKIP", invalid: "BAD " }[r.status];
    console.log(`  [${tag}] ${r.key.slice(0, 8)}…${r.key.slice(-4)}  ${r.reason}`);
  }
  for (const e of errors) {
    if (e.line) console.log(`  [WARN] 第 ${e.line} 行：${e.reason}`);
  }
  if (opt.dryRun) {
    console.log("\n(dry-run，未写盘)");
  } else {
    console.log(`\n已写入 ${report.written} 个账号 → ${configPath}`);
    console.log("重启 Magpie 后生效（Plugins → Reload，或在设置里重新载入插件）。");
  }
}

main().catch((e) => {
  console.error(`失败：${e?.message ?? e}`);
  process.exitCode = 1;
});
