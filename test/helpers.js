import { openDatabase } from "../src/schema.js";
import {
  createBatch,
  createLabelLayout,
  createMarketRule,
  createRecipeVersion,
  inspectLot,
  produceBatch,
} from "../src/store.js";

export const T = {
  ruleStart: "2026-01-01T00:00:00+08:00",
  produce: "2026-08-01T09:00:00+08:00",
  pack: "2026-08-20T10:00:00+08:00",
  depart: "2026-08-25T15:00:00+08:00",
  arrive: "2026-09-10T08:00:00+08:00",
  receipt: "2026-09-15T11:00:00+08:00",
  ruleUpdate: "2026-09-01T00:00:00+08:00",
};

export function freshDb() {
  return openDatabase(":memory:");
}

// 基础主数据：一个产品、两版配方（RV-2 含 KR 禁用配料猪油）、
// 三种语言标签、AU/KR 两套目的国规则。
export function seedMasterData(db) {
  createRecipeVersion(db, {
    id: "RV-1",
    product_ref: "P-MOONCAKE",
    version: "v1",
    ingredients: ["莲蓉", "蛋黄", "面粉", "花生油"],
    allergens: ["蛋", "花生"],
    nutrition_claims: ["低糖"],
    created_at: T.produce,
  });
  createRecipeVersion(db, {
    id: "RV-2",
    product_ref: "P-MOONCAKE",
    version: "v2",
    ingredients: ["莲蓉", "猪油", "面粉"],
    allergens: ["蛋"],
    nutrition_claims: [],
    created_at: T.produce,
  });
  createLabelLayout(db, {
    id: "LBL-ZH-V1",
    product_ref: "P-MOONCAKE",
    language: "zh",
    layout_version: "zh-1",
    recipe_version_id: "RV-1",
    allergens_declared: ["蛋", "花生"],
    nutrition_claims: ["低糖"],
    artwork_digest: "sha256:zh-v1",
    effective_from: T.ruleStart,
  });
  createLabelLayout(db, {
    id: "LBL-EN-V1",
    product_ref: "P-MOONCAKE",
    language: "en",
    layout_version: "en-1",
    recipe_version_id: "RV-1",
    allergens_declared: ["蛋", "花生"],
    nutrition_claims: ["低糖"],
    artwork_digest: "sha256:en-v1",
    effective_from: T.ruleStart,
  });
  createLabelLayout(db, {
    id: "LBL-EN-V1-NOPEANUT",
    product_ref: "P-MOONCAKE",
    language: "en",
    layout_version: "en-1x",
    recipe_version_id: "RV-1",
    allergens_declared: ["蛋"],
    nutrition_claims: [],
    artwork_digest: "sha256:en-v1x",
    effective_from: T.ruleStart,
  });
  createLabelLayout(db, {
    id: "LBL-KO-V1",
    product_ref: "P-MOONCAKE",
    language: "ko",
    layout_version: "ko-1",
    recipe_version_id: "RV-1",
    allergens_declared: ["蛋", "花生"],
    nutrition_claims: [],
    artwork_digest: "sha256:ko-v1",
    effective_from: T.ruleStart,
  });
  createLabelLayout(db, {
    id: "LBL-EN-V2",
    product_ref: "P-MOONCAKE",
    language: "en",
    layout_version: "en-2",
    recipe_version_id: "RV-2",
    allergens_declared: ["蛋"],
    nutrition_claims: [],
    artwork_digest: "sha256:en-v2",
    effective_from: T.ruleStart,
  });
  createLabelLayout(db, {
    id: "LBL-KO-V2",
    product_ref: "P-MOONCAKE",
    language: "ko",
    layout_version: "ko-2",
    recipe_version_id: "RV-2",
    allergens_declared: ["蛋"],
    nutrition_claims: [],
    artwork_digest: "sha256:ko-v2",
    effective_from: T.ruleStart,
  });
  createMarketRule(db, {
    id: "MR-AU-1",
    market: "AU",
    rule_version: "AU-2026-1",
    required_languages: ["en"],
    banned_ingredients: [],
    required_allergens: ["蛋", "花生"],
    packaging_requirements: { nutrition_panel: "NIP", date_mark: "best_before" },
    effective_from: T.ruleStart,
    created_at: T.ruleStart,
  });
  createMarketRule(db, {
    id: "MR-KR-1",
    market: "KR",
    rule_version: "KR-2026-1",
    required_languages: ["ko"],
    banned_ingredients: ["猪油"],
    required_allergens: ["蛋", "花生"],
    packaging_requirements: { nutrition_panel: "나트륨표기" },
    effective_from: T.ruleStart,
    created_at: T.ruleStart,
  });
}

// 建一个已检验通过的货位。
export function makeInspectedLot(db, { batchId, lotId, qty, recipeVersion = "RV-1", planned }) {
  if (batchId) {
    createBatch(db, {
      id: batchId,
      product_ref: "P-MOONCAKE",
      recipe_version_id: recipeVersion,
      planned_qty: planned ?? qty,
      created_at: T.produce,
    });
  }
  produceBatch(db, batchId, { lot_id: lotId, qty, at: T.produce });
  inspectLot(db, lotId, { result: "pass", at: T.produce });
  return lotId;
}
