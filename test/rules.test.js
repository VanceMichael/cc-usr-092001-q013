import assert from "node:assert/strict";
import test from "node:test";

import {
  createBatch,
  createMarketRule,
  createShipment,
  departShipment,
  getBatch,
  getShipment,
  listDestinationBlocks,
  loadCase,
  scanCase,
  submitShipmentForCustoms,
  unloadCase,
} from "../src/store.js";
import { freshDb, makeInspectedLot, seedMasterData, T } from "./helpers.js";

// 场景：规则临时更新（AU 新增禁用配料“蛋黄”）时，
// 已离港、待报关、未生产三类货物必须分别处理。
function setupWithGoods() {
  const db = freshDb();
  seedMasterData(db);
  makeInspectedLot(db, { batchId: "B-1", lotId: "L-1", qty: 300 });

  // 已离港：SHP-DEPARTED 按 MR-AU-1 核准离港。
  scanCase(db, {
    case_ref: "CASE-OUT-1",
    lot_id: "L-1",
    qty: 100,
    market: "AU",
    dealer_ref: "DEALER-A",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  createShipment(db, { id: "SHP-DEPARTED", market: "AU", created_at: T.pack });
  loadCase(db, "SHP-DEPARTED", { case_ref: "CASE-OUT-1" });
  submitShipmentForCustoms(db, "SHP-DEPARTED", { at: T.pack });
  departShipment(db, "SHP-DEPARTED", { departed_at: T.depart });

  // 待报关：SHP-PENDING 已装柜、已转待报关，尚未离港。
  scanCase(db, {
    case_ref: "CASE-PEND-1",
    lot_id: "L-1",
    qty: 100,
    market: "AU",
    dealer_ref: "DEALER-B",
    label_layout_id: "LBL-EN-V1",
    packed_at: T.pack,
  });
  createShipment(db, { id: "SHP-PENDING", market: "AU", created_at: T.pack });
  loadCase(db, "SHP-PENDING", { case_ref: "CASE-PEND-1" });
  submitShipmentForCustoms(db, "SHP-PENDING", { at: T.pack });

  // 未生产：B-2 已排产未投产，配方含蛋黄。
  createBatch(db, {
    id: "B-2",
    product_ref: "P-MOONCAKE",
    recipe_version_id: "RV-1",
    planned_qty: 500,
    created_at: T.pack,
  });
  return db;
}

const AU_RULE_V2 = {
  id: "MR-AU-2",
  market: "AU",
  rule_version: "AU-2026-2",
  required_languages: ["en"],
  banned_ingredients: ["蛋黄"],
  required_allergens: ["蛋", "花生"],
  packaging_requirements: { nutrition_panel: "NIP", date_mark: "best_before" },
  effective_from: T.ruleUpdate,
  created_at: T.ruleUpdate,
};

test("规则更新：已离港货物保留原核准并登记告知", () => {
  const db = setupWithGoods();
  const { reevaluation } = createMarketRule(db, AU_RULE_V2);

  assert.deepEqual(reevaluation.departed_shipments_notified, ["SHP-DEPARTED"]);
  // 既有核准不被追溯：柜次仍按 MR-AU-1 核准，箱状态不变。
  const shipment = getShipment(db, "SHP-DEPARTED");
  assert.equal(shipment.cleared_rule_id, "MR-AU-1");
  assert.equal(shipment.cases[0].status, "departed");
  const notice = db
    .prepare("SELECT * FROM rule_notices WHERE shipment_id = ? AND rule_id = ?")
    .get("SHP-DEPARTED", "MR-AU-2");
  assert.ok(notice);
});

test("规则更新：待报关货物逐箱复评，不合格暂扣并阻断目的地", () => {
  const db = setupWithGoods();
  const { reevaluation } = createMarketRule(db, AU_RULE_V2);

  assert.deepEqual(
    reevaluation.cases_held.map((item) => item.case_ref),
    ["CASE-PEND-1"],
  );
  const unit = db.prepare("SELECT * FROM cases WHERE ref = ?").get("CASE-PEND-1");
  assert.equal(unit.status, "held");
  // 复评留痕可解释。
  const check = db
    .prepare(
      "SELECT * FROM compliance_checks WHERE case_ref = ? AND trigger = 'rule_update' ORDER BY id DESC",
    )
    .get("CASE-PEND-1");
  assert.equal(check.result, "fail");
  assert.deepEqual(JSON.parse(check.failures), ["banned_ingredient:蛋黄"]);
  // 目的地阻断已生效。
  const blocks = listDestinationBlocks(db, { market: "AU", active: true });
  assert.equal(blocks.length, 1);
  // 柜内有暂扣箱，不能离港。
  assert.throws(
    () => departShipment(db, "SHP-PENDING", { departed_at: T.ruleUpdate }),
    (error) => error.code === "held_cases_aboard",
  );
  // 卸下暂扣箱后（阻断仍在，箱保持 held），柜已空，不能离港。
  const unloaded = unloadCase(db, "SHP-PENDING", { case_ref: "CASE-PEND-1" });
  assert.equal(unloaded.status, "held");
  assert.throws(
    () => departShipment(db, "SHP-PENDING", { departed_at: T.ruleUpdate }),
    (error) => error.code === "empty_shipment",
  );
});

test("规则更新：未生产批次标记待调整，且不能继续生产", () => {
  const db = setupWithGoods();
  const { reevaluation } = createMarketRule(db, AU_RULE_V2);

  assert.deepEqual(reevaluation.unproduced_batches_flagged, [
    { batch_id: "B-2", banned_ingredients: ["蛋黄"] },
  ]);
  const batch = getBatch(db, "B-2");
  assert.equal(batch.status, "review");
  assert.match(batch.note, /蛋黄/);
});

test("规则版本链：新版本生效后旧版本自动截止", () => {
  const db = setupWithGoods();
  createMarketRule(db, AU_RULE_V2);
  const oldRule = db.prepare("SELECT * FROM market_rules WHERE id = ?").get("MR-AU-1");
  assert.equal(oldRule.effective_to, T.ruleUpdate);
  // KR 规则链不受影响。
  const krRule = db.prepare("SELECT * FROM market_rules WHERE id = ?").get("MR-KR-1");
  assert.equal(krRule.effective_to, null);
});
