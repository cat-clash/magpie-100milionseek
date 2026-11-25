// src/timing.mjs — 可选耗时观测。debugTiming 打开才做统计与 stderr 输出，关闭时全是空函数。
// 输出格式：[hms] <path> <status> <totalMs>ms firstChunk=<n>ms  （绝不打印 Key）
const hasPerf = typeof globalThis.performance?.now === "function";

export function nowMs() {
  return hasPerf ? globalThis.performance.now() : Date.now();
}

/**
 * @param {{enabled?:boolean, sink?:(line:string)=>void}} [opts]
 */
export function createTiming(opts = {}) {
  const enabled = opts.enabled === true;
  const sink =
    opts.sink ||
    ((line) => {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        /* 宿主没有 stderr 也不影响主流程 */
      }
    });
  const started = nowMs();
  let firstChunk = -1;

  return {
    enabled,
    /** 记录首个 chunk 到达的耗时（只记第一次）。 */
    markChunk() {
      if (!enabled) return;
      if (firstChunk < 0) firstChunk = nowMs() - started;
    },
    /** 结束并输出一行；status 用响应码，失败时传 0。 */
    finish(path, status) {
      if (!enabled) return;
      const total = nowMs() - started;
      const first = firstChunk < 0 ? "-" : `${firstChunk.toFixed(0)}ms`;
      sink(`[hms] ${path} ${status ?? 0} ${total.toFixed(0)}ms firstChunk=${first}`);
    },
    get elapsed() {
      return nowMs() - started;
    },
  };
}

/**
 * 给流式 body 套一层「只记账不缓冲」的 TransformStream：每个 chunk 原样 enqueue，
 * 第一个 chunk 到达时打点 TTFB，流结束时再打一行总耗时。仅 debugTiming 打开时使用。
 * @param {ReadableStream|null} body
 * @param {ReturnType<typeof createTiming>} timing
 * @param {{path?:string, status?:number}} [meta]
 */
export function tapStream(body, timing, meta = {}) {
  if (!body || typeof TransformStream !== "function") return body;
  const path = meta.path ?? "/";
  const status = meta.status ?? 0;
  try {
    const ts = new TransformStream({
      transform(chunk, controller) {
        timing.markChunk();
        controller.enqueue(chunk);
      },
      flush() {
        timing.finish(path, status);
      },
    });
    return body.pipeThrough(ts);
  } catch {
    // 某些响应 body 不支持 pipeThrough（已是 locked / 非 ReadableStream）
    return body;
  }
}
