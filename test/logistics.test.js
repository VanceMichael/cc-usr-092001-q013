import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { buildApp, setupCarton, T, auRule } from "./helpers/fixtures.js";

const c = (app, type, payload) => app.command(type, payload);

function readyCarton(app, { cartonRef = "CT1", country = "KR", ...rest } = {}) {
  const labelId = country === "KR" ? "LB-MOON-A-kr-good" : "LB-MOON-A-au-good";
  setupCarton(app, {
    country, orderId: `O-${cartonRef}`, batchId: `B-${cartonRef}`, childId: `BX-${cartonRef}`,
    allocationId: `AL-${cartonRef}`, cartonRef, labelId, quantity: 10,
    distributor: `D-${cartonRef}`, client: `C-${cartonRef}`, ...rest,
  });
  c(app, "carton.inspected", { carton_ref: cartonRef, at: country === "KR" ? T.SEP_KR : T.SEP });
}

test("完整生命周期：检验→报关→装柜→离港→到港→售罄，离港锁定规则版本", () => {
  const app = buildApp();
  readyCarton(app, { cartonRef: "CT1", country: "KR" });
  c(app, "carton.customs_declared", { carton_ref: "CT1", at: "2026-09-06T09:00:00+09:00" });
  c(app, "container.loaded", { container_ref: "CONT1", carton_refs: ["CT1"], at: "2026-09-07T09:00:00+09:00" });
  c(app, "container.departed", { container_ref: "CONT1", at: "2026-09-08T09:00:00+09:00" });
  c(app, "container.arrived", { container_ref: "CONT1", at: "2026-09-12T09:00:00+09:00" });
  c(app, "carton.sold_out", { carton_ref: "CT1", at: "2026-09-20T09:00:00+09:00" });
  assert.equal(app.read.explain("CT1").status, "SOLD_OUT");
  assert.equal(app.read.explain("CT1").compliance.locked_rule_at_departure.rule_id, "RL-KR-2026.1");
});

test("重复扫描各环节均幂等，不新增事件结论之外的任何数据", () => {
  const app = buildApp();
  readyCarton(app, { carton_ref: "CT1", country: "KR" });
  const again = c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP_KR });
  assert.equal(again.idempotent, true);

  c(app, "carton.customs_declared", { carton_ref: "CT1", at: "2026-09-06T09:00:00+09:00" });
  assert.equal(c(app, "carton.customs_declared", { carton_ref: "CT1", at: "2026-09-06T10:00:00+09:00" }).idempotent, true);
  c(app, "container.loaded", { container_ref: "CONT1", carton_refs: ["CT1"], at: "2026-09-07T09:00:00+09:00" });
  // 重复装柜扫描：同柜幂等
  const reload = c(app, "container.loaded", { container_ref: "CONT1", carton_refs: ["CT1"], at: "2026-09-07T10:00:00+09:00" });
  assert.deepEqual(reload.cartons, ["CT1"]);
  // 试图扫入另一货柜：拒绝
  assert.throws(
    () => c(app, "container.loaded", { container_ref: "CONT2", carton_refs: ["CT1"], at: "2026-09-07T11:00:00+09:00" }),
    (e) => e.code === "CONFLICT",
  );
  c(app, "container.departed", { container_ref: "CONT1", at: "2026-09-08T09:00:00+09:00" });
  assert.equal(c(app, "container.departed", { container_ref: "CONT1", at: "2026-09-09T09:00:00+09:00" }).departed[0].idempotent, true);
  c(app, "container.arrived", { container_ref: "CONT1", at: "2026-09-12T09:00:00+09:00" });
  assert.equal(c(app, "container.arrived", { container_ref: "CONT1", at: "2026-09-13T09:00:00+09:00" }).arrived[0].idempotent, true);
  c(app, "carton.sold_out", { carton_ref: "CT1", at: "2026-09-20T09:00:00+09:00" });
  assert.equal(c(app, "carton.sold_out", { carton_ref: "CT1", at: "2026-09-21T09:00:00+09:00" }).idempotent, true);
  // 货量未被任何重复操作改变
  assert.equal(app.read.batch("BX-CT1").conservation.packed, 10);
});

test("跳过状态推进被拒绝（未报关不能装柜）", () => {
  const app = buildApp();
  readyCarton(app, { cartonRef: "CT1", country: "KR" });
  assert.throws(
    () => c(app, "container.loaded", { container_ref: "CONT1", carton_refs: ["CT1"], at: T.SEP_KR }),
    (e) => e.code === "INVALID_TRANSITION",
  );
});

