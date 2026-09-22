/** 领域错误：携带调用方可读的 code 与明细，HTTP 层映射为 4xx。 */
export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const ErrorCode = {
  VALIDATION: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  DUPLICATE_EVENT: "DUPLICATE_EVENT",
  QUANTITY_CONSERVATION: "QUANTITY_CONSERVATION_VIOLATED",
  COMPLIANCE_BLOCKED: "COMPLIANCE_BLOCKED",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  RULE_SUPERSEDED: "RULE_SUPERSEDED",
};
