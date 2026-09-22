import assert from "node:assert/strict";
import test from "node:test";

import {
  arriveShipment,
  createShipment,
  departShipment,
  explainCase,
  getRecall,
  issueRecall,
  loadCase,
  mergeLots,
  recordReceipt,
  repurchaseReport,
  scanCase,
  splitLot,
} from "../src/store.js";
import { freshDb, makeInspectedLot, seedMasterData, T } from "./helpers.js";

// 搭一条完整链路：两个批次、两个市场、部分售罄。
function setupChain() {
  const db = freshDb();
  seedMasterData(db);
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 1000 });
  makeInspectedLot(db, { batchId: "B-2", lotId: "L-2", qty: 500 });

  // B-1 拆分：400 发 AU，600 与 B-2 的 200 合并后发 KR。
  splitLot(db, "L-1", {
    parts: [
      { id: "L-1A", qty: 400 },
      { id: "L-1B", qty: 600 },
    ],
    at: T.pack,
  });
  splitLot(db, "L-2", {
    parts: [
      { id: "L-2A", qty: 200 },
      { id: "L-2B", qty: 300 },
    ],
    at: T.pack,
  });
  mergeLots(db, { lot_ids: ["L-1B", "L-2A"], new_lot_id: "L-M", at: T.pack });

  scanCase(db, {
    case_ref: "CASE-AU-1",
    lot_id: "L-1A",
    qty: 200,
    market: "AU",
    dealer_ref: "DEALER-A",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  scanCase(db, {
    case_ref: "CASE-KR-1",
    lot_id: "L-M",
    qty: 300,
    market: "KR",
    dealer_ref: "DEALER-K",
    label_layout_id: "LBL-KO-V1",
    packed_at: T.pack,
  });
  scanCase(db, {
    case_ref: "CASE-KR-2",
    lot_id: "L-M",
    qty: 100,
    market: "KR",
    dealer_ref: "DEALER-K2",
    label_layout_id: "LBL-KO-V1",
    packed_at: T.pack,
  });

  createShipment(db, { id: "SHP-AU", market: "AU", created_at: T.pack });
  loadCase(db, "SHP-AU", { case_ref: "CASE-AU-1" });
  departShipment(db, "SHP-AU", { departed_at: T.depart });
  arriveShipment(db, "SHP-AU", { arrived_at: T.arrive });

  createShipment(db, { id: "SHP-KR", market: "KR", created_at: T.pack });
  loadCase(db, "SHP-KR", { case_ref: "CASE-KR-1" });
  loadCase(db, "SHP-KR", { case_ref: "CASE-KR-2" });
  departShipment(db, "SHP-KR", { departed_at: T.depart });
  arriveShipment(db, "SHP-KR", { arrived_at: T.arrive });

  // CASE-AU-1 全部售罄；CASE-KR-1 售罄一半；CASE-KR-2 未动。
  recordReceipt(db, {
    ref: "RCPT-AU-1",
    case_ref: "CASE-AU-1",
    dealer_ref: "DEALER-A",
    qty: 200,
    received_at: T.receipt,
  });
  recordReceipt(db, {
    ref: "RCPT-KR-1",
    case_ref: "CASE-KR-1",
    dealer_ref: "DEALER-K",
    qty: 150,
    received_at: T.receipt,
  });
  return db;
}

test("召回按配方版本精确定位受影响市场与剩余包装", () => {
  const db = setupChain();
  const recall = issueRecall(db, {
    id: "RC-1",
    scope_type: "recipe_version",
    scope_id: "RV-1",
    reason: "花生过敏原标注复核",
    created_at: T.receipt,
  });

  const byMarket = Object.fromEntries(recall.markets.map((m) => [m.market, m]));
  // AU：一箱 200 件已售罄，无剩余包装。
  assert.equal(byMarket.AU.affected_cases, 1);
  assert.equal(byMarket.AU.remaining_packages, 0);
  assert.equal(byMarket.AU.sold_cases, 1);
  // KR：两箱共 400 件受影响，均未售罄，需要追回。
  assert.equal(byMarket.KR.affected_cases, 2);
  assert.equal(byMarket.KR.remaining_packages, 2);
  assert.equal(byMarket.KR.remaining_qty, 400);
  assert.deepEqual(byMarket.KR.dealer_refs, ["DEALER-K", "DEALER-K2"]);

  // 未售罄的箱已置为 recalled，已售罄的保持 sold。
  const kr1 = db.prepare("SELECT status FROM cases WHERE ref = ?").get("CASE-KR-1");
  const au1 = db.prepare("SELECT status FROM cases WHERE ref = ?").get("CASE-AU-1");
  assert.equal(kr1.status, "recalled");
  assert.equal(au1.status, "sold");

  // 可再次读取同一召回。
  const again = getRecall(db, "RC-1");
  assert.equal(again.items.length, 3);
});

test("召回按批次追溯：合并货位的血缘不丢", () => {
  const db = setupChain();
  // B-2 的 200 件经合并进入 L-M，CASE-KR-1/2 部分来自 B-2。
  const recall = issueRecall(db, {
    id: "RC-2",
    scope_type: "batch",
    scope_id: "B-2",
    reason: "批次级复核",
    created_at: T.receipt,
  });
  const caseRefs = recall.items.map((item) => item.case_ref).sort();
  assert.deepEqual(caseRefs, ["CASE-KR-1", "CASE-KR-2"]);
  // B-1 的 AU 货物不在范围内。
  assert.ok(!caseRefs.includes("CASE-AU-1"));
});

test("解释：一箱产品为何获准出口", () => {
  const db = setupChain();
  const explanation = explainCase(db, "CASE-AU-1");

  assert.equal(explanation.decision, "allowed");
  assert.equal(explanation.label.language, "en");
  assert.equal(explanation.label.id, "LBL-EN-V1");
  assert.equal(explanation.recipe_version.version, "v1");
  assert.equal(explanation.cleared_rule.id, "MR-AU-1");
  assert.equal(explanation.cleared_rule.rule_version, "AU-2026-1");
  assert.deepEqual(explanation.batch_ids, ["B-1"]);
  assert.equal(explanation.shipment.id, "SHP-AU");
  assert.equal(explanation.shipment.cleared_rule_id, "MR-AU-1");
  assert.ok(explanation.checks.every((check) => check.result === "pass"));
  assert.equal(explanation.receipts.length, 1);
  assert.equal(explanation.receipts[0].qty, 200);

  // 合并货位的箱能列出全部来源批次。
  const merged = explainCase(db, "CASE-KR-1");
  assert.deepEqual(merged.batch_ids.sort(), ["B-1", "B-2"]);
});

test("复购汇总：按产品/市场聚合，不泄露经销商合同价格", () => {
  const db = setupChain();
  // DEALER-K 对 CASE-KR-1 再补一张回执，构成复购。
  recordReceipt(db, {
    ref: "RCPT-KR-2",
    case_ref: "CASE-KR-1",
    dealer_ref: "DEALER-K",
    qty: 150,
    received_at: T.receipt,
  });

  const report = repurchaseReport(db, { product_ref: "P-MOONCAKE" });
  const byMarket = Object.fromEntries(report.map((row) => [row.market, row]));

  assert.equal(byMarket.AU.sold_qty, 200);
  assert.equal(byMarket.AU.dealer_count, 1);
  assert.equal(byMarket.AU.repeat_dealer_count, 0);

  assert.equal(byMarket.KR.sold_qty, 300);
  assert.equal(byMarket.KR.receipt_count, 2);
  assert.equal(byMarket.KR.dealer_count, 1);
  assert.equal(byMarket.KR.repeat_dealer_count, 1);

  // 输出中不存在任何价格字段，经销商仅以匿名计数出现。
  const serialized = JSON.stringify(report);
  assert.ok(!/price|contract|金额|单价/i.test(serialized));
  assert.ok(!serialized.includes("DEALER"));
});
