import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { buildApp, T } from "./helpers/fixtures.js";

test("event_id 重放完全幂等：返回首次结果，不增加货量", () => {
  const app = buildApp();
  const envelope = {
    event_id: "EVT-1",
    source: "line-scanner-01",
    source_sequence: 1,
    event_type: "order.placed",
    occurred_at: T.SEP,
    subject_ref: "SUBJECT-ORDER-1",
    payload: { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 10 },
  };
  const first = app.ingestEvent(envelope);
  assert.equal(first.duplicate, false);
  const second = app.ingestEvent({ ...envelope, occurred_at: "2026-09-30T00:00:00+10:00" });
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(app.read.repurchase({ distributor_ref: "D1" })[0].order_count, 1);
});

test("同一来源同一序号但 event_id 不同：拒绝冲突", () => {
  const app = buildApp();
  app.ingestEvent({
    event_id: "EVT-1", source: "scanner", source_sequence: 1, event_type: "order.placed",
    occurred_at: T.SEP,
    payload: { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 10 },
  });
  assert.throws(
    () => app.ingestEvent({
      event_id: "EVT-2", source: "scanner", source_sequence: 1, event_type: "order.placed",
      occurred_at: T.SEP,
      payload: { order_id: "O2", client_ref: "C2", distributor_ref: "D2", sku: "MOON-A", country_code: "AU", quantity: 10 },
    }),
    (e) => e instanceof DomainError && e.code === "CONFLICT",
  );
  // 被拒事件没有产生订单
  assert.equal(app.read.repurchase({ distributor_ref: "D2" }).length, 0);
});

test("不同来源可各自独立递增序号", () => {
  const app = buildApp();
  for (const source of ["scanner-a", "scanner-b"]) {
    const r = app.ingestEvent({
      event_id: `EVT-${source}`, source, source_sequence: 1, event_type: "order.placed",
      occurred_at: T.SEP,
      payload: { order_id: `O-${source}`, client_ref: `C-${source}`, distributor_ref: `D-${source}`, sku: "MOON-A", country_code: "AU", quantity: 1 },
    });
    assert.equal(r.duplicate, false);
  }
});

test("原始 occurred_at 被保留，不被到达时间覆盖；payload 摘要落库", () => {
  const app = buildApp();
  app.ingestEvent({
    event_id: "EVT-1", source: "scanner", source_sequence: 1, event_type: "order.placed",
    occurred_at: "2026-05-01T08:00:00+08:00",
    payload: { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 1 },
  });
  const row = app.database.prepare("SELECT occurred_at, received_at, payload_digest FROM events WHERE event_id = 'EVT-1'").get();
  assert.equal(row.occurred_at, "2026-05-01T08:00:00+08:00");
  assert.match(row.received_at, /Z$/);
  assert.match(row.payload_digest, /^sha256:[0-9a-f]{64}$/);
});

test("载荷处理失败时事件不落库，同事件可修正后重试", () => {
  const app = buildApp();
  assert.throws(() => app.ingestEvent({
    event_id: "EVT-BAD", source: "scanner", source_sequence: 1, event_type: "batch.produced",
    occurred_at: T.SEP,
    payload: { batch_id: "B1", sku: "UNKNOWN", recipe_id: "RC-MOON-A-v1", quantity: 10, produced_at: T.SEP },
  }));
  assert.equal(app.database.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = 'EVT-BAD'").get().n, 0);
  // 修正产品后用同一 event_id 重试成功
  const retry = app.ingestEvent({
    event_id: "EVT-BAD", source: "scanner", source_sequence: 1, event_type: "batch.produced",
    occurred_at: T.SEP,
    payload: { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 10, produced_at: T.SEP },
  });
  assert.equal(retry.duplicate, false);
});
