import { openMemoryDatabase } from "../../src/db.js";
import { createApp } from "../../src/app.js";

export const T = {
  JAN: "2026-01-01T00:00:00+08:00",
  SEP: "2026-09-05T09:00:00+10:00",
  SEP_KR: "2026-09-05T09:00:00+09:00",
  RULE2_AT: "2026-09-11T00:00:00+10:00",
};

/** 构造一套标准主数据：一个产品、一版配方、澳/韩规则。 */
export function buildApp() {
  const db = openMemoryDatabase();
  const app = createApp(db);
  seed(app);
  return app;
}

export function seed(app) {
  const c = (type, payload) => app.command(type, payload);

  c("product.registered", { sku: "MOON-A", name_cn: "黄庄双黄莲蓉月饼" });
  c("recipe.created", {
    sku: "MOON-A",
    version: "v1",
    effective_from: T.JAN,
    ingredients: ["面粉", "莲蓉", "咸蛋黄"],
    allergens: ["EGG", "WHEAT"],
    nutrition: { energy_kj: 1700, sugar_g: 35, fat_g: 20 },
  });
  c("rule.created", auRule("2026.1", T.JAN, { allergen_required: ["EGG", "WHEAT", "PEANUT"] }));
  c("rule.created", {
    country_code: "kr",
    version: "2026.1",
    effective_from: "2026-01-01T00:00:00+09:00",
    languages_required: ["ko"],
    allergen_required: ["EGG", "WHEAT"],
    nutrition_format: "PER_100G_TABLE",
    required_nutrients: ["energy_kj", "sugar_g", "fat_g"],
    prohibited_claims: [],
    packaging_requirements: { require_origin_mark: true, forbid_materials: [] },
  });
  c("label.created", compliantLabel("au-good", ["zh", "en"], ["EGG", "WHEAT", "PEANUT"]));
  c("label.created", compliantLabel("kr-good", ["zh", "ko"], ["EGG", "WHEAT"]));
  return app;
}

export function auRule(version, effectiveFrom, overrides = {}) {
  return {
    country_code: "au",
    version,
    effective_from: effectiveFrom,
    languages_required: ["en"],
    allergen_required: ["EGG", "WHEAT", "PEANUT"],
    nutrition_format: "PER_100G_TABLE",
    required_nutrients: ["energy_kj", "sugar_g", "fat_g"],
    prohibited_claims: ["CURES_DISEASE"],
    packaging_requirements: {
      require_origin_mark: true,
      require_importer_details: true,
      forbid_materials: ["PVC"],
    },
    ...overrides,
  };
}

export function compliantLabel(layoutVersion, languages, allergens, overrides = {}) {
  return {
    sku: "MOON-A",
    recipe_id: "RC-MOON-A-v1",
    layout_version: layoutVersion,
    languages,
    declared_allergens: allergens,
    declared_nutrition: { energy_kj: 1700, sugar_g: 35, fat_g: 20 },
    nutrition_format: "PER_100G_TABLE",
    claims: [],
    packaging_spec: {
      material_codes: ["PAPER"],
      net_weight_g: 720,
      marks: { origin: true, importer: true, recyclable: false },
    },
    ...overrides,
  };
}

/** 建订单 + 生产/拆批/分配/装箱，返回各引用。 */
export function setupCarton(app, { country = "AU", orderId, batchId, childId, allocationId, cartonRef, labelId, quantity = 100, distributor = "D-SYD", client = "C-AU-1", price } = {}) {
  const c = (type, payload) => app.command(type, payload);
  c("order.placed", {
    order_id: orderId, client_ref: client, distributor_ref: distributor,
    sku: "MOON-A", country_code: country, quantity,
    ...(price ? { contract_price: price } : {}),
  });
  c("batch.produced", {
    batch_id: batchId, sku: "MOON-A", recipe_id: "RC-MOON-A-v1",
    quantity, produced_at: "2026-09-01T08:00:00+08:00",
  });
  c("batch.split", { parent_batch_id: batchId, child_batch_id: childId, quantity });
  c("batch.allocated", { allocation_id: allocationId, order_id: orderId, batch_id: childId, quantity });
  c("cartons.packed", { allocation_id: allocationId, label_id: labelId, cartons: [{ carton_ref: cartonRef, quantity }] });
}
