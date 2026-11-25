// src/prompt-cache.mjs — 条件性 prompt cache 标记。
// 100milionseek 的 /v1 是 OpenAI 兼容外壳；是否认 cache_control 未实测，
// 因此默认关闭（options.promptCache=false），只在显式打开时改写请求体。
// 原则：改写失败 / 结构不认识 → 原样返回原 body，绝不因为优化而让请求失败。

const MAX_MARK = 4; // 最多标 4 段，和 Anthropic 的断点上限一致

function textOf(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (typeof part === "string") n += part.length;
      else if (typeof part?.text === "string") n += part.text.length;
    }
    return n;
  }
  return 0;
}

function alreadyMarked(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => part && typeof part === "object" && part.cache_control);
}

/**
 * 给长前缀打 cache_control。
 * 规则：system 优先，其次最早的用户消息；只标「长的」那几段。
 * @param {any} payload 已 JSON.parse 的请求体
 * @param {number} minChars
 * @returns {any} 新对象（不修改入参）
 */
export function applyPromptCache(payload, minChars = 2_000) {
  if (!payload || typeof payload !== "object") return payload;
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || !messages.length) return payload;
  const threshold = Math.max(1, Number(minChars) || 2_000);

  let marks = 0;
  let changed = false;
  const next = messages.map((msg) => {
    if (marks >= MAX_MARK || !msg || typeof msg !== "object") return msg;
    const len = textOf(msg.content);
    if (len < threshold) return msg;
    if (alreadyMarked(msg.content)) {
      marks += 1;
      return msg;
    }
    // 字符串 content 要升级成 parts 数组才能挂 cache_control
    const parts =
      typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.slice()
          : null;
    if (!parts || !parts.length) return msg;
    const last = parts[parts.length - 1];
    if (!last || typeof last !== "object") return msg;
    parts[parts.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
    marks += 1;
    changed = true;
    return { ...msg, content: parts };
  });

  if (!changed) return payload;
  return { ...payload, messages: next };
}

/**
 * 对字符串 body 走一遍；非 JSON / 非对象体直接原样返回。
 * @param {any} body fetch 的 body
 * @param {{enabled?:boolean,minChars?:number}} [opts]
 */
export function maybeApplyPromptCache(body, opts = {}) {
  if (!opts.enabled) return body;
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return body;
  let text;
  try {
    text = typeof body === "string" ? body : new TextDecoder().decode(body);
  } catch {
    return body;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return body;
  }
  const patched = applyPromptCache(payload, opts.minChars);
  if (patched === payload) return body;
  try {
    return JSON.stringify(patched);
  } catch {
    return body;
  }
}
