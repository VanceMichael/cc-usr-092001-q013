import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiError,
  batchOverview,
  mergeLots,
  produceBatch,
  recordReceipt,
  scanCase,
  splitLot,
} from "../src/store.js";
import { freshDb, makeInspectedLot, seedMasterData, T } from "./helpers.js";

function setup() {
  const db = freshDb();
  seedMasterData(db);
  return db;
}

test("拆分数量守恒：子货位之和必须等于父货位", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 1000 });

  assert.throws(
    () =>
      splitLot(db, "L-1", {
        parts: [
          { id: "L-1a", qty: 400 },
          { id: "L-1b", qty: 500 },
        ],
        at: T.pack,
      }),
    (error) => error instanceof ApiError && error.code === "split_not_conserved",
  );

  const { parent, children } = splitLot(db, "L-1", {
    parts: [
      { id: "L-1a", qty: 400 },
      { id: "L-1b", qty: 600 },
    ],
    at: T.pack,
  });
  assert.equal(parent.remaining_qty, 0);
  assert.ok(parent.consumed_by.startsWith("split:"));
  assert.equal(children.reduce((sum, lot) => sum + lot.qty, 0), 1000);

  const overview = batchOverview(db, "B-1");
  assert.equal(overview.conservation.conserved, true);
  assert.equal(overview.conservation.active_lot_qty, 1000);
});

test("装箱扣减货位，重复扫描不增加货量", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 400 });

  const first = scanCase(db, {
    case_ref: "CASE-1",
    lot_id: "L-1",
    qty: 150,
    market: "AU",
    dealer_ref: "DEALER-A",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  assert.equal(first.body.ok, true);
  assert.equal(first.body.duplicated, false);

  // 同一箱号重复扫描：返回首次结果，货位不再扣减。
  const second = scanCase(db, {
    case_ref: "CASE-1",
    lot_id: "L-1",
    qty: 150,
    market: "AU",
    dealer_ref: "DEALER-A",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  assert.equal(second.body.duplicated, true);

  // 同一 event_id 重放：同样不重复计量。
  const third = scanCase(db, {
    event_id: "EV-SCAN-2",
    case_ref: "CASE-2",
    lot_id: "L-1",
    qty: 100,
    market: "AU",
    dealer_ref: "DEALER-A",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  const replay = scanCase(db, {
    event_id: "EV-SCAN-2",
    case_ref: "CASE-2",
    lot_id: "L-1",
    qty: 100,
    market: "AU",
    dealer_ref: "DEALER-A",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  assert.equal(third.replay, false);
  assert.equal(replay.replay, true);

  const overview = batchOverview(db, "B-1");
  assert.equal(overview.conservation.packed_qty, 250);
  assert.equal(overview.conservation.active_lot_remaining, 150);
  assert.equal(overview.conservation.conserved, true);
});

test("装箱不得超过货位剩余，生产不得超过计划", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 100 });
  assert.throws(
    () =>
      scanCase(db, {
        case_ref: "CASE-X",
        lot_id: "L-1",
        qty: 101,
        market: "AU",
        dealer_ref: "DEALER-A",
        label_layout_id: "LBL-EN-V1",
        packed_at: T.pack,
      }),
    (error) => error.code === "insufficient_quantity",
  );
  assert.throws(
    () => produceBatch(db, "B-1", { lot_id: "L-2", qty: 1, at: T.produce }),
    (error) => error.code === "overproduction",
  );
});

test("合并保留血缘，跨批次合并后数量仍守恒", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 600 });
  makeInspectedLot(db, { batchId: "B-2", lotId: "L-2", qty: 200 });

  const merged = mergeLots(db, { lot_ids: ["L-1", "L-2"], new_lot_id: "L-M", at: T.pack });
  assert.equal(merged.lot.qty, 800);
  assert.equal(merged.lot.batch_id, null);

  // 来源货位已消耗，不能再次使用。
  assert.throws(
    () =>
      scanCase(db, {
        case_ref: "CASE-Z",
        lot_id: "L-1",
        qty: 1,
        market: "AU",
        dealer_ref: "DEALER-A",
        label_layout_id: "LBL-EN-V1",
        packed_at: T.pack,
      }),
    (error) => error.code === "lot_consumed",
  );

  scanCase(db, {
    case_ref: "CASE-M1",
    lot_id: "L-M",
    qty: 300,
    market: "KR",
    dealer_ref: "DEALER-K",
    label_layout_id: "LBL-KO-V1",
    packed_at: T.pack,
  });

  // 合并后从 B-1 视角仍能通过血缘看到这 300 件。
  const overview = batchOverview(db, "B-1");
  assert.equal(overview.conservation.conserved, true);
  assert.equal(overview.conservation.packed_qty, 300);
});

test("回执幂等：经销商重传不增加货量，超量与串户被拒绝", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 100 });
  scanCase(db, {
    case_ref: "CASE-1",
    lot_id: "L-1",
    qty: 100,
    market: "AU",
    dealer_ref: "DEALER-A",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  // 手动把箱推进到 arrived 以便登记回执。
  db.prepare("UPDATE cases SET status = 'arrived' WHERE ref = ?").run("CASE-1");

  const first = recordReceipt(db, {
    ref: "RCPT-1",
    case_ref: "CASE-1",
    dealer_ref: "DEALER-A",
    qty: 60,
    received_at: T.receipt,
  });
  assert.equal(first.body.duplicated, false);

  // 经销商重传同一回执号：不增加销量。
  const again = recordReceipt(db, {
    ref: "RCPT-1",
    case_ref: "CASE-1",
    dealer_ref: "DEALER-A",
    qty: 60,
    received_at: T.receipt,
  });
  assert.equal(again.body.duplicated, true);

  // 其他经销商冒传：拒绝。
  assert.throws(
    () =>
      recordReceipt(db, {
        ref: "RCPT-2",
        case_ref: "CASE-1",
        dealer_ref: "DEALER-B",
        qty: 10,
        received_at: T.receipt,
      }),
    (error) => error.code === "dealer_mismatch",
  );

  // 累计超过箱内数量：拒绝。
  assert.throws(
    () =>
      recordReceipt(db, {
        ref: "RCPT-3",
        case_ref: "CASE-1",
        dealer_ref: "DEALER-A",
        qty: 41,
        received_at: T.receipt,
      }),
    (error) => error.code === "receipt_overflow",
  );

  const last = recordReceipt(db, {
    ref: "RCPT-4",
    case_ref: "CASE-1",
    dealer_ref: "DEALER-A",
    qty: 40,
    received_at: T.receipt,
  });
  assert.equal(last.body.duplicated, false);
  const unit = db.prepare("SELECT status FROM cases WHERE ref = ?").get("CASE-1");
  assert.equal(unit.status, "sold");
  const sold = db
    .prepare("SELECT SUM(qty) AS s FROM receipts WHERE case_ref = ?")
    .get("CASE-1");
  assert.equal(Number(sold.s), 100);
});
