import assert from "node:assert/strict";
import test from "node:test";

import { buildApp, setupCarton, T } from "./helpers/fixtures.js";

const c = (app, type, payload) => app.command(type, payload);

function shipCarton(app, cartonRef, country, { soldOut = false } = {}) {
  const labelId = country === "KR" ? "LB-MOON-A-kr-good" : "LB-MOON-A-au-good";
  const suffix = cartonRef;
  setupCarton(app, {
    country, orderId: `O-${suffix}`, batchId: `B-${suffix}`, childId: `BX-${suffix}`,
    allocationId: `AL-${suffix}`, cartonRef, labelId, quantity: 10,
    distributor: `D-${country}`, client: `C-${suffix}`,
    price: country === "AU" ? { amount_minor: 28800, currency: "AUD" } : undefined,
  });
  c(app, "carton.inspected", { carton_ref: cartonRef, at: country === "KR" ? T.SEP_KR : T.SEP });
  c(app, "carton.customs_declared", { carton_ref: cartonRef, at: `2026-09-06T09:00:00${country === "KR" ? "+09:00" : "+10:00"}` });
  c(app, "container.loaded", { container_ref: `CONT-${suffix}`, carton_refs: [cartonRef], at: `2026-09-07T09:00:00${country === "KR" ? "+09:00" : "+10:00"}` });
  c(app, "container.departed", { container_ref: `CONT-${suffix}`, at: `2026-09-08T09:00:00${country === "KR" ? "+09:00" : "+10:00"}` });
  c(app, "container.arrived", { container_ref: `CONT-${suffix}`, at: `2026-09-12T09:00:00${country === "KR" ? "+09:00" : "+10:00"}` });
  if (soldOut) c(app, "carton.sold_out", { carton_ref: cartonRef, at: `2026-09-20T09:00:00${country === "KR" ? "+09:00" : "+10:00"}` });
}

test("按配方召回：精确列出受影响市场，剩余包装不含已售罄数量", () => {
  const app = buildApp();
  shipCarton(app, "CT-AU1", "AU");
  shipCarton(app, "CT-KR1", "KR", { soldOut: true });

  const recall = c(app, "recall.created", { recall_id: "RC-1", scope: "RECIPE", subject_id: "RC-MOON-A-v1", reason: "演练召回" });
  assert.equal(recall.affected_cartons, 2);
  assert.equal(recall.remaining_packages_total, 10, "韩国箱已售罄无剩余，澳洲箱到港未售罄 10 件");

  const byCountry = Object.fromEntries(recall.markets.map((m) => [m.country_code, m]));
  assert.equal(byCountry.AU.remaining_packages, 10);
  assert.equal(byCountry.AU.sold_out_quantity, 0);
  assert.equal(byCountry.KR.remaining_packages, 0);
  assert.equal(byCountry.KR.sold_out_quantity, 10);

  const stored = app.read.recall("RC-1");
  assert.deepEqual(stored.markets.map((m) => m.country_code).sort(), ["AU", "KR"]);
});

test("按标签版式召回：只命中使用该版式的箱", () => {
  const app = buildApp();
  shipCarton(app, "CT-AU1", "AU");
  shipCarton(app, "CT-KR1", "KR");
  const recall = c(app, "recall.created", { scope: "LABEL", subject_id: "LB-MOON-A-au-good" });
  assert.equal(recall.affected_cartons, 1);
  assert.equal(recall.markets[0].country_code, "AU");
});

test("按批次召回：沿拆分血缘展开到子批次的箱", () => {
  const app = buildApp();
  shipCarton(app, "CT-AU1", "AU");
  // 箱实际挂在子批次 BX-CT-AU1 上；从母批次召回必须沿血缘找到它
  const recall = c(app, "recall.created", { scope: "BATCH", subject_id: "B-CT-AU1" });
  assert.equal(recall.affected_cartons, 1);
  assert.equal(recall.findings[0].batch_id, "BX-CT-AU1");
});

test("出口解释：说明配方版本、语言标签与适用规则版本", () => {
  const app = buildApp();
  shipCarton(app, "CT-KR1", "KR");
  const ex = app.read.explain("CT-KR1");
  assert.equal(ex.production.recipe_id, "RC-MOON-A-v1");
  assert.deepEqual(ex.label.languages, ["zh", "ko"]);
  assert.equal(ex.label.keeps_chinese, true);
  assert.equal(ex.compliance.applied_rule.rule_id, "RL-KR-2026.1");
  assert.equal(ex.compliance.locked_rule_at_departure.rule_id, "RL-KR-2026.1");
  assert.match(ex.explanation, /配方 RC-MOON-A-v1/);
  assert.match(ex.explanation, /韩语|ko/);
  assert.match(ex.explanation, /规则 RL-KR-2026\.1/);
  // 时间线完整
  assert.deepEqual(
    ex.timeline.map((t) => t.action),
    ["PACK", "INSPECT", "CUSTOMS_DECLARE", "LOAD", "DEPART", "ARRIVE"],
  );
});

test("复购汇总：复购订单数与数量正确，且任何输出路径都不含合同价", () => {
  const app = buildApp();
  // D1 两次下单（复购），D2 一次
  shipCarton(app, "CT-1", "AU");
  setupCarton(app, {
    country: "AU", orderId: "O-AGAIN", batchId: "B-AGAIN", childId: "BX-AGAIN",
    allocationId: "AL-AGAIN", cartonRef: "CT-2", labelId: "LB-MOON-A-au-good",
    quantity: 5, distributor: "D-AU", client: "C-AGAIN",
    price: { amount_minor: 99999, currency: "AUD" },
  });
  shipCarton(app, "CT-3", "KR");

  const summary = app.read.repurchase();
  const dAu = summary.find((s) => s.distributor_ref === "D-AU");
  assert.equal(dAu.order_count, 2);
  assert.equal(dAu.repeat_orders, 1);
  assert.equal(dAu.ordered_quantity, 15);
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["amount_minor", "99999", "28800", "contract_price", "currency"]) {
    assert.equal(serialized.includes(forbidden), false, `复购汇总泄露了 ${forbidden}`);
  }
});

test("批次详情附守恒结论与箱清单", () => {
  const app = buildApp();
  shipCarton(app, "CT-KR1", "KR");
  const view = app.read.batch("B-CT-KR1");
  assert.equal(view.conservation.current, 0);
  assert.equal(view.conservation.flowed_out, 10);
  const child = app.read.batch("BX-CT-KR1");
  assert.equal(child.conservation.current, 10);
  assert.equal(child.conservation.packed, 10);
});
