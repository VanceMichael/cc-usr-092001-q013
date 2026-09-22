import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { buildApp, T, auRule } from "./helpers/fixtures.js";

test("配方与版式不可变，更新必须发新版本", () => {
  const app = buildApp();
  assert.throws(
    () => app.command("recipe.created", {
      sku: "MOON-A", version: "v1", effective_from: T.JAN,
      ingredients: ["x"], allergens: [], nutrition: {},
    }),
    (e) => e instanceof DomainError && e.code === "CONFLICT",
  );
  assert.throws(
    () => app.command("label.created", {
      sku: "MOON-A", recipe_id: "RC-MOON-A-v1", layout_version: "au-good",
      languages: ["zh", "en"], declared_allergens: [], declared_nutrition: {},
      packaging_spec: { material_codes: [], net_weight_g: 100, marks: {} },
    }),
    (e) => e instanceof DomainError && e.code === "CONFLICT",
  );
});

test("标签必须保留传统中文标识", () => {
  const app = buildApp();
  assert.throws(
    () => app.command("label.created", {
      sku: "MOON-A", recipe_id: "RC-MOON-A-v1", layout_version: "en-only",
      languages: ["en"], declared_allergens: ["EGG", "WHEAT", "PEANUT"],
      declared_nutrition: { energy_kj: 1700, sugar_g: 35, fat_g: 20 },
      packaging_spec: { material_codes: ["PAPER"], net_weight_g: 720, marks: { origin: true, importer: true } },
    }),
    /zh/,
  );
});

test("标签必须绑定到产品下真实存在的配方版本", () => {
  const app = buildApp();
  assert.throws(
    () => app.command("label.created", {
      sku: "MOON-A", recipe_id: "RC-NOPE", layout_version: "x",
      languages: ["zh"], declared_allergens: [], declared_nutrition: {},
      packaging_spec: { material_codes: [], net_weight_g: 1, marks: {} },
    }),
    (e) => e.code === "NOT_FOUND",
  );
});

test("规则按生效日期解析：更新前取旧版，更新后取新版", () => {
  const app = buildApp();
  app.command("rule.created", auRule("2026.2", "2026-09-10T00:00:00+10:00", {
    allergen_required: ["EGG", "WHEAT", "PEANUT", "TREE_NUT"],
  }));
  assert.equal(app.read.effectiveRule("AU", "2026-09-09T23:59:00+10:00").version, "2026.1");
  assert.equal(app.read.effectiveRule("AU", "2026-09-10T00:00:00+10:00").version, "2026.2");
});

test("生效时间必须带时区偏移量（含 Z），裸本地时间被拒", () => {
  const app = buildApp();
  // Z（UTC）合法
  app.command("rule.created", auRule("z-ok", "2026-09-10T00:00:00Z"));
  assert.equal(app.read.effectiveRule("AU", "2026-09-10T00:00:00Z").version, "z-ok");
  // 无偏移量的裸时间非法
  assert.throws(
    () => app.command("recipe.created", {
      sku: "MOON-A", version: "v2", effective_from: "2026-09-10 00:00:00",
      ingredients: ["x"], allergens: [], nutrition: {},
    }),
    (e) => e.code === "VALIDATION_FAILED",
  );
});
