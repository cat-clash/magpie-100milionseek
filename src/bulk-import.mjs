// src/bulk-import.mjs — 「一键粘贴一大段文本，智能识别 hms- Key」的解析器。
//
// 设计原则：
//   1. 以「从整段文本里全局抓 hms- token」为主——用户怎么粘都行：一行一个、
//      带序号、带备注、带引号、CSV、JSON 数组、混着中文说明，都能抓出来。
//   2. 只做语法/格式校验 + 去重，不做网络校验（网络校验留给 auth.verify ApiKey，
//      由 CLI 的 --verify 或登录阶段执行），避免批量导入时干等一堆请求。
//   3. 逐行诊断：哪行识别到几个、哪行没识别到、哪些重复，都回给调用方展示。
//   4. 不把明文 Key 写进 errors（只留行号和预览，且预览脱敏）。
import { KEY_RE, KEY_GLOBAL_RE, DEFAULTS } from "./config.mjs";
import { keyFingerprint } from "./cache-key.mjs";
import { redact } from "./http.mjs";

const BLANK_OR_COMMENT = /^\s*(?:[#;/]+|$)/;

function asText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(asText).join("\n");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 从单行里剥出一个可读备注（去掉 Key、序号、常见分隔符）。 */
function labelFromLine(line, keys) {
  let rest = String(line);
  for (const k of keys) rest = rest.split(k).join(" ");
  rest = rest
    .replace(/^\s*[-*\d.、)）]+\s*/, "") // 列表序号：1. / - / * / 1)
    .replace(/[\[\]{}"'`|,;]/g, " ")
    .replace(/\b(key|apikey|api[_-]?key|令牌|密钥|账号|key:)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest.slice(0, 48);
}

/**
 * 解析粘贴文本。
 * @returns {{entries:Array<{apiKey:string,label:string,line:number}>, errors:Array, stats:Object}}
 */
export function parseCredentialBlob(text, options = {}) {
  const raw = asText(text);
  const max = Math.max(1, Number(options.max) || DEFAULTS.importMax);
  const defaultLabel = typeof options.label === "string" ? options.label.trim() : "";

  // 归一化换行；把字面量 \n 也当换行（有人从 JSON 里复制会带这个）
  const normalized = raw.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n");
  const lines = normalized.split("\n");

  const entries = [];
  const errors = [];
  const seen = new Map(); // fingerprint -> index in entries
  let totalTokens = 0;
  let duplicate = 0;
  let invalidShape = 0;
  let truncated = 0;
  let lineWithKey = 0;
  let lineWithoutKey = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    if (BLANK_OR_COMMENT.test(line)) continue;

    // 抓这一行里所有 hms- token（全局正则的 lastIndex 每次要重置）
    KEY_GLOBAL_RE.lastIndex = 0;
    const found = [];
    let m;
    while ((m = KEY_GLOBAL_RE.exec(line)) !== null) {
      found.push(m[0]);
      if (found.length > 500) break; // 诡异长行的自保护
    }

    if (found.length === 0) {
      // JSON 外壳行（如 "[" / "]" / "{" / "}"）不报噪音
      if (/^\s*[\[\]{},]\s*$/.test(line)) continue;
      lineWithoutKey += 1;
      errors.push({
        line: lineNo,
        reason: "未识别到 hms- Key",
        preview: redact(line.slice(0, 60)),
      });
      continue;
    }

    lineWithKey += 1;
    const label = labelFromLine(line, found) || defaultLabel;

    for (const token of found) {
      totalTokens += 1;
      if (!KEY_RE.test(token)) {
        invalidShape += 1;
        errors.push({
          line: lineNo,
          reason: "Key 形态不合法（应为 hms- 后接至少 6 位字母/数字/ - _）",
          preview: redact(token),
        });
        continue;
      }
      const fp = keyFingerprint(token);
      if (seen.has(fp)) {
        duplicate += 1;
        continue;
      }
      if (entries.length >= max) {
        truncated += 1;
        continue;
      }
      seen.set(fp, entries.length);
      entries.push({ apiKey: token, label, line: lineNo });
    }
  }

  const stats = {
    lines: lines.length,
    linesWithKey: lineWithKey,
    linesWithoutKey: lineWithoutKey,
    tokensFound: totalTokens,
    imported: entries.length,
    duplicate,
    invalidShape,
    truncated,
  };

  if (truncated > 0) {
    errors.push({ line: 0, reason: `超过单次上限 ${max} 个，其余 ${truncated} 个已忽略`, preview: "" });
  }

  return { entries, errors, stats };
}

/** 校验一个 Key 的静态形态；给 CLI/登录共用。 */
export function isValidKey(value) {
  return KEY_RE.test(typeof value === "string" ? value.trim() : "");
}

/** 把 entries 转成稳定的去重列表（按指纹），供写入前的最后一道保险。 */
export function dedupeEntries(entries = []) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const fp = keyFingerprint(e?.apiKey);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    out.push(e);
  }
  return out;
}
