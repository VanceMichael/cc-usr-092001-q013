import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { buildApp, compliantLabel, setupCarton, T } from "./helpers/fixtures.js";

const c = (app, type, payload) => app.command(type, payload);

function packOne(app, { labelId, cartonRef = "CT1", country = "AU", label = "LB-MOON-A-au-good" } = {}) {
  setupCarton(app, {
    country,
    orderId: "O1", batchId: "B1", childId: "B1-A", allocationId: "AL1",
    cartonRef, labelId: label ?? labelId, quantity: 10, distributor: "D1", client: "C1",
  });
}

test("合规货物检验通过并推进到 INSPECTED", () => {
  const app = buildApp();
  packOne(app);
  const result = c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP });
  assert.equal(result.passed, true);
  assert.equal(app.read.batch("B1-A").cartons[0].status, "INSPECTED");
});

test("缺少目的国强制过敏原：检验不通过，箱被扣留但货量不变", () => {
  const app = buildApp();
  app.command("label.created", compliantLabel("au-no-peanut", ["zh", "en"], ["EGG", "WHEAT"]));
  packOne(app, { label: "LB-MOON-A-au-no-peanut" });
  const result = c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP });
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((f) => f.code === "REQUIRED_ALLERGEN_MISSING"));
  const carton = app.read.batch("B1-A").cartons[0];
  assert.equal(carton.held, true);
  assert.equal(carton.status, "PACKED");
  assert.equal(carton.quantity, 10);
});

test("配方过敏原未申报、缺少目的国语言、营养值超差均被识别", () => {
  const app = buildApp();
  app.command("label.created", compliantLabel("bad-label", ["zh"], [], {
    declared_nutrition: { energy_kj: 9999, sugar_g: 35, fat_g: 20 },
  }));
  packOne(app, { label: "LB-MOON-A-bad-label" });
  const result = c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes("REQUIRED_LANGUAGE_MISSING"));
  assert.ok(codes.includes("ALLERGEN_UNDECLARED"));
  assert.ok(codes.includes("REQUIRED_ALLERGEN_MISSING"));
  assert.ok(codes.includes("NUTRITION_VALUE_OUT_OF_TOLERANCE"));
});

test("不合格只阻断对应目的地：澳洲箱被扣留不影响韩国箱出运", async () => {
  const app = buildApp();
  app.command("label.created", compliantLabel("au-no-peanut", ["zh", "en"], ["EGG", "WHEAT"]));
  setupCarton(app, {
    country: "AU", orderId: "O-AU", batchId: "B-AU", childId: "B-AU-X", allocationId: "AL-AU",
    cartonRef: "CT-AU", labelId: "LB-MOON-A-au-no-peanut", quantity: 10, distributor: "D-AU", client: "C-AU",
  });
  setupCarton(app, {
    country: "KR", orderId: "O-KR", batchId: "B-KR", childId: "B-KR-X", allocationId: "AL-KR",
    cartonRef: "CT-KR", labelId: "LB-MOON-A-kr-good", quantity: 10, distributor: "D-KR", client: "C-KR",
  });

  const au = c(app, "carton.inspected", { carton_ref: "CT-AU", at: T.SEP });
  const kr = c(app, "carton.inspected", { carton_ref: "CT-KR", at: T.SEP_KR });
  assert.equal(au.passed, false);
  assert.equal(kr.passed, true);

  c(app, "carton.customs_declared", { carton_ref: "CT-KR", at: T.SEP_KR });
  c(app, "container.loaded", { container_ref: "CONT-KR", carton_refs: ["CT-KR"], at: "2026-09-07T09:00:00+09:00" });
  const depart = c(app, "container.departed", { container_ref: "CONT-KR", at: "2026-09-08T09:00:00+09:00" });
  assert.equal(depart.departed[0].idempotent, false);

  await assert.rejects(
    async () => c(app, "carton.customs_declared", { carton_ref: "CT-AU", at: T.SEP }),
    (e) => e instanceof DomainError && e.code === "COMPLIANCE_BLOCKED",
  );
});

test("扣留箱不能报关；重贴合规标签并复验后可继续出运", () => {
  const app = buildApp();
  app.command("label.created", compliantLabel("au-no-peanut", ["zh", "en"], ["EGG", "WHEAT"]));
  packOne(app, { label: "LB-MOON-A-au-no-peanut" });
  c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP });

  assert.throws(
    () => c(app, "carton.customs_declared", { carton_ref: "CT1", at: T.SEP }),
    (e) => e.code === "COMPLIANCE_BLOCKED",
  );

  c(app, "carton.relabelled", { carton_ref: "CT1", label_id: "LB-MOON-A-au-good", at: T.SEP });
  assert.throws(
    () => c(app, "carton.customs_declared", { carton_ref: "CT1", at: T.SEP }),
    (e) => e.code === "COMPLIANCE_BLOCKED",
  );
  const again = c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP });
  assert.equal(again.passed, true);
  c(app, "carton.customs_declared", { carton_ref: "CT1", at: "2026-09-06T09:00:00+10:00" });
  assert.equal(app.read.batch("B1-A").cartons[0].status, "CUSTOMS_DECLARED");
});

test("离港后不能重贴标签", () => {
  const app = buildApp();
  packOne(app);
  c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP });
  c(app, "carton.customs_declared", { carton_ref: "CT1", at: "2026-09-06T09:00:00+10:00" });
  c(app, "container.loaded", { container_ref: "C1", carton_refs: ["CT1"], at: "2026-09-07T09:00:00+10:00" });
  c(app, "container.departed", { container_ref: "C1", at: "2026-09-08T09:00:00+10:00" });
  assert.throws(
    () => c(app, "carton.relabelled", { carton_ref: "CT1", label_id: "LB-MOON-A-au-good" }),
    /离港/,
  );
});

test("禁用声称与禁用包装材料被拦截", () => {
  const app = buildApp();
  app.command("label.created", compliantLabel("bad-claim", ["zh", "en"], ["EGG", "WHEAT", "PEANUT"], {
    claims: ["CURES_DISEASE"],
    packaging_spec: { material_codes: ["PVC"], net_weight_g: 720, marks: { origin: true, importer: true } },
  }));
  packOne(app, { label: "LB-MOON-A-bad-claim" });
  const result = c(app, "carton.inspected", { carton_ref: "CT1", at: T.SEP });
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes("PROHIBITED_CLAIM"));
  assert.ok(codes.includes("FORBIDDEN_PACKAGING_MATERIAL"));
});
