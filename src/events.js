import { DomainError, ErrorCode } from "./errors.js";
import { sha256Json } from "./digest.js";
import { nowIso, parseInstant } from "./time.js";

/**
 * 接收一个外部交换事件并在同一事务内执行 apply。
 *
 * 幂等规则：
 * - 同一 event_id 重放：返回首次处理结果，不执行业务、不增加货量；
 * - 同一 (source, source_sequence) 但 event_id 不同：拒绝（CONFLICT）；
 * - 发生时间以事件自带 occurred_at 为准，接收方只另记 received_at。
 */
export function receiveEvent(database, input, apply) {
  const eventId = requireString(input, "event_id");
  const source = requireString(input, "source");
  const eventType = requireString(input, "event_type");
  const occurredAt = parseInstant(input.occurred_at ?? input.occurredAt, "occurred_at");
  const sourceSequence = Number(input.source_sequence ?? input.sourceSequence);
  if (!Number.isInteger(sourceSequence) || sourceSequence < 0) {
    throw new DomainError(ErrorCode.VALIDATION, "source_sequence 必须是非负整数");
  }
  const payload = input.payload ?? {};
  const subjectRef = input.subject_ref ?? input.subjectRef ?? null;

  database.prepare("BEGIN IMMEDIATE").run();
  let committed = false;
  let rolledBack = false;
  const rollback = () => {
    if (!committed && !rolledBack) {
      database.exec("ROLLBACK");
      rolledBack = true;
    }
  };
  try {
    const byId = database.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
    if (byId) {
      rollback();
      return { duplicate: true, event_id: eventId, result: JSON.parse(byId.result ?? "null") };
    }
    const bySeq = database
      .prepare("SELECT event_id FROM events WHERE source = ? AND source_sequence = ?")
      .get(source, sourceSequence);
    if (bySeq) {
      rollback();
      throw new DomainError(
        ErrorCode.CONFLICT,
        `来源 ${source} 的序号 ${sourceSequence} 已用于事件 ${bySeq.event_id}`,
        { existing_event_id: bySeq.event_id },
      );
    }

    let result;
    try {
      result = apply({
        database,
        payload,
        event: { eventId, source, sourceSequence, subjectRef, eventType, occurredAt },
      });
    } catch (error) {
      rollback();
      throw error;
    }
    database
      .prepare(
        `INSERT INTO events(event_id, source, source_sequence, subject_ref, event_type,
                            occurred_at, received_at, payload_digest, payload, result)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        source,
        sourceSequence,
        subjectRef,
        eventType,
        occurredAt,
        nowIso(),
        sha256Json(payload),
        JSON.stringify(payload),
        JSON.stringify(result ?? null),
      );
    database.exec("COMMIT");
    committed = true;
    return { duplicate: false, event_id: eventId, result: result ?? null };
  } catch (error) {
    rollback();
    throw error;
  }
}

function requireString(input, field) {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 为必填字符串`);
  }
  return value;
}