test("规则临时更新：已离港冻结，待报关重评，未生产货物不处理", () => {
  const app = buildApp();
  // CT-KR：完整走到离港
  readyCarton(app, { cartonRef: "CT-KR", country: "KR" });
  c(app, "carton.customs_declared", { carton_ref: "CT-KR", at: "2026-09-06T09:00:00+09:00" });
  c(app, "container.loaded", { container_ref: "CONT1", carton_refs: ["CT-KR"], at: "2026-09-07T09:00:00+09:00" });
  c(app, "container.departed", { container_ref: "CONT1", at: "2026-09-08T09:00:00+09:00" });

  // CT-AU：只装箱检验，等待报关
  readyCarton(app, { cartonRef: "CT-AU", country: "AU" });

  // 未生产：只有订单
  c(app, "order.placed", { order_id: "O-FUTURE", client_ref: "C-F", distributor_ref: "D-AU2", sku: "MOON-A", country_code: "AU", quantity: 50 });

  // 澳洲新规则新增 TREE_NUT 强制过敏原
  c(app, "rule.created", auRule("2026.2", "2026-09-10T00:00:00+10:00", {
    allergen_required: ["EGG", "WHEAT", "PEANUT", "TREE_NUT"],
  }));
  const result = c(app, "rule.update_applied", { country_code: "AU", at: "2026-09-11T00:00:00+10:00" });

  assert.equal(result.applied_rule_id, "RL-AU-2026.2");
  assert.deepEqual(result.reevaluated.map((r) => r.carton_ref), ["CT-AU"]);
  assert.equal(result.reevaluated[0].passed, false);
  assert.ok(result.reevaluated[0].findings.some((f) => f.code === "REQUIRED_ALLERGEN_MISSING"));
  assert.equal(result.frozen_departed.length, 0, "韩国箱不属于 AU，不受影响");

  // 韩国规则即使也更新，已离港韩国箱冻结
  c(app, "rule.created", {
    country_code: "kr", version: "2026.2", effective_from: "2026-09-10T00:00:00+09:00",
    languages_required: ["ko", "en"], allergen_required: ["EGG", "WHEAT"],
    nutrition_format: "PER_100G_TABLE", required_nutrients: ["energy_kj", "sugar_g", "fat_g"],
    packaging_requirements: { require_origin_mark: true, forbid_materials: [] },
  });
  const krUpdate = c(app, "rule.update_applied", { country_code: "KR", at: "2026-09-11T00:00:00+09:00" });
  assert.equal(krUpdate.frozen_departed.length, 1);
  assert.equal(krUpdate.frozen_departed[0].carton_ref, "CT-KR");
  assert.equal(krUpdate.frozen_departed[0].locked_rule_id, "RL-KR-2026.1");
  assert.equal(krUpdate.reevaluated.length, 0);

  // 未生产订单不受重评影响；解释仍按锁定规则
  const explanation = app.read.explain("CT-KR");
  assert.equal(explanation.compliance.locked_rule_at_departure.rule_id, "RL-KR-2026.1");
});

test("批量装柜/离港具备原子性：其中一箱不合格则整批不动", () => {
  const app = buildApp();
  readyCarton(app, { cartonRef: "CT-OK", country: "KR" });
  // 第二箱检验不通过：韩文标签缺 ko
  app.command("label.created", {
    sku: "MOON-A", recipe_id: "RC-MOON-A-v1", layout_version: "kr-bad",
    languages: ["zh"], declared_allergens: ["EGG", "WHEAT"],
    declared_nutrition: { energy_kj: 1700, sugar_g: 35, fat_g: 20 },
    nutrition_format: "PER_100G_TABLE", claims: [],
    packaging_spec: { material_codes: ["PAPER"], net_weight_g: 720, marks: { origin: true } },
  });
  setupCarton(app, {
    country: "KR", orderId: "O-CT-BAD", batchId: "B-CT-BAD", childId: "BX-CT-BAD",
    allocationId: "AL-CT-BAD", cartonRef: "CT-BAD", labelId: "LB-MOON-A-kr-bad",
    quantity: 10, distributor: "D-BAD", client: "C-BAD",
  });
  const bad = c(app, "carton.inspected", { carton_ref: "CT-BAD", at: T.SEP_KR });
  assert.equal(bad.passed, false);

  c(app, "carton.customs_declared", { carton_ref: "CT-OK", at: "2026-09-06T09:00:00+09:00" });
  // CT-BAD 未过检验无法报关，强行把它与 CT-OK 同柜应整体失败
  assert.throws(
    () => c(app, "container.loaded", { container_ref: "CONT1", carton_refs: ["CT-OK", "CT-BAD"], at: "2026-09-07T09:00:00+09:00" }),
    (e) => e instanceof DomainError,
  );
  // CT-OK 未被部分装柜
  assert.equal(app.read.explain("CT-OK").status, "CUSTOMS_DECLARED");
  assert.equal(app.read.explain("CT-OK").destination.container_ref, null);
});
