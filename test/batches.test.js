import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { buildApp, compliantLabel } from "./helpers/fixtures.js";

const c = (app, type, payload) => app.command(type, payload);

test("拆批守恒：子批次数量之和等于母批次减量", () => {
  const app = buildApp();
  c(app, "batch.produced", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 300, produced_at: "2026-09-01T08:00:00+08:00" });
  c(app, "batch.split", { parent_batch_id: "B1", child_batch_id: "B1-A", quantity: 100 });
  c(app, "batch.split", { parent_batch_id: "B1", child_batch_id: "B1-B", quantity: 150 });

  assert.equal(app.read.batch("B1").batch.current_qty, 50);
  assert.equal(app.read.batch("B1-A").batch.current_qty, 100);
  assert.equal(app.read.batch("B1-B").batch.current_qty, 150);
  for (const report of app.read.conservation()) assert.equal(report.conserved, true, JSON.stringify(report));
});

test("拆出量不能超过母批次可用量（已预留部分不可再拆）", () => {
  const app = buildApp();
  c(app, "batch.produced", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 100, produced_at: "2026-09-01T08:00:00+08:00" });
  c(app, "order.placed", { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 60 });
  c(app, "batch.allocated", { allocation_id: "AL1", order_id: "O1", batch_id: "B1", quantity: 60 });
  assert.throws(
    () => c(app, "batch.split", { parent_batch_id: "B1", child_batch_id: "B1-X", quantity: 50 }),
    (e) => e.code === "QUANTITY_CONSERVATION_VIOLATED",
  );
});

test("合批仅允许同产品同配方版本，且总量守恒", () => {
  const app = buildApp();
  c(app, "batch.produced", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 100, produced_at: "2026-09-01T08:00:00+08:00" });
  c(app, "batch.produced", { batch_id: "B2", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 80, produced_at: "2026-09-02T08:00:00+08:00" });
  const merge = c(app, "batch.merged", { merged_batch_id: "BM", source_batch_ids: ["B1", "B2"] });
  assert.equal(merge.quantity, 180);
  assert.equal(app.read.batch("BM").batch.current_qty, 180);
  assert.equal(app.read.batch("B1").batch.current_qty, 0);
  for (const report of app.read.conservation()) assert.equal(report.conserved, true);
});

test("不同配方版本禁止合批", () => {
  const app = buildApp();
  c(app, "recipe.created", {
    sku: "MOON-A", version: "v2", effective_from: "2026-09-01T00:00:00+08:00",
    ingredients: ["面粉"], allergens: ["WHEAT"], nutrition: { energy_kj: 1000 },
  });
  c(app, "batch.produced", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 100, produced_at: "2026-09-01T08:00:00+08:00" });
  c(app, "batch.produced", { batch_id: "B2", sku: "MOON-A", recipe_id: "RC-MOON-A-v2", quantity: 100, produced_at: "2026-09-01T08:00:00+08:00" });
  assert.throws(
    () => c(app, "batch.merged", { merged_batch_id: "BM", source_batch_ids: ["B1", "B2"] }),
    /同配方/,
  );
});

test("装箱标签与批次配方不一致时拒绝装箱", () => {
  const app = buildApp();
  c(app, "recipe.created", {
    sku: "MOON-A", version: "v2", effective_from: "2026-09-01T00:00:00+08:00",
    ingredients: ["面粉"], allergens: ["WHEAT"], nutrition: { energy_kj: 1000 },
  });
  c(app, "label.created", compliantLabel("v2-label", ["zh", "en"], ["WHEAT"], { recipe_id: "RC-MOON-A-v2" }));
  c(app, "order.placed", { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 10 });
  c(app, "batch.produced", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 10, produced_at: "2026-09-01T08:00:00+08:00" });
  c(app, "batch.allocated", { allocation_id: "AL1", order_id: "O1", batch_id: "B1", quantity: 10 });
  assert.throws(
    () => c(app, "cartons.packed", { allocation_id: "AL1", label_id: "LB-MOON-A-v2-label", cartons: [{ carton_ref: "CT1", quantity: 10 }] }),
    /标签必须与批次配方一致/,
  );
});

test("重复箱号扫描与超分配装箱都被拒绝，货量不增加", () => {
  const app = buildApp();
  c(app, "order.placed", { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 10 });
  c(app, "batch.produced", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 10, produced_at: "2026-09-01T08:00:00+08:00" });
  c(app, "batch.allocated", { allocation_id: "AL1", order_id: "O1", batch_id: "B1", quantity: 10 });
  c(app, "cartons.packed", { allocation_id: "AL1", label_id: "LB-MOON-A-au-good", cartons: [{ carton_ref: "CT1", quantity: 6 }] });
  assert.throws(
    () => c(app, "cartons.packed", { allocation_id: "AL1", label_id: "LB-MOON-A-au-good", cartons: [{ carton_ref: "CT1", quantity: 6 }] }),
    (e) => e.code === "CONFLICT",
  );
  assert.throws(
    () => c(app, "cartons.packed", { allocation_id: "AL1", label_id: "LB-MOON-A-au-good", cartons: [{ carton_ref: "CT2", quantity: 6 }] }),
    (e) => e.code === "QUANTITY_CONSERVATION_VIOLATED",
  );
  const batchView = app.read.batch("B1");
  assert.equal(batchView.conservation.packed, 6);
});

test("经销商重传同一订单不新增货量", () => {
  const app = buildApp();
  const payload = { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 10 };
  const first = c(app, "order.placed", payload);
  const second = c(app, "order.placed", payload);
  assert.equal(first.duplicated, false);
  assert.equal(second.duplicated, true);
  const summary = app.read.repurchase({ distributor_ref: "D1" });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].order_count, 1);
  assert.equal(summary[0].ordered_quantity, 10);
});

test("分配量不能超过订单未满足量，也不能超过批次可用量", () => {
  const app = buildApp();
  c(app, "order.placed", { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "AU", quantity: 10 });
  c(app, "batch.produced", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 8, produced_at: "2026-09-01T08:00:00+08:00" });
  assert.throws(
    () => c(app, "batch.allocated", { allocation_id: "AL1", order_id: "O1", batch_id: "B1", quantity: 9 }),
    (e) => e.code === "QUANTITY_CONSERVATION_VIOLATED",
  );
  c(app, "batch.allocated", { allocation_id: "AL1", order_id: "O1", batch_id: "B1", quantity: 8 });
  const view = app.read.batch("B1");
  assert.equal(view.batch.available_qty, 0);
});
