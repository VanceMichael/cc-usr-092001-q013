import { DomainError, ErrorCode } from "./errors.js";

/**
 * 逐件合规核验：一箱货在某时刻依据目的国现行规则，比对批次配方事实与所用标签版式。
 *
 * 核验维度：
 * 1. 标签必须基于该批次所用的确切配方版本（formula_digest 一致）；
 * 2. 中文标识保留（规则要求时必须出现 zh）；
 * 3. 目的国强制语言全部出现；
 * 4. 配方全部过敏原与目的国强制过敏原均已申报；
 * 5. 营养表格式符合规则，强制营养素齐全，标签数值与配方事实偏差在容差内；
 * 6. 不含目的国禁用声称；
 * 7. 包装材料、原产地/进口商/可回收标志满足规范。
 *
 * 结论只针对传入的这一箱（及其目的地）；调用方据此仅阻断对应目的地的货物。
 */
export function evaluateCarton({ recipe, label, rule }) {
  const findings = [];
  const block = (code, message) => findings.push({ severity: "BLOCK", code, message });

  if (label.recipe_id !== recipe.recipe_id) {
    block(
      "LABEL_RECIPE_MISMATCH",
      `标签 ${label.label_id} 基于配方 ${label.recipe_id}，批次实际使用 ${recipe.recipe_id}`,
    );
  }

  // 语言：传统中文标识保留 + 目的国强制语言
  if (rule.require_chinese_presence && !label.languages.includes("zh")) {
    block("CHINESE_LABEL_MISSING", "必须保留传统中文标识（zh）");
  }
  for (const language of rule.languages_required) {
    if (!label.languages.includes(language)) {
      block("REQUIRED_LANGUAGE_MISSING", `缺少目的国强制语言：${language}`);
    }
  }

  // 过敏原：配方事实集合与目的国强制集合都必须被标签申报覆盖
  for (const allergen of recipe.allergens) {
    if (!label.declared_allergens.includes(allergen)) {
      block("ALLERGEN_UNDECLARED", `配方含过敏原 ${allergen} 但标签未申报`);
    }
  }
  for (const allergen of rule.allergen_required) {
    if (!label.declared_allergens.includes(allergen)) {
      block("REQUIRED_ALLERGEN_MISSING", `目的国强制申报过敏原缺失：${allergen}`);
    }
  }

  // 营养声明
  if (label.nutrition_format !== rule.nutrition_format) {
    block(
      "NUTRITION_FORMAT_MISMATCH",
      `营养表格式 ${label.nutrition_format} 不符合目的国要求 ${rule.nutrition_format}`,
    );
  }
  for (const nutrient of rule.required_nutrients) {
    if (!(nutrient in label.declared_nutrition)) {
      block("REQUIRED_NUTRIENT_MISSING", `营养表缺少强制项：${nutrient}`);
    }
  }
  for (const [nutrient, declared] of Object.entries(label.declared_nutrition)) {
    const actual = recipe.nutrition[nutrient];
    if (actual == null) {
      block("NUTRIENT_NOT_IN_RECIPE", `标签声明的 ${nutrient} 不存在于配方营养事实`);
      continue;
    }
    const tolerance = actual * rule.nutrition_tolerance;
    if (Math.abs(declared - actual) > tolerance + 1e-9) {
      block(
        "NUTRITION_VALUE_OUT_OF_TOLERANCE",
        `${nutrient} 标签值 ${declared} 与配方值 ${actual} 偏差超过 ${rule.nutrition_tolerance * 100}%`,
      );
    }
  }

  // 声称
  for (const claim of label.claims) {
    if (rule.prohibited_claims.includes(claim)) {
      block("PROHIBITED_CLAIM", `目的国禁用声称：${claim}`);
    }
  }

  // 包装规范
  const materials = label.packaging_spec.material_codes;
  for (const material of materials) {
    if (rule.packaging_requirements.forbid_materials.includes(material)) {
      block("FORBIDDEN_PACKAGING_MATERIAL", `包装使用目的国禁用材料：${material}`);
    }
  }
  const allowed = rule.packaging_requirements.allowed_materials;
  if (allowed) {
    for (const material of materials) {
      if (!allowed.includes(material)) {
        block("PACKAGING_MATERIAL_NOT_ALLOWED", `包装材料 ${material} 不在目的国允许清单内`);
      }
    }
  }
  const marks = label.packaging_spec.marks;
  if (rule.packaging_requirements.require_origin_mark && !marks.origin) {
    block("ORIGIN_MARK_MISSING", "缺少原产地标志");
  }
  if (rule.packaging_requirements.require_importer_details && !marks.importer) {
    block("IMPORTER_DETAILS_MISSING", "缺少进口商信息");
  }
  if (rule.packaging_requirements.require_recyclable_mark && !marks.recyclable) {
    block("RECYCLABLE_MARK_MISSING", "缺少可回收标志");
  }

  return { passed: findings.length === 0, findings };
}

/** 持久化一次核验结论，返回决策行内容。 */
export function recordDecision(database, { cartonRef, rule, recipe, label, result, trigger, decidedAt }) {
  const decisionId = `DC-${cartonRef}-${trigger}-${Date.parse(decidedAt)}-${Math.random().toString(36).slice(2, 8)}`;
  database
    .prepare(
      `INSERT INTO compliance_decisions(decision_id, carton_ref, rule_id, recipe_id, label_id,
                                        formula_digest, label_digest, passed, findings,
                                        trigger, decided_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      decisionId,
      cartonRef,
      rule.rule_id,
      recipe.recipe_id,
      label.label_id,
      recipe.formula_digest,
      label.label_digest,
      result.passed ? 1 : 0,
      JSON.stringify(result.findings),
      trigger,
      decidedAt,
    );
  return decisionId;
}

export function latestDecision(database, cartonRef) {
  const row = database
    .prepare("SELECT * FROM compliance_decisions WHERE carton_ref = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1")
    .get(cartonRef);
  return row ? { ...row, passed: row.passed === 1, findings: JSON.parse(row.findings) } : null;
}

export function assertPassed(decision) {
  if (!decision || !decision.passed) {
    throw new DomainError(
      ErrorCode.COMPLIANCE_BLOCKED,
      `货物被合规阻断：${(decision?.findings ?? []).map((f) => f.message).join("；") || "尚无核验结论"}`,
      { findings: decision?.findings ?? [] },
    );
  }
}
