// src/cache-key.mjs — 凭据指纹；auth / bulk-import 共用，绕开循环 import。
import { createHash } from "node:crypto";

const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex");

/** 同一把 Key 在不同登录方式下必须落同一个值，否则批量导入会造重复账号。 */
export function keyFingerprint(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? sha1(s).slice(0, 12) : "";
}
