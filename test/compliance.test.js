import assert from "node:assert/strict";
import test from "node:test";

import {
  createShipment,
  departShipment,
  liftDestinationBlock,
  listDestinationBlocks,
  loadCase,
  scanCase,
} from "../src/store.js";
import { freshDb, makeInspectedLot, seedMasterData, T } from "./helpers.js";

function setup() {
  const db = freshDb();
  seedMasterData(db);
  return db;
}

const baseScan = {
  lot_id: "L-1",
  qty: 10,
  dealer_ref: "DEALER-A",
  packed_at: T.pack,
};

test("中文标签发往 AU 被拒：语言不被接受", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 100 });
  const result = scanCase(db, {
    ...baseScan,
    case_ref: "CASE-AU-ZH",
    market: "AU",
    label_layout_id: "LBL-ZH-V1",
  });
  assert.equal(result.body.ok, false);
  assert.ok(result.body.failures.includes("language_not_accepted"));
  assert.equal(result.body.rule_id, "MR-AU-1");
  // 检查留痕已落库。
  const check = db
    .prepare("SELECT * FROM compliance_checks WHERE case_ref = ? AND trigger = 'pack_scan'")
    .get("CASE-AU-ZH");
  assert.equal(check.result, "fail");
});

test("标签配方版本与批次配方不一致被拒", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 100 });
  const result = scanCase(db, {
    ...baseScan,
    case_ref: "CASE-MISMATCH",
    market: "AU",
    label_layout_id: "LBL-EN-V2", // 绑定 RV-2，而批次是 RV-1
  });
  assert.equal(result.body.ok, false);
  assert.ok(result.body.failures.includes("label_recipe_mismatch"));
});

test("过敏原漏标被拒", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 100 });
  const result = scanCase(db, {
    ...baseScan,
    case_ref: "CASE-NOPEANUT",
    market: "AU",
    label_layout_id: "LBL-EN-V1-NOPEANUT",
  });
  assert.equal(result.body.ok, false);
  assert.ok(result.body.failures.includes("missing_allergen_declaration:花生"));
});

test("不合格只阻断对应目的地：同批货物 AU 被阻断、KR 照常装柜", () => {
  const db = setup();
  // 同一批次 RV-2（含猪油）分别发往 AU 与 KR。
  makeInspectedLot(db, { batchId: "B-2", lotId: "L-1", qty: 100, recipeVersion: "RV-2" });

  // KR 禁用猪油：扫描不合格，产生目的地阻断。
  const kr = scanCase(db, {
    ...baseScan,
    case_ref: "CASE-KR-1",
    market: "KR",
    label_layout_id: "LBL-KO-V2",
  });
  assert.equal(kr.body.ok, false);
  assert.ok(kr.body.failures.includes("banned_ingredient:猪油"));

  const blocks = listDestinationBlocks(db, { market: "KR", active: true });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].batch_id, "B-2");

  // AU 不禁猪油：同批货物扫描通过、装柜、离港不受影响。
  const au = scanCase(db, {
    ...baseScan,
    case_ref: "CASE-AU-1",
    market: "AU",
    label_layout_id: "LBL-EN-V2",
  });
  assert.equal(au.body.ok, true);
  createShipment(db, { id: "SHP-AU-1", market: "AU", created_at: T.pack });
  const loaded = loadCase(db, "SHP-AU-1", { case_ref: "CASE-AU-1" });
  assert.equal(loaded.body.duplicated, false);
  const departed = departShipment(db, "SHP-AU-1", { departed_at: T.depart });
  assert.equal(departed.body.status, "departed");
  assert.equal(departed.body.cleared_rule_id, "MR-AU-1");
});

test("目的地阻断在解除前禁止装柜，解除后放行", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 100 });

  // 先用中文标签触发一次 AU 阻断。
  scanCase(db, {
    ...baseScan,
    case_ref: "CASE-BAD",
    market: "AU",
    label_layout_id: "LBL-ZH-V1",
  });
  const [block] = listDestinationBlocks(db, { market: "AU", active: true });
  assert.ok(block);

  // 换用合格英文标签的箱可以扫描通过，但阻断未解除仍不能装柜。
  const good = scanCase(db, {
    ...baseScan,
    case_ref: "CASE-GOOD",
    market: "AU",
    label_layout_id: "LBL-EN-V1",
  });
  assert.equal(good.body.ok, true);
  createShipment(db, { id: "SHP-1", market: "AU", created_at: T.pack });
  assert.throws(
    () => loadCase(db, "SHP-1", { case_ref: "CASE-GOOD" }),
    (error) => error.code === "destination_blocked",
  );

  // 其他市场（KR）不受该阻断影响。
  const kr = scanCase(db, {
    ...baseScan,
    case_ref: "CASE-KR-OK",
    market: "KR",
    label_layout_id: "LBL-KO-V1",
  });
  assert.equal(kr.body.ok, true);
  createShipment(db, { id: "SHP-KR", market: "KR", created_at: T.pack });
  assert.doesNotThrow(() => loadCase(db, "SHP-KR", { case_ref: "CASE-KR-OK" }));

  // 解除阻断后 AU 放行。
  liftDestinationBlock(db, block.id, { reason: "已确认换用英文版式", lifted_at: T.pack });
  const loaded = loadCase(db, "SHP-1", { case_ref: "CASE-GOOD" });
  assert.equal(loaded.body.duplicated, false);
});

test("重复装柜扫描不重复计量", () => {
  const db = setup();
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 100 });
  scanCase(db, { ...baseScan, case_ref: "CASE-1", market: "AU", label_layout_id: "LBL-EN-V1" });
  createShipment(db, { id: "SHP-1", market: "AU", created_at: T.pack });
  loadCase(db, "SHP-1", { case_ref: "CASE-1" });
  const again = loadCase(db, "SHP-1", { case_ref: "CASE-1" });
  assert.equal(again.body.duplicated, true);
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM cases WHERE shipment_id = ?")
    .get("SHP-1");
  assert.equal(Number(count.n), 1);
});
