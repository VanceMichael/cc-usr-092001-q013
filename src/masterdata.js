import { DomainError, ErrorCode } from "./errors.js";
import { sha256Json } from "./digest.js";
import { nowIso, parseInstant } from "./time.js";

/* ---------------- 产品 ---------------- */

export function registerProduct(database, { sku, name_cn: nameCn }) {
  if (!sku || !nameCn) {
    throw new DomainError(ErrorCode.VALIDATION, "sku 与 name_cn 必填");
  }
  const existing = database.prepare("SELECT sku FROM products WHERE sku = ?").get(sku);
  if (existing) return { sku, existed: true };
  database
    .prepare("INSERT INTO products(sku, name_cn, payload_digest, created_at) VALUES(?, ?, ?, ?)")
    .run(sku, nameCn, sha256Json({ sku, name_cn: nameCn }), nowIso());
  return { sku, existed: false };
}

/* ---------------- 配方版本（含过敏原与营养事实） ---------------- */

export function createRecipeVersion(database, input) {
  const sku = requireRef(input.sku, "sku");
  const version = requireRef(input.version, "version");
  const product = database.prepare("SELECT sku FROM products WHERE sku = ?").get(sku);
  if (!product) throw new DomainError(ErrorCode.NOT_FOUND, `产品 ${sku} 不存在`);

  const ingredients = requireStringArray(input.ingredients, "ingredients");
  const allergens = requireStringArray(input.allergens, "allergens");
  const nutrition = requireNutrition(input.nutrition);
  const effectiveFrom = parseInstant(input.effective_from, "effective_from");

  if (database.prepare("SELECT 1 FROM recipe_versions WHERE sku = ? AND version = ?").get(sku, version)) {
    throw new DomainError(ErrorCode.CONFLICT, `配方版本 ${sku}@${version} 已存在；配方不可变，请发新版本`);
  }

  const recipeId = input.recipe_id ?? `RC-${sku}-${version}`;
  if (database.prepare("SELECT 1 FROM recipe_versions WHERE recipe_id = ?").get(recipeId)) {
    throw new DomainError(ErrorCode.CONFLICT, `recipe_id ${recipeId} 已存在`);
  }
  const formulaDigest = sha256Json({ ingredients, allergens, nutrition });
  database
    .prepare(
      `INSERT INTO recipe_versions(recipe_id, sku, version, ingredients, allergens, nutrition,
                                   formula_digest, effective_from, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    )
    .run(
      recipeId,
      sku,
      version,
      JSON.stringify(ingredients),
      JSON.stringify(allergens),
      JSON.stringify(nutrition),
      formulaDigest,
      effectiveFrom,
      nowIso(),
    );
  return { recipe_id: recipeId, formula_digest: formulaDigest };
}

export function getRecipe(database, recipeId) {
  const row = database.prepare("SELECT * FROM recipe_versions WHERE recipe_id = ?").get(recipeId);
  if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `配方 ${recipeId} 不存在`);
  return hydrateRecipe(row);
}

export function hydrateRecipe(row) {
  return {
    ...row,
    ingredients: JSON.parse(row.ingredients),
    allergens: JSON.parse(row.allergens),
    nutrition: JSON.parse(row.nutrition),
  };
}

/* ---------------- 标签版式（传统中文标识必须保留） ---------------- */

export function createLabelLayout(database, input) {
  const sku = requireRef(input.sku, "sku");
  const recipeId = requireRef(input.recipe_id, "recipe_id");
  const layoutVersion = requireRef(input.layout_version, "layout_version");
  const recipe = database
    .prepare("SELECT * FROM recipe_versions WHERE recipe_id = ? AND sku = ?")
    .get(recipeId, sku);
  if (!recipe) throw new DomainError(ErrorCode.NOT_FOUND, `产品 ${sku} 下不存在配方 ${recipeId}`);

  const languages = requireStringArray(input.languages, "languages");
  if (!languages.includes("zh")) {
    throw new DomainError(ErrorCode.VALIDATION, "传统中文标识必须保留：languages 必须包含 zh");
  }
  const declaredAllergens = requireStringArray(input.declared_allergens, "declared_allergens");
  const declaredNutrition = requireNutrition(input.declared_nutrition);
  const nutritionFormat = input.nutrition_format ?? "PER_100G_TABLE";
  const claims = requireStringArray(input.claims ?? [], "claims");
  const packagingSpec = requirePackagingSpec(input.packaging_spec);

  if (
    database.prepare("SELECT 1 FROM label_layouts WHERE sku = ? AND layout_version = ?").get(sku, layoutVersion)
  ) {
    throw new DomainError(ErrorCode.CONFLICT, `版式 ${sku}@${layoutVersion} 已存在；版式不可变，请发新版本`);
  }
  const labelId = input.label_id ?? `LB-${sku}-${layoutVersion}`;
  if (database.prepare("SELECT 1 FROM label_layouts WHERE label_id = ?").get(labelId)) {
    throw new DomainError(ErrorCode.CONFLICT, `label_id ${labelId} 已存在`);
  }
  const labelDigest = sha256Json({
    recipe_id: recipeId,
    languages,
    declared_allergens: declaredAllergens,
    declared_nutrition: declaredNutrition,
    claims,
    packaging_spec: packagingSpec,
  });
  database
    .prepare(
      `INSERT INTO label_layouts(label_id, sku, recipe_id, layout_version, languages,
                                 declared_allergens, declared_nutrition, nutrition_format,
                                 claims, packaging_spec, label_digest, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    )
    .run(
      labelId,
      sku,
      recipeId,
      layoutVersion,
      JSON.stringify(languages),
      JSON.stringify(declaredAllergens),
      JSON.stringify(declaredNutrition),
      nutritionFormat,
      JSON.stringify(claims),
      JSON.stringify(packagingSpec),
      labelDigest,
      nowIso(),
    );
  return { label_id: labelId, label_digest: labelDigest };
}

export function getLabel(database, labelId) {
  const row = database.prepare("SELECT * FROM label_layouts WHERE label_id = ?").get(labelId);
  if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `标签版式 ${labelId} 不存在`);
  return hydrateLabel(row);
}

