import crypto from "node:crypto";

/** 只保存受控引用和 sha256 摘要：对规范化后的 JSON 计算摘要。 */
export function sha256Json(value) {
  return "sha256:" + crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 稳定序列化：键排序，无键值以外的空白。 */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
}
