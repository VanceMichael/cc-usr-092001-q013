import { DomainError, ErrorCode } from "./errors.js";

/** 校验带偏移量的 ISO 8601 时间字符串（如 2026-09-19T09:30:00+08:00）。 */
export function parseInstant(value, field = "occurred_at") {
  if (typeof value !== "string") {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 必须是 ISO 8601 字符串`);
  }
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 不是合法的 ISO 8601 时间`, { field });
  }
  if (!/z$|[+-]\d{2}:\d{2}$/i.test(value)) {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 必须带时区偏移量`, { field });
  }
  return value;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 按物理时刻比较两个带偏移量的时间字符串。 */
export function compareInstant(a, b) {
  return Math.sign(Date.parse(a) - Date.parse(b));
}

/** 时间区间判定：instant >= lower 且 instant < upper（upper 缺省为无穷）。 */
export function withinRange(instant, lower, upper) {
  return compareInstant(instant, lower) >= 0 && (upper == null || compareInstant(instant, upper) < 0);
}