export function hydrateLabel(row) {
  return {
    ...row,
    languages: JSON.parse(row.languages),
    declared_allergens: JSON.parse(row.declared_allergens),
    declared_nutrition: JSON.parse(row.declared_nutrition),
    claims: JSON.parse(row.claims),
    packaging_spec: JSON.parse(row.packaging_spec),
  };
}

/* ---------------- 目的国规则版本（含生效日期） ---------------- */

export function createDestinationRule(database, input) {
  const countryCode = requireRef(input.country_code, "country_code").toUpperCase();
  const version = requireRef(input.version, "version");
  const effectiveFrom = parseInstant(input.effective_from, "effective_from");
  const languagesRequired = requireStringArray(input.languages_required, "languages_required");
  const allergenRequired = requireStringArray(input.allergen_required ?? [], "allergen_required");
  const nutritionFormat = input.nutrition_format ?? "PER_100G_TABLE";
  const requiredNutrients = requireStringArray(input.required_nutrients ?? [], "required_nutrients");
  const tolerance = input.nutrition_tolerance ?? 0.2;
  if (typeof tolerance !== "number" || tolerance < 0 || tolerance > 1) {
    throw new DomainError(ErrorCode.VALIDATION, "nutrition_tolerance 必须是 0 到 1 之间的数值");
  }
  const prohibitedClaims = requireStringArray(input.prohibited_claims ?? [], "prohibited_claims");
  const packagingRequirements = requirePackagingRequirements(input.packaging_requirements ?? {});
  const requireChinesePresence = input.require_chinese_presence === false ? 0 : 1;

  if (
    database
      .prepare("SELECT 1 FROM destination_rules WHERE country_code = ? AND version = ?")
      .get(countryCode, version)
  ) {
    throw new DomainError(ErrorCode.CONFLICT, `规则 ${countryCode}@${version} 已存在；规则不可变，请发新版本`);
  }
  const ruleId = input.rule_id ?? `RL-${countryCode}-${version}`;
  if (database.prepare("SELECT 1 FROM destination_rules WHERE rule_id = ?").get(ruleId)) {
    throw new DomainError(ErrorCode.CONFLICT, `rule_id ${ruleId} 已存在`);
  }
  database
    .prepare(
      `INSERT INTO destination_rules(rule_id, country_code, version, effective_from,
                                     require_chinese_presence, languages_required, allergen_required,
                                     nutrition_format, required_nutrients, nutrition_tolerance,
                                     prohibited_claims, packaging_requirements, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EFFECTIVE', ?)`,
    )
    .run(
      ruleId,
      countryCode,
      version,
      effectiveFrom,
      requireChinesePresence,
      JSON.stringify(languagesRequired),
      JSON.stringify(allergenRequired),
      nutritionFormat,
      JSON.stringify(requiredNutrients),
      tolerance,
      JSON.stringify(prohibitedClaims),
      JSON.stringify(packagingRequirements),
      nowIso(),
    );
  return { rule_id: ruleId, country_code: countryCode, effective_from: effectiveFrom };
}

