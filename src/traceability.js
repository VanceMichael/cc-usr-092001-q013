import { DomainError, ErrorCode } from "./errors.js";
import { nowIso } from "./time.js";
import { getLabel, getRecipe, getRule } from "./masterdata.js";
import { descendantBatches, getBatch, hydrateCarton } from "./batches.js";

/* ---------------- 召回：精确定位受影响市场与剩余包装 ---------------- */

/**
 * 发起召回。scope:
 * - RECIPE：某配方版本 → 使用该配方（含拆分/合并后代）的全部批次货物；
 * - LABEL：某标签版式 → 使用该版式的全部箱；
 * - BATCH：某生产批次 → 沿拆分/合并血缘展开后的全部箱。
 *
 * 结论按箱固化：受影响市场（目的国/经销商）与剩余包装（未售罄箱的数量）。
 */
export function createRecall(database, input) {
  const scope = input.scope;
  const subjectId = input.subject_id;
  if (!["RECIPE", "LABEL", "BATCH"].includes(scope)) {
    throw new DomainError(ErrorCode.VALIDATION, "scope 必须是 RECIPE / LABEL / BATCH");
  }
  if (!subjectId) throw new DomainError(ErrorCode.VALIDATION, "subject_id 必填");

  let cartonRows;
  if (scope === "RECIPE") {
    const recipe = getRecipe(database, subjectId);
    cartonRows = database
      .prepare("SELECT * FROM cartons WHERE sku = ? AND batch_id IN (SELECT batch_id FROM production_batches WHERE recipe_id = ?)")
      .all(recipe.sku, recipe.recipe_id)
      .map(hydrateCarton);
  } else if (scope === "LABEL") {
    getLabel(database, subjectId);
    cartonRows = database
      .prepare("SELECT * FROM cartons WHERE label_id = ?")
      .all(subjectId)
      .map(hydrateCarton);
  } else {
    getBatch(database, subjectId);
    const batchIds = descendantBatches(database, subjectId);
    const placeholders = batchIds.map(() => "?").join(",");
    cartonRows = database
      .prepare(`SELECT * FROM cartons WHERE batch_id IN (${placeholders})`)
      .all(...batchIds)
      .map(hydrateCarton);
  }

  const recallId = input.recall_id ?? `RC-REC-${Date.parse(nowIso())}-${Math.random().toString(36).slice(2, 7)}`;
  database
    .prepare("INSERT INTO recalls(recall_id, scope, subject_id, reason, created_at) VALUES(?, ?, ?, ?, ?)")
    .run(recallId, scope, subjectId, input.reason ?? null, nowIso());

  const insertFinding = database.prepare(
    `INSERT INTO recall_findings(finding_id, recall_id, country_code, batch_id, allocation_id,
                                 carton_ref, label_id, carton_status, remaining)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let index = 0;
  for (const carton of cartonRows) {
    // 售罄货物没有剩余包装；其余状态（含在途、到港）均属剩余可召回包装
    const remaining = carton.status === "SOLD_OUT" ? 0 : carton.quantity;
    insertFinding.run(
      `${recallId}-F${(index += 1)}`,
      recallId,
      carton.country_code,
      carton.batch_id,
      carton.allocation_id,
      carton.carton_ref,
      carton.label_id,
      carton.status,
      remaining,
    );
  }

  return getRecall(database, recallId);
}

export function getRecall(database, recallId) {
  const recall = database.prepare("SELECT * FROM recalls WHERE recall_id = ?").get(recallId);
  if (!recall) throw new DomainError(ErrorCode.NOT_FOUND, `召回 ${recallId} 不存在`);
  const findings = database
    .prepare(
      `SELECT f.*, a.distributor_ref, a.order_id, o.client_ref, c.quantity AS carton_quantity
       FROM recall_findings f
       JOIN allocations a ON f.allocation_id = a.allocation_id
       JOIN orders o ON a.order_id = o.order_id
       JOIN cartons c ON f.carton_ref = c.carton_ref
       WHERE f.recall_id = ?
       ORDER BY f.country_code, f.batch_id, f.carton_ref`,
    )
    .all(recallId);

  const markets = new Map();
  for (const finding of findings) {
    const key = `${finding.country_code}|${finding.distributor_ref}`;
    const market = markets.get(key) ?? {
      country_code: finding.country_code,
      distributor_ref: finding.distributor_ref,
      cartons: 0,
      total_quantity: 0,
      remaining_packages: 0,
      sold_out_quantity: 0,
      statuses: {},
    };
    market.cartons += 1;
    market.total_quantity += finding.carton_quantity;
    market.remaining_packages += finding.remaining;
    if (finding.carton_status === "SOLD_OUT") {
      market.sold_out_quantity += finding.carton_quantity;
    }
    market.statuses[finding.carton_status] = (market.statuses[finding.carton_status] ?? 0) + 1;
    markets.set(key, market);
  }

  return {
    ...recall,
    affected_cartons: findings.length,
    remaining_packages_total: findings.reduce((sum, f) => sum + f.remaining, 0),
    markets: [...markets.values()],
    findings,
  };
}

/* ---------------- 单箱出口解释 ---------------- */

/**
 * 解释一箱产品为何获准出口：批次配方版本、标签语言与版式、检验/离港时适用的规则版本、
 * 完整决策与物流时间线。任何结论都可凭保存的摘要复核。
 */
export function explainCarton(database, cartonRef) {
  const carton = database.prepare("SELECT * FROM cartons WHERE carton_ref = ?").get(cartonRef);
  if (!carton) throw new DomainError(ErrorCode.NOT_FOUND, `箱 ${cartonRef} 不存在`);
  const batch = getBatch(database, carton.batch_id);
  const recipe = getRecipe(database, batch.recipe_id);
  const label = getLabel(database, carton.label_id);
  const allocation = database
    .prepare(
      `SELECT a.*, o.client_ref FROM allocations a
       JOIN orders o ON a.order_id = o.order_id
       WHERE a.allocation_id = ?`,
    )
    .get(carton.allocation_id);

  const decisions = database
    .prepare("SELECT * FROM compliance_decisions WHERE carton_ref = ? ORDER BY decided_at, rowid")
    .all(cartonRef)
    .map((row) => ({
      decision_id: row.decision_id,
      rule_id: row.rule_id,
      recipe_id: row.recipe_id,
      label_id: row.label_id,
      passed: row.passed === 1,
      findings: JSON.parse(row.findings),
      trigger: row.trigger,
      decided_at: row.decided_at,
    }));
  // 重贴标签后，旧标签的通过决策不再代表当前货物；只认与当前标签一致的最新通过决策
  const passing = decisions.filter((d) => d.passed && d.label_id === carton.label_id);
  const appliedDecision = passing.at(-1) ?? null;
  const appliedRule = appliedDecision ? getRule(database, appliedDecision.rule_id) : null;
  const lockedRule = carton.rule_id_at_departure ? getRule(database, carton.rule_id_at_departure) : null;

  const timeline = database
    .prepare("SELECT action, from_status, to_status, occurred_at, note FROM carton_events WHERE carton_ref = ? ORDER BY rowid")
    .all(cartonRef);

  return {
    carton_ref: cartonRef,
    quantity: carton.quantity,
    destination: {
      country_code: carton.country_code,
      distributor_ref: allocation.distributor_ref,
      client_ref: allocation.client_ref,
      container_ref: carton.container_ref,
    },
    production: {
      batch_id: batch.batch_id,
      sku: batch.sku,
      recipe_id: recipe.recipe_id,
      recipe_version: recipe.version,
      formula_digest: recipe.formula_digest,
      allergens: recipe.allergens,
    },
    label: {
      label_id: label.label_id,
      layout_version: label.layout_version,
      languages: label.languages,
      keeps_chinese: label.languages.includes("zh"),
      recipe_id: label.recipe_id,
      label_digest: label.label_digest,
    },
    compliance: {
      passed: appliedDecision != null && carton.held !== 1,
      held: carton.held === 1,
      held_findings: carton.held_findings ? JSON.parse(carton.held_findings) : [],
      applied_rule: appliedRule && ruleSummary(appliedRule),
      locked_rule_at_departure: lockedRule && ruleSummary(lockedRule),
      decisions,
    },
    status: carton.status,
    timeline,
    explanation: buildExplanation({ carton, batch, recipe, label, appliedRule, lockedRule, appliedDecision }),
  };
}

function ruleSummary(rule) {
  return {
    rule_id: rule.rule_id,
    country_code: rule.country_code,
    version: rule.version,
    effective_from: rule.effective_from,
    languages_required: rule.languages_required,
    nutrition_format: rule.nutrition_format,
  };
}

function buildExplanation({ carton, batch, recipe, label, appliedRule, lockedRule, appliedDecision }) {
  if (carton.held === 1 || !appliedDecision) {
    return `箱 ${carton.carton_ref} 当前未获准出口：缺少通过的合规核验或处于扣留状态。`;
  }
  const lines = [
    `箱 ${carton.carton_ref} 来自批次 ${batch.batch_id}，该批次按配方 ${recipe.recipe_id}（版本 ${recipe.version}，摘要 ${recipe.formula_digest.slice(0, 18)}…）生产。`,
    `装箱使用标签 ${label.label_id}（版式 ${label.layout_version}），语言为 ${label.languages.join("、")}，${label.languages.includes("zh") ? "保留了传统中文标识" : "未保留中文标识"}，标签摘要 ${label.label_digest.slice(0, 18)}… 与配方版本绑定一致。`,
    `核验时 ${carton.country_code} 适用规则 ${appliedRule.rule_id}（版本 ${appliedRule.version}，${appliedRule.effective_from} 生效，强制语言 ${appliedRule.languages_required.join("、")}），全部检查通过。`,
  ];
  if (lockedRule) {
    lines.push(`货箱于离港时锁定规则 ${lockedRule.rule_id}；此后规则临时更新对其冻结，仍按该版本解释。`);
  }
  return lines.join("");
}

/* ---------------- 复购汇总（不含任何价格字段） ---------------- */

const REPURCHASE_COLUMNS = `
  distributor_ref,
  COUNT(*) AS order_count,
  SUM(quantity) AS ordered_quantity,
  SUM(fulfilled_qty) AS fulfilled_quantity,
  MIN(created_at) AS first_order_at,
  MAX(created_at) AS last_order_at,
  COUNT(DISTINCT country_code) AS market_count,
  COUNT(DISTINCT sku) AS sku_count
`;

/**
 * 复购汇总：按经销商统计订单数、订购量、满足量、首末单时间。
 * 只从 orders 表聚合，不连接 order_contract_prices——合同价在任何汇总结果中都不出现。
 */
export function repurchaseSummary(database, options = {}) {
  const params = [];
  let where = "";
  if (options.distributor_ref) {
    where = "WHERE distributor_ref = ?";
    params.push(options.distributor_ref);
  }
  const rows = database
    .prepare(
      `SELECT ${REPURCHASE_COLUMNS},
              SUM(CASE WHEN status = 'FULFILLED' THEN 1 ELSE 0 END) AS fulfilled_orders
       FROM orders ${where}
       GROUP BY distributor_ref
       HAVING order_count >= 1
       ORDER BY ordered_quantity DESC, distributor_ref`,
    )
    .all(...params);

  return rows.map((row) => ({
    distributor_ref: row.distributor_ref,
    order_count: row.order_count,
    repeat_orders: row.order_count - 1,
    ordered_quantity: row.ordered_quantity,
    fulfilled_quantity: row.fulfilled_quantity,
    fulfilled_orders: row.fulfilled_orders,
    market_count: row.market_count,
    sku_count: row.sku_count,
    first_order_at: row.first_order_at,
    last_order_at: row.last_order_at,
  }));
}

/* ---------------- 全量数量守恒报告 ---------------- */

export function conservationReport(database) {
  const batches = database.prepare("SELECT batch_id FROM production_batches ORDER BY batch_id").all();
  return batches.map(({ batch_id: batchId }) => {
    const batch = database.prepare("SELECT * FROM production_batches WHERE batch_id = ?").get(batchId);
    const flowedOut = database
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM batch_lineage WHERE parent_batch_id = ?")
      .get(batchId).q;
    const flowedIn = database
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM batch_lineage WHERE child_batch_id = ?")
      .get(batchId).q;
    const expected = batch.initial_qty - flowedOut + flowedIn;
    return {
      batch_id: batchId,
      initial_qty: batch.initial_qty,
      flowed_out: flowedOut,
      flowed_in: flowedIn,
      current_qty: batch.current_qty,
      conserved: expected === batch.current_qty,
    };
  });
}