export function hydrateRule(row) {
  return {
    ...row,
    require_chinese_presence: row.require_chinese_presence === 1,
    languages_required: JSON.parse(row.languages_required),
    allergen_required: JSON.parse(row.allergen_required),
    required_nutrients: JSON.parse(row.required_nutrients),
    prohibited_claims: JSON.parse(row.prohibited_claims),
    packaging_requirements: JSON.parse(row.packaging_requirements),
  };
}

export function getRule(database, ruleId) {
  const row = database.prepare("SELECT * FROM destination_rules WHERE rule_id = ?").get(ruleId);
  if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `规则 ${ruleId} 不存在`);
  return hydrateRule(row);
}

/**
 * 取某国在指定时刻有效的规则版本：effective_from <= instant 的最新版本。
 * 规则临时更新后，装柜/重评时刻不同会解析出不同版本；已离港箱以离港时锁定的 rule_id 为准。
 */
export function effectiveRuleAt(database, countryCode, instant) {
  const row = database
    .prepare(
      `SELECT * FROM destination_rules
       WHERE country_code = ? AND status = 'EFFECTIVE' AND effective_from <= ?
       ORDER BY effective_from DESC, rowid DESC LIMIT 1`,
    )
    .get(countryCode.toUpperCase(), instant);
  if (!row) {
    throw new DomainError(ErrorCode.NOT_FOUND, `${countryCode} 在 ${instant} 前没有已生效的规则版本`);
  }
  return hydrateRule(row);
}

/* ---------------- 校验助手 ---------------- */

function requireRef(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 为必填字符串`);
  }
  return value;
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 必须是非空字符串数组`);
  }
  return [...value];
}

function requireNutrition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(ErrorCode.VALIDATION, "nutrition 必须是营养素代码到每 100g 数值的映射对象");
  }
  for (const [key, amount] of Object.entries(value)) {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new DomainError(ErrorCode.VALIDATION, `nutrition.${key} 必须是非负数`);
    }
  }
  return { ...value };
}

function requirePackagingSpec(value) {
  if (!value || typeof value !== "object") {
    throw new DomainError(ErrorCode.VALIDATION, "packaging_spec 必填");
  }
  const spec = {
    material_codes: requireStringArray(value.material_codes ?? [], "packaging_spec.material_codes"),
    net_weight_g: value.net_weight_g,
    marks: {
      origin: value.marks?.origin === true,
      importer: value.marks?.importer === true,
      recyclable: value.marks?.recyclable === true,
    },
  };
  if (typeof spec.net_weight_g !== "number" || spec.net_weight_g <= 0) {
    throw new DomainError(ErrorCode.VALIDATION, "packaging_spec.net_weight_g 必须是正数");
  }
  return spec;
}

function requirePackagingRequirements(value) {
  return {
    require_origin_mark: value.require_origin_mark === true,
    require_importer_details: value.require_importer_details === true,
    require_recyclable_mark: value.require_recyclable_mark === true,
    allowed_materials: value.allowed_materials == null ? null : requireStringArray(value.allowed_materials, "allowed_materials"),
    forbid_materials: requireStringArray(value.forbid_materials ?? [], "forbid_materials"),
  };
}
