// 领域逻辑层：所有函数接收一个已打开的 DatabaseSync 实例。
// 不变量：
//  1. 数量守恒——拆分/合并/装箱/回执只在事务内移动数量，不创造数量。
//  2. 幂等——箱号、回执号、event_id 重复提交返回首次结果，不重复计量。
//  3. 目的地级阻断——不合格只阻断对应 (市场, 配方[, 批次]) 的货物。
//  4. 可解释——每箱都能回答：依据哪版规则、哪种语言标签、哪次检查获准。

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function nowIso() {
  return new Date().toISOString();
}

function fail(status, code, message, details) {
  throw new ApiError(status, code, message, details);
}

function reqString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(400, "invalid_field", `字段 ${name} 必须是非空字符串`);
  }
  return value.trim();
}

function reqIso(value, name) {
  const text = reqString(value, name);
  if (!ISO_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    fail(400, "invalid_field", `字段 ${name} 必须是带偏移量的 ISO 8601 时间`);
  }
  return text;
}

function reqPosInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(400, "invalid_field", `字段 ${name} 必须是正整数`);
  }
  return value;
}

function reqStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(400, "invalid_field", `字段 ${name} 必须是字符串数组`);
  }
  return value;
}

function optionalIso(value, name, fallback) {
  return value === undefined || value === null ? fallback : reqIso(value, name);
}

function asJson(text) {
  return JSON.parse(text);
}

function getRow(database, sql, ...params) {
  return database.prepare(sql).get(...params);
}

function allRows(database, sql, ...params) {
  return database.prepare(sql).all(...params);
}

function mustGet(database, sql, params, code, message) {
  const row = getRow(database, sql, ...params);
  if (!row) fail(404, code, message);
  return row;
}

// 支持嵌套调用：外层已开事务时，内层直接复用，异常统一回滚到最外层。
const transactionDepth = new WeakMap();

function runInTransaction(database, fn) {
  if (transactionDepth.get(database)) {
    return fn();
  }
  transactionDepth.set(database, true);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    transactionDepth.set(database, false);
  }
}

// 事件级幂等：同一 event_id 首次处理的结果被保存，重放原样返回。
function withEvent(database, eventId, kind, fn) {
  if (eventId === undefined || eventId === null) {
    return { replay: false, body: fn() };
  }
  const id = reqString(eventId, "event_id");
  const seen = getRow(database, "SELECT response FROM events WHERE id = ?", id);
  if (seen) {
    return { replay: true, body: JSON.parse(seen.response) };
  }
  const body = runInTransaction(database, () => {
    const produced = fn();
    database
      .prepare("INSERT INTO events(id, kind, response, processed_at) VALUES(?, ?, ?, ?)")
      .run(id, kind, JSON.stringify(produced), nowIso());
    return produced;
  });
  return { replay: false, body };
}

// ---------------------------------------------------------------------------
// 主数据
// ---------------------------------------------------------------------------

export function createRecipeVersion(database, body) {
  const input = {
    id: reqString(body.id, "id"),
    product_ref: reqString(body.product_ref, "product_ref"),
    version: reqString(body.version, "version"),
    ingredients: reqStringArray(body.ingredients, "ingredients"),
    allergens: reqStringArray(body.allergens, "allergens"),
    nutrition_claims: reqStringArray(body.nutrition_claims, "nutrition_claims"),
    created_at: optionalIso(body.created_at, "created_at", nowIso()),
  };
  const duplicated = getRow(
    database,
    "SELECT id FROM recipe_versions WHERE product_ref = ? AND version = ?",
    input.product_ref,
    input.version,
  );
  if (duplicated) {
    fail(409, "duplicate_recipe_version", "同一产品的配方版本号已存在", { id: duplicated.id });
  }
  database
    .prepare(
      `INSERT INTO recipe_versions
         (id, product_ref, version, ingredients, allergens, nutrition_claims, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.product_ref,
      input.version,
      JSON.stringify(input.ingredients),
      JSON.stringify(input.allergens),
      JSON.stringify(input.nutrition_claims),
      input.created_at,
    );
  return getRecipeVersion(database, input.id);
}

export function getRecipeVersion(database, id) {
  const row = mustGet(
    database,
    "SELECT * FROM recipe_versions WHERE id = ?",
    [id],
    "recipe_version_not_found",
    `配方版本不存在：${id}`,
  );
  return {
    ...row,
    ingredients: asJson(row.ingredients),
    allergens: asJson(row.allergens),
    nutrition_claims: asJson(row.nutrition_claims),
  };
}

export function createLabelLayout(database, body) {
  const input = {
    id: reqString(body.id, "id"),
    product_ref: reqString(body.product_ref, "product_ref"),
    language: reqString(body.language, "language"),
    layout_version: reqString(body.layout_version, "layout_version"),
    recipe_version_id: reqString(body.recipe_version_id, "recipe_version_id"),
    allergens_declared: reqStringArray(body.allergens_declared, "allergens_declared"),
    nutrition_claims: reqStringArray(body.nutrition_claims ?? [], "nutrition_claims"),
    artwork_digest: reqString(body.artwork_digest, "artwork_digest"),
    effective_from: reqIso(body.effective_from, "effective_from"),
  };
  getRecipeVersion(database, input.recipe_version_id);
  try {
    database
      .prepare(
        `INSERT INTO label_layouts
           (id, product_ref, language, layout_version, recipe_version_id,
            allergens_declared, nutrition_claims, artwork_digest, effective_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.product_ref,
        input.language,
        input.layout_version,
        input.recipe_version_id,
        JSON.stringify(input.allergens_declared),
        JSON.stringify(input.nutrition_claims),
        input.artwork_digest,
        input.effective_from,
      );
  } catch (error) {
    if (String(error.message).includes("UNIQUE") || String(error.message).includes("PRIMARY")) {
      fail(409, "duplicate_label_layout", `标签版式已存在：${input.id}`);
    }
    throw error;
  }
  return getLabelLayout(database, input.id);
}

export function getLabelLayout(database, id) {
  const row = mustGet(
    database,
    "SELECT * FROM label_layouts WHERE id = ?",
    [id],
    "label_layout_not_found",
    `标签版式不存在：${id}`,
  );
  return {
    ...row,
    allergens_declared: asJson(row.allergens_declared),
    nutrition_claims: asJson(row.nutrition_claims),
  };
}

export function getMarketRule(database, id) {
  const row = mustGet(
    database,
    "SELECT * FROM market_rules WHERE id = ?",
    [id],
    "market_rule_not_found",
    `目的国规则不存在：${id}`,
  );
  return decodeRule(row);
}

function decodeRule(row) {
  return {
    ...row,
    required_languages: asJson(row.required_languages),
    banned_ingredients: asJson(row.banned_ingredients),
    required_allergens: asJson(row.required_allergens),
    packaging_requirements: asJson(row.packaging_requirements),
  };
}

// 某一时刻对市场生效的规则版本（按生效时间取最新）。
export function effectiveRule(database, market, at) {
  const moment = Date.parse(at);
  const candidates = allRows(database, "SELECT * FROM market_rules WHERE market = ?", market)
    .map(decodeRule)
    .filter(
      (rule) =>
        Date.parse(rule.effective_from) <= moment &&
        (rule.effective_to === null || Date.parse(rule.effective_to) > moment),
    );
  candidates.sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from));
  return candidates[0] ?? null;
}

export function listMarketRules(database, market) {
  const rows = market
    ? allRows(database, "SELECT * FROM market_rules WHERE market = ? ORDER BY effective_from", market)
    : allRows(database, "SELECT * FROM market_rules ORDER BY market, effective_from");
  return rows.map(decodeRule);
}

// 登记新规则版本：衔接生效链，并按货物所处环节分别复评。
export function createMarketRule(database, body) {
  const input = {
    id: reqString(body.id, "id"),
    market: reqString(body.market, "market"),
    rule_version: reqString(body.rule_version, "rule_version"),
    required_languages: reqStringArray(body.required_languages, "required_languages"),
    banned_ingredients: reqStringArray(body.banned_ingredients, "banned_ingredients"),
    required_allergens: reqStringArray(body.required_allergens, "required_allergens"),
    packaging_requirements: body.packaging_requirements ?? {},
    effective_from: reqIso(body.effective_from, "effective_from"),
    created_at: optionalIso(body.created_at, "created_at", nowIso()),
  };
  if (typeof input.packaging_requirements !== "object" || Array.isArray(input.packaging_requirements)) {
    fail(400, "invalid_field", "字段 packaging_requirements 必须是对象");
  }
  const duplicated = getRow(
    database,
    "SELECT id FROM market_rules WHERE market = ? AND rule_version = ?",
    input.market,
    input.rule_version,
  );
  if (duplicated) {
    fail(409, "duplicate_market_rule", "同一市场的规则版本号已存在", { id: duplicated.id });
  }

  return runInTransaction(database, () => {
    // 衔接生效链：上一版本在新版本生效时截止。
    const previous = allRows(
      database,
      "SELECT * FROM market_rules WHERE market = ? AND effective_to IS NULL",
      input.market,
    )
      .map(decodeRule)
      .filter((rule) => Date.parse(rule.effective_from) < Date.parse(input.effective_from));
    for (const rule of previous) {
      database
        .prepare("UPDATE market_rules SET effective_to = ? WHERE id = ?")
        .run(input.effective_from, rule.id);
    }

    database
      .prepare(
        `INSERT INTO market_rules
           (id, market, rule_version, required_languages, banned_ingredients,
            required_allergens, packaging_requirements, effective_from, effective_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.market,
        input.rule_version,
        JSON.stringify(input.required_languages),
        JSON.stringify(input.banned_ingredients),
        JSON.stringify(input.required_allergens),
        JSON.stringify(input.packaging_requirements),
        input.effective_from,
        input.created_at,
      );

    const rule = getMarketRule(database, input.id);
    const reevaluation = reevaluateMarket(database, rule, input.created_at);
    return { rule, reevaluation };
  });
}

// 规则临时更新时的分别处理：
//  - 未生产：配方触及新禁令的生产批次标记为 review，等待调整；
//  - 待报关/未离港：逐箱按新规则复评，不合格转为 held 并阻断该目的地；
//  - 已离港/已到港：保留离港时的核准版本，仅登记告知（rule_notices）。
function reevaluateMarket(database, rule, at) {
  const summary = {
    market: rule.market,
    rule_id: rule.id,
    unproduced_batches_flagged: [],
    cases_held: [],
    cases_released: [],
    departed_shipments_notified: [],
  };

  // 1) 未生产/生产中批次：只做配方级预检（禁用配料）。
  const openBatches = allRows(
    database,
    "SELECT * FROM batches WHERE status IN ('planned', 'in_production')",
  );
  for (const batch of openBatches) {
    const recipe = getRecipeVersion(database, batch.recipe_version_id);
    const banned = recipe.ingredients.filter((item) => rule.banned_ingredients.includes(item));
    if (banned.length > 0) {
      database
        .prepare("UPDATE batches SET status = 'review', note = ? WHERE id = ?")
        .run(
          `规则 ${rule.rule_version}（${rule.market}）禁用配料：${banned.join("、")}，待调整配方或另行安排市场`,
          batch.id,
        );
      summary.unproduced_batches_flagged.push({ batch_id: batch.id, banned_ingredients: banned });
    }
  }

  // 2) 未离港的箱（packed / held / loaded）：按新规则逐箱复评。
  const pendingCases = allRows(
    database,
    "SELECT * FROM cases WHERE market = ? AND status IN ('packed', 'held', 'loaded')",
    rule.market,
  );
  for (const unit of pendingCases) {
    const lot = mustGet(database, "SELECT * FROM lots WHERE id = ?", [unit.lot_id], "lot_not_found", "货位不存在");
    const recipe = getRecipeVersion(database, unit.recipe_version_id);
    const label = getLabelLayout(database, unit.label_layout_id);
    const outcome = evaluateCompliance({ rule, recipe, label, at });
    recordCheck(database, {
      case_ref: unit.ref,
      lot_id: lot.id,
      market: rule.market,
      rule_id: rule.id,
      label_layout_id: label.id,
      result: outcome.ok ? "pass" : "fail",
      failures: outcome.failures,
      trigger: "rule_update",
      checked_at: at,
    });
    if (!outcome.ok && unit.status !== "held") {
      database
        .prepare("UPDATE cases SET status = 'held', hold_reason = ? WHERE ref = ?")
        .run(`rule_update:${rule.id}`, unit.ref);
      ensureDestinationBlock(database, {
        market: rule.market,
        recipe_version_id: unit.recipe_version_id,
        batch_id: lot.batch_id,
        reason: `规则更新 ${rule.rule_version} 复评不合格`,
        at,
      });
      summary.cases_held.push({ case_ref: unit.ref, failures: outcome.failures });
    } else if (outcome.ok && unit.status === "held") {
      const restored = unit.shipment_id ? "loaded" : "packed";
      database
        .prepare("UPDATE cases SET status = ?, hold_reason = NULL WHERE ref = ?")
        .run(restored, unit.ref);
      summary.cases_released.push({ case_ref: unit.ref, status: restored });
    }
  }

  // 3) 已离港/已到港的柜：保留既有核准，仅登记告知。
  const departed = allRows(
    database,
    "SELECT * FROM shipments WHERE market = ? AND status IN ('departed', 'arrived')",
    rule.market,
  );
  for (const shipment of departed) {
    database
      .prepare("INSERT INTO rule_notices(shipment_id, rule_id, note, created_at) VALUES(?, ?, ?, ?)")
      .run(
        shipment.id,
        rule.id,
        `市场 ${rule.market} 规则更新至 ${rule.rule_version}；本柜于离港时按既有版本核准，不予追溯`,
        at,
      );
    summary.departed_shipments_notified.push(shipment.id);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// 合规判定
// ---------------------------------------------------------------------------

// 纯函数：给定规则、配方、标签，给出不合格项列表。
export function evaluateCompliance({ rule, recipe, label, at }) {
  const failures = [];
  if (!rule) {
    failures.push("no_effective_rule");
    return { ok: false, failures };
  }
  if (Date.parse(label.effective_from) > Date.parse(at)) {
    failures.push("label_not_effective");
  }
  if (label.recipe_version_id !== recipe.id) {
    failures.push("label_recipe_mismatch");
  }
  if (!rule.required_languages.includes(label.language)) {
    failures.push("language_not_accepted");
  }
  for (const ingredient of recipe.ingredients) {
    if (rule.banned_ingredients.includes(ingredient)) {
      failures.push(`banned_ingredient:${ingredient}`);
    }
  }
  for (const allergen of recipe.allergens) {
    if (rule.required_allergens.includes(allergen) && !label.allergens_declared.includes(allergen)) {
      failures.push(`missing_allergen_declaration:${allergen}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function recordCheck(database, check) {
  database
    .prepare(
      `INSERT INTO compliance_checks
         (case_ref, lot_id, market, rule_id, label_layout_id, result, failures, trigger, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      check.case_ref ?? null,
      check.lot_id ?? null,
      check.market,
      check.rule_id ?? null,
      check.label_layout_id ?? null,
      check.result,
      JSON.stringify(check.failures),
      check.trigger,
      check.checked_at,
    );
}

function ensureDestinationBlock(database, { market, recipe_version_id, batch_id, reason, at }) {
  const existing = getRow(
    database,
    `SELECT id FROM destination_blocks
     WHERE market = ? AND recipe_version_id = ? AND active = 1
       AND (batch_id IS NULL OR batch_id = ?)`,
    market,
    recipe_version_id,
    batch_id ?? null,
  );
  if (existing) return existing.id;
  const result = database
    .prepare(
      `INSERT INTO destination_blocks(market, recipe_version_id, batch_id, reason, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(market, recipe_version_id, batch_id ?? null, reason, at);
  return Number(result.lastInsertRowid);
}

function activeBlockFor(database, { market, recipe_version_id, batch_id }) {
  return getRow(
    database,
    `SELECT * FROM destination_blocks
     WHERE market = ? AND recipe_version_id = ? AND active = 1
       AND (batch_id IS NULL OR batch_id = ?)
     ORDER BY id`,
    market,
    recipe_version_id,
    batch_id ?? null,
  );
}

export function liftDestinationBlock(database, blockId, body) {
  const block = mustGet(
    database,
    "SELECT * FROM destination_blocks WHERE id = ?",
    [blockId],
    "block_not_found",
    `阻断记录不存在：${blockId}`,
  );
  if (!block.active) {
    fail(409, "block_already_lifted", "该阻断已解除");
  }
  const at = optionalIso(body.lifted_at, "lifted_at", nowIso());
  const reason = reqString(body.reason, "reason");
  database
    .prepare("UPDATE destination_blocks SET active = 0, lifted_at = ?, lift_reason = ? WHERE id = ?")
    .run(at, reason, blockId);
  return { ...block, active: 0, lifted_at: at, lift_reason: reason };
}

export function listDestinationBlocks(database, { market, active } = {}) {
  let sql = "SELECT * FROM destination_blocks WHERE 1 = 1";
  const params = [];
  if (market) {
    sql += " AND market = ?";
    params.push(market);
  }
  if (active !== undefined) {
    sql += " AND active = ?";
    params.push(active ? 1 : 0);
  }
  sql += " ORDER BY id";
  return allRows(database, sql, ...params);
}

// ---------------------------------------------------------------------------
// 生产批次与货位
// ---------------------------------------------------------------------------

export function createBatch(database, body) {
  const input = {
    id: reqString(body.id, "id"),
    product_ref: reqString(body.product_ref, "product_ref"),
    recipe_version_id: reqString(body.recipe_version_id, "recipe_version_id"),
    planned_qty: reqPosInt(body.planned_qty, "planned_qty"),
    created_at: optionalIso(body.created_at, "created_at", nowIso()),
  };
  const recipe = getRecipeVersion(database, input.recipe_version_id);
  if (recipe.product_ref !== input.product_ref) {
    fail(400, "product_mismatch", "批次产品与配方版本所属产品不一致");
  }
  try {
    database
      .prepare(
        `INSERT INTO batches(id, product_ref, recipe_version_id, planned_qty, produced_qty, status, created_at)
         VALUES (?, ?, ?, ?, 0, 'planned', ?)`,
      )
      .run(input.id, input.product_ref, input.recipe_version_id, input.planned_qty, input.created_at);
  } catch (error) {
    if (String(error.message).includes("PRIMARY")) {
      fail(409, "duplicate_batch", `批次已存在：${input.id}`);
    }
    throw error;
  }
  return getBatch(database, input.id);
}

export function getBatch(database, id) {
  return mustGet(database, "SELECT * FROM batches WHERE id = ?", [id], "batch_not_found", `批次不存在：${id}`);
}

// 生产入库：生成一个 produced 阶段的货位，累计不得超过计划量。
export function produceBatch(database, batchId, body) {
  const lotId = reqString(body.lot_id, "lot_id");
  const qty = reqPosInt(body.qty, "qty");
  const at = optionalIso(body.at, "at", nowIso());
  return runInTransaction(database, () => {
    const batch = getBatch(database, batchId);
    if (batch.status === "review") {
      fail(409, "batch_in_review", "批次因规则更新处于待调整状态，不能继续生产");
    }
    if (batch.produced_qty + qty > batch.planned_qty) {
      fail(422, "overproduction", "累计生产量超过计划量", {
        planned_qty: batch.planned_qty,
        produced_qty: batch.produced_qty,
      });
    }
    if (getRow(database, "SELECT id FROM lots WHERE id = ?", lotId)) {
      fail(409, "duplicate_lot", `货位已存在：${lotId}`);
    }
    database
      .prepare(
        `INSERT INTO lots(id, batch_id, recipe_version_id, qty, remaining_qty, stage, created_at)
         VALUES (?, ?, ?, ?, ?, 'produced', ?)`,
      )
      .run(lotId, batchId, batch.recipe_version_id, qty, qty, at);
    const produced = batch.produced_qty + qty;
    database
      .prepare("UPDATE batches SET produced_qty = ?, status = ? WHERE id = ?")
      .run(produced, produced === batch.planned_qty ? "completed" : "in_production", batchId);
    return { batch: getBatch(database, batchId), lot: getLot(database, lotId) };
  });
}

export function getLot(database, id) {
  return mustGet(database, "SELECT * FROM lots WHERE id = ?", [id], "lot_not_found", `货位不存在：${id}`);
}

function lotPackedQty(database, lotId) {
  const row = getRow(database, "SELECT COALESCE(SUM(qty), 0) AS packed FROM cases WHERE lot_id = ?", lotId);
  return Number(row.packed);
}

// 拆分：子货位数量之和必须等于父货位剩余可拆量；父货位被消耗。
export function splitLot(database, lotId, body) {
  const parts = body.parts;
  if (!Array.isArray(parts) || parts.length < 2) {
    fail(400, "invalid_field", "字段 parts 必须包含至少两个子货位");
  }
  const at = optionalIso(body.at, "at", nowIso());
  return runInTransaction(database, () => {
    const parent = getLot(database, lotId);
    if (parent.consumed_by) fail(409, "lot_consumed", "货位已被拆分或合并消耗");
    if (parent.remaining_qty !== parent.qty) {
      fail(409, "lot_partially_packed", "货位已有装箱记录，不能拆分");
    }
    const total = parts.reduce((sum, part) => sum + reqPosInt(part.qty, "parts[].qty"), 0);
    if (total !== parent.qty) {
      fail(422, "split_not_conserved", "拆分数量不守恒", { parent_qty: parent.qty, parts_total: total });
    }
    const children = [];
    for (const part of parts) {
      const childId = reqString(part.id, "parts[].id");
      if (getRow(database, "SELECT id FROM lots WHERE id = ?", childId)) {
        fail(409, "duplicate_lot", `货位已存在：${childId}`);
      }
      database
        .prepare(
          `INSERT INTO lots(id, batch_id, recipe_version_id, qty, remaining_qty, stage, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(childId, parent.batch_id, parent.recipe_version_id, part.qty, part.qty, parent.stage, at);
      database
        .prepare("INSERT INTO lot_links(parent_lot_id, child_lot_id, qty, kind) VALUES(?, ?, ?, 'split')")
        .run(lotId, childId, part.qty);
      children.push(getLot(database, childId));
    }
    database
      .prepare("UPDATE lots SET remaining_qty = 0, consumed_by = ? WHERE id = ?")
      .run(`split:${children[0].id}`, lotId);
    return { parent: getLot(database, lotId), children };
  });
}

// 合并：仅允许同一配方版本、未装箱、未消耗的货位合并；血缘保留全部来源批次。
export function mergeLots(database, body) {
  const lotIds = body.lot_ids;
  if (!Array.isArray(lotIds) || lotIds.length < 2) {
    fail(400, "invalid_field", "字段 lot_ids 必须包含至少两个货位");
  }
  const newId = reqString(body.new_lot_id, "new_lot_id");
  const at = optionalIso(body.at, "at", nowIso());
  return runInTransaction(database, () => {
    const sources = lotIds.map((id) => getLot(database, reqString(id, "lot_ids[]")));
    for (const source of sources) {
      if (source.consumed_by) fail(409, "lot_consumed", `货位已被消耗：${source.id}`);
      if (source.remaining_qty !== source.qty) {
        fail(409, "lot_partially_packed", `货位已有装箱记录，不能合并：${source.id}`);
      }
    }
    const recipeIds = new Set(sources.map((source) => source.recipe_version_id));
    if (recipeIds.size !== 1) {
      fail(422, "recipe_mismatch", "只能合并同一配方版本的货位");
    }
    const total = sources.reduce((sum, source) => sum + source.qty, 0);
    if (getRow(database, "SELECT id FROM lots WHERE id = ?", newId)) {
      fail(409, "duplicate_lot", `货位已存在：${newId}`);
    }
    const stage = sources.every((source) => source.stage === sources[0].stage)
      ? sources[0].stage
      : "produced";
    database
      .prepare(
        `INSERT INTO lots(id, batch_id, recipe_version_id, qty, remaining_qty, stage, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(newId, sources[0].recipe_version_id, total, total, stage, at);
    for (const source of sources) {
      database
        .prepare("INSERT INTO lot_links(parent_lot_id, child_lot_id, qty, kind) VALUES(?, ?, ?, 'merge')")
        .run(source.id, newId, source.qty);
      database
        .prepare("UPDATE lots SET remaining_qty = 0, consumed_by = ? WHERE id = ?")
        .run(`merge:${newId}`, source.id);
    }
    return { lot: getLot(database, newId), sources: sources.map((source) => source.id) };
  });
}

export function inspectLot(database, lotId, body) {
  const result = reqString(body.result, "result");
  if (!["pass", "fail"].includes(result)) {
    fail(400, "invalid_field", "字段 result 只能是 pass 或 fail");
  }
  const at = optionalIso(body.at, "at", nowIso());
  return runInTransaction(database, () => {
    const lot = getLot(database, lotId);
    if (lot.consumed_by) fail(409, "lot_consumed", "货位已被消耗，不能检验");
    if (lot.stage !== "produced") fail(409, "invalid_stage", "只有 produced 阶段的货位可以检验");
    database
      .prepare("UPDATE lots SET stage = ? WHERE id = ?")
      .run(result === "pass" ? "inspected" : "failed", lotId);
    recordCheck(database, {
      lot_id: lotId,
      market: "-",
      result: result,
      failures: [],
      trigger: "inspection",
      checked_at: at,
    });
    return getLot(database, lotId);
  });
}

// ---------------------------------------------------------------------------
// 装箱扫描（逐件确认标签与批次配方一致）
// ---------------------------------------------------------------------------

export function scanCase(database, body) {
  const input = {
    case_ref: reqString(body.case_ref, "case_ref"),
    lot_id: reqString(body.lot_id, "lot_id"),
    qty: reqPosInt(body.qty, "qty"),
    market: reqString(body.market, "market"),
    dealer_ref: reqString(body.dealer_ref, "dealer_ref"),
    label_layout_id: reqString(body.label_layout_id, "label_layout_id"),
    packed_at: optionalIso(body.packed_at, "packed_at", nowIso()),
  };
  return withEvent(database, body.event_id, "scan_case", () => {
    // 自然幂等：同一箱号重复扫描返回首次结果，不重复扣减货位。
    const existing = getRow(database, "SELECT * FROM cases WHERE ref = ?", input.case_ref);
    if (existing) {
      return { ok: true, case: existing, check: latestCheckForCase(database, existing.ref), duplicated: true };
    }
    return runInTransaction(database, () => {
      const lot = getLot(database, input.lot_id);
      if (lot.consumed_by) fail(409, "lot_consumed", "货位已被消耗，不能装箱");
      if (lot.stage !== "inspected") {
        fail(409, "lot_not_inspected", "货位未通过检验，不能装箱");
      }
      if (lot.remaining_qty < input.qty) {
        fail(422, "insufficient_quantity", "货位剩余数量不足", {
          remaining_qty: lot.remaining_qty,
        });
      }
      const recipe = getRecipeVersion(database, lot.recipe_version_id);
      const label = getLabelLayout(database, input.label_layout_id);
      const rule = effectiveRule(database, input.market, input.packed_at);
      const outcome = evaluateCompliance({ rule, recipe, label, at: input.packed_at });
      recordCheck(database, {
        case_ref: input.case_ref,
        lot_id: lot.id,
        market: input.market,
        rule_id: rule ? rule.id : null,
        label_layout_id: label.id,
        result: outcome.ok ? "pass" : "fail",
        failures: outcome.failures,
        trigger: "pack_scan",
        checked_at: input.packed_at,
      });
      if (!outcome.ok) {
        // 不合格是业务结论而非系统错误：检查留痕与目的地阻断要落库，
        // 只阻断对应 (市场, 配方, 批次) 的货物，箱本身不建立。
        ensureDestinationBlock(database, {
          market: input.market,
          recipe_version_id: recipe.id,
          batch_id: lot.batch_id,
          reason: `装箱扫描不合格：${outcome.failures.join(", ")}`,
          at: input.packed_at,
        });
        return {
          ok: false,
          failures: outcome.failures,
          market: input.market,
          rule_id: rule ? rule.id : null,
          check: latestCheckForCase(database, input.case_ref),
          duplicated: false,
        };
      }
      database
        .prepare(
          `INSERT INTO cases
             (ref, lot_id, product_ref, recipe_version_id, qty, market, dealer_ref,
              label_layout_id, cleared_rule_id, status, packed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'packed', ?)`,
        )
        .run(
          input.case_ref,
          lot.id,
          recipe.product_ref,
          recipe.id,
          input.qty,
          input.market,
          input.dealer_ref,
          label.id,
          rule.id,
          input.packed_at,
        );
      database
        .prepare("UPDATE lots SET remaining_qty = remaining_qty - ? WHERE id = ?")
        .run(input.qty, lot.id);
      const created = getRow(database, "SELECT * FROM cases WHERE ref = ?", input.case_ref);
      return { ok: true, case: created, check: latestCheckForCase(database, created.ref), duplicated: false };
    });
  });
}

function latestCheckForCase(database, caseRef) {
  return (
    getRow(
      database,
      "SELECT * FROM compliance_checks WHERE case_ref = ? ORDER BY id DESC LIMIT 1",
      caseRef,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// 装柜、离港、到港、售罄回执
// ---------------------------------------------------------------------------

export function createShipment(database, body) {
  const input = {
    id: reqString(body.id, "id"),
    market: reqString(body.market, "market"),
    created_at: optionalIso(body.created_at, "created_at", nowIso()),
  };
  try {
    database
      .prepare("INSERT INTO shipments(id, market, status, created_at) VALUES(?, ?, 'loading', ?)")
      .run(input.id, input.market, input.created_at);
  } catch (error) {
    if (String(error.message).includes("PRIMARY")) {
      fail(409, "duplicate_shipment", `柜次已存在：${input.id}`);
    }
    throw error;
  }
  return getShipment(database, input.id);
}

export function getShipment(database, id) {
  const shipment = mustGet(
    database,
    "SELECT * FROM shipments WHERE id = ?",
    [id],
    "shipment_not_found",
    `柜次不存在：${id}`,
  );
  const cases = allRows(
    database,
    "SELECT ref, qty, dealer_ref, status FROM cases WHERE shipment_id = ? ORDER BY ref",
    id,
  );
  return { ...shipment, cases };
}

export function loadCase(database, shipmentId, body) {
  const caseRef = reqString(body.case_ref, "case_ref");
  return withEvent(database, body.event_id, "load_case", () =>
    runInTransaction(database, () => {
      const shipment = mustGet(
        database,
        "SELECT * FROM shipments WHERE id = ?",
        [shipmentId],
        "shipment_not_found",
        `柜次不存在：${shipmentId}`,
      );
      if (shipment.status !== "loading") {
        fail(409, "shipment_not_loading", "柜次不在装柜阶段，不能再装箱");
      }
      const unit = mustGet(
        database,
        "SELECT * FROM cases WHERE ref = ?",
        [caseRef],
        "case_not_found",
        `箱不存在：${caseRef}`,
      );
      // 重复扫描同一箱到同一柜：直接返回，不增加货量。
      if (unit.shipment_id === shipmentId && unit.status === "loaded") {
        return { case: unit, duplicated: true };
      }
      if (unit.shipment_id) {
        fail(409, "case_already_loaded", `箱已装入其他柜次：${unit.shipment_id}`);
      }
      if (unit.status !== "packed") {
        fail(409, "case_not_loadable", `箱当前状态为 ${unit.status}，不能装柜`);
      }
      if (unit.market !== shipment.market) {
        fail(422, "market_mismatch", "箱的目的地与柜次目的地不一致");
      }
      const lot = getLot(database, unit.lot_id);
      const block = activeBlockFor(database, {
        market: unit.market,
        recipe_version_id: unit.recipe_version_id,
        batch_id: lot.batch_id,
      });
      if (block) {
        fail(409, "destination_blocked", "该目的地存在有效阻断，禁止装柜", { block_id: block.id });
      }
      database
        .prepare("UPDATE cases SET status = 'loaded', shipment_id = ? WHERE ref = ?")
        .run(shipmentId, caseRef);
      return { case: getRow(database, "SELECT * FROM cases WHERE ref = ?", caseRef), duplicated: false };
    }),
  );
}

export function unloadCase(database, shipmentId, body) {
  const caseRef = reqString(body.case_ref, "case_ref");
  return runInTransaction(database, () => {
    const shipment = mustGet(
      database,
      "SELECT * FROM shipments WHERE id = ?",
      [shipmentId],
      "shipment_not_found",
      `柜次不存在：${shipmentId}`,
    );
    if (!["loading", "pending_customs"].includes(shipment.status)) {
      fail(409, "shipment_sealed", "柜次已离港，不能卸箱");
    }
    const unit = mustGet(
      database,
      "SELECT * FROM cases WHERE ref = ?",
      [caseRef],
      "case_not_found",
      `箱不存在：${caseRef}`,
    );
    if (unit.shipment_id !== shipmentId) {
      fail(409, "case_not_in_shipment", "箱不在该柜次中");
    }
    const lot = getLot(database, unit.lot_id);
    const block = activeBlockFor(database, {
      market: unit.market,
      recipe_version_id: unit.recipe_version_id,
      batch_id: lot.batch_id,
    });
    const status = block ? "held" : "packed";
    database
      .prepare("UPDATE cases SET status = ?, shipment_id = NULL WHERE ref = ?")
      .run(status, caseRef);
    return getRow(database, "SELECT * FROM cases WHERE ref = ?", caseRef);
  });
}

export function submitShipmentForCustoms(database, shipmentId, body) {
  const at = optionalIso(body.at, "at", nowIso());
  return runInTransaction(database, () => {
    const shipment = mustGet(
      database,
      "SELECT * FROM shipments WHERE id = ?",
      [shipmentId],
      "shipment_not_found",
      `柜次不存在：${shipmentId}`,
    );
    if (shipment.status !== "loading") {
      fail(409, "invalid_status", "只有装柜中的柜次可以转入待报关");
    }
    const count = getRow(
      database,
      "SELECT COUNT(*) AS n FROM cases WHERE shipment_id = ?",
      shipmentId,
    );
    if (Number(count.n) === 0) {
      fail(422, "empty_shipment", "空柜不能转入待报关");
    }
    database.prepare("UPDATE shipments SET status = 'pending_customs' WHERE id = ?").run(shipmentId);
    return { ...getShipment(database, shipmentId), transitioned_at: at };
  });
}

// 离港：记录核准所用的规则版本；柜内不得有被规则更新暂扣的箱。
export function departShipment(database, shipmentId, body) {
  const at = optionalIso(body.departed_at, "departed_at", nowIso());
  return withEvent(database, body.event_id, "depart_shipment", () =>
    runInTransaction(database, () => {
      const shipment = mustGet(
        database,
        "SELECT * FROM shipments WHERE id = ?",
        [shipmentId],
        "shipment_not_found",
        `柜次不存在：${shipmentId}`,
      );
      if (!["loading", "pending_customs"].includes(shipment.status)) {
        fail(409, "invalid_status", `柜次当前状态为 ${shipment.status}，不能离港`);
      }
      const held = allRows(
        database,
        "SELECT ref FROM cases WHERE shipment_id = ? AND status = 'held'",
        shipmentId,
      );
      if (held.length > 0) {
        fail(409, "held_cases_aboard", "柜内存在被暂扣的箱，须先卸箱", {
          case_refs: held.map((row) => row.ref),
        });
      }
      const aboard = getRow(
        database,
        "SELECT COUNT(*) AS n FROM cases WHERE shipment_id = ?",
        shipmentId,
      );
      if (Number(aboard.n) === 0) {
        fail(422, "empty_shipment", "空柜不能离港");
      }
      const rule = effectiveRule(database, shipment.market, at);
      if (!rule) {
        fail(422, "no_effective_rule", "离港时刻市场无生效规则，不能核准");
      }
      database
        .prepare("UPDATE shipments SET status = 'departed', departed_at = ?, cleared_rule_id = ? WHERE id = ?")
        .run(at, rule.id, shipmentId);
      database
        .prepare("UPDATE cases SET status = 'departed' WHERE shipment_id = ?")
        .run(shipmentId);
      return getShipment(database, shipmentId);
    }),
  );
}

export function arriveShipment(database, shipmentId, body) {
  const at = optionalIso(body.arrived_at, "arrived_at", nowIso());
  return withEvent(database, body.event_id, "arrive_shipment", () =>
    runInTransaction(database, () => {
      const shipment = mustGet(
        database,
        "SELECT * FROM shipments WHERE id = ?",
        [shipmentId],
        "shipment_not_found",
        `柜次不存在：${shipmentId}`,
      );
      if (shipment.status !== "departed") {
        fail(409, "invalid_status", "只有已离港的柜次可以确认到港");
      }
      database
        .prepare("UPDATE shipments SET status = 'arrived', arrived_at = ? WHERE id = ?")
        .run(at, shipmentId);
      database.prepare("UPDATE cases SET status = 'arrived' WHERE shipment_id = ?").run(shipmentId);
      return getShipment(database, shipmentId);
    }),
  );
}

// 售罄/销售回执：回执号唯一，经销商重传不增加货量；
// 回执经销商必须与装箱时登记的经销商一致。
export function recordReceipt(database, body) {
  const input = {
    ref: reqString(body.ref, "ref"),
    case_ref: reqString(body.case_ref, "case_ref"),
    dealer_ref: reqString(body.dealer_ref, "dealer_ref"),
    qty: reqPosInt(body.qty, "qty"),
    received_at: optionalIso(body.received_at, "received_at", nowIso()),
  };
  return withEvent(database, body.event_id, "record_receipt", () => {
    const existing = getRow(database, "SELECT * FROM receipts WHERE ref = ?", input.ref);
    if (existing) {
      return { receipt: existing, duplicated: true };
    }
    return runInTransaction(database, () => {
      const unit = mustGet(
        database,
        "SELECT * FROM cases WHERE ref = ?",
        [input.case_ref],
        "case_not_found",
        `箱不存在：${input.case_ref}`,
      );
      if (unit.dealer_ref !== input.dealer_ref) {
        fail(409, "dealer_mismatch", "回执经销商与装箱登记经销商不一致");
      }
      if (!["arrived", "sold"].includes(unit.status)) {
        fail(409, "case_not_arrived", `箱当前状态为 ${unit.status}，不能登记回执`);
      }
      const soldRow = getRow(
        database,
        "SELECT COALESCE(SUM(qty), 0) AS sold FROM receipts WHERE case_ref = ?",
        input.case_ref,
      );
      const sold = Number(soldRow.sold);
      if (sold + input.qty > unit.qty) {
        fail(422, "receipt_overflow", "回执累计数量超过箱内数量", {
          case_qty: unit.qty,
          already_sold: sold,
        });
      }
      database
        .prepare("INSERT INTO receipts(ref, case_ref, dealer_ref, qty, received_at) VALUES(?, ?, ?, ?, ?)")
        .run(input.ref, input.case_ref, input.dealer_ref, input.qty, input.received_at);
      if (sold + input.qty === unit.qty) {
        database.prepare("UPDATE cases SET status = 'sold' WHERE ref = ?").run(input.case_ref);
      }
      return {
        receipt: getRow(database, "SELECT * FROM receipts WHERE ref = ?", input.ref),
        duplicated: false,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// 召回
// ---------------------------------------------------------------------------

function descendantLotIds(database, rootLotIds) {
  const seen = new Set(rootLotIds);
  const queue = [...rootLotIds];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = allRows(
      database,
      "SELECT child_lot_id FROM lot_links WHERE parent_lot_id = ?",
      current,
    );
    for (const child of children) {
      if (!seen.has(child.child_lot_id)) {
        seen.add(child.child_lot_id);
        queue.push(child.child_lot_id);
      }
    }
  }
  return [...seen];
}

function affectedCases(database, scopeType, scopeId) {
  if (scopeType === "recipe_version") {
    return allRows(database, "SELECT * FROM cases WHERE recipe_version_id = ?", scopeId);
  }
  if (scopeType === "batch") {
    const roots = allRows(database, "SELECT id FROM lots WHERE batch_id = ?", scopeId).map(
      (row) => row.id,
    );
    const lotIds = descendantLotIds(database, roots);
    if (lotIds.length === 0) return [];
    const placeholders = lotIds.map(() => "?").join(", ");
    return allRows(database, `SELECT * FROM cases WHERE lot_id IN (${placeholders})`, ...lotIds);
  }
  fail(400, "invalid_scope", "scope_type 只能是 batch 或 recipe_version");
}

export function issueRecall(database, body) {
  const input = {
    id: reqString(body.id, "id"),
    scope_type: reqString(body.scope_type, "scope_type"),
    scope_id: reqString(body.scope_id, "scope_id"),
    reason: reqString(body.reason, "reason"),
    created_at: optionalIso(body.created_at, "created_at", nowIso()),
  };
  return runInTransaction(database, () => {
    if (getRow(database, "SELECT id FROM recalls WHERE id = ?", input.id)) {
      fail(409, "duplicate_recall", `召回已存在：${input.id}`);
    }
    const cases = affectedCases(database, input.scope_type, input.scope_id);
    database
      .prepare("INSERT INTO recalls(id, scope_type, scope_id, reason, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(input.id, input.scope_type, input.scope_id, input.reason, input.created_at);
    for (const unit of cases) {
      database
        .prepare(
          "INSERT INTO recall_items(recall_id, case_ref, market, status_at_recall, qty) VALUES(?, ?, ?, ?, ?)",
        )
        .run(input.id, unit.ref, unit.market, unit.status, unit.qty);
      if (unit.status !== "sold") {
        database.prepare("UPDATE cases SET status = 'recalled' WHERE ref = ?").run(unit.ref);
      }
    }
    return getRecall(database, input.id);
  });
}

export function getRecall(database, id) {
  const recall = mustGet(
    database,
    "SELECT * FROM recalls WHERE id = ?",
    [id],
    "recall_not_found",
    `召回不存在：${id}`,
  );
  const items = allRows(
    database,
    "SELECT * FROM recall_items WHERE recall_id = ? ORDER BY case_ref",
    id,
  );
  const markets = {};
  for (const item of items) {
    const bucket = (markets[item.market] ??= {
      market: item.market,
      affected_cases: 0,
      affected_qty: 0,
      remaining_packages: 0, // 未售罄、需要追回的包装
      remaining_qty: 0,
      sold_cases: 0,
      dealer_refs: new Set(),
    });
    bucket.affected_cases += 1;
    bucket.affected_qty += item.qty;
    if (item.status_at_recall === "sold") {
      bucket.sold_cases += 1;
    } else {
      bucket.remaining_packages += 1;
      bucket.remaining_qty += item.qty;
    }
    const unit = getRow(database, "SELECT dealer_ref FROM cases WHERE ref = ?", item.case_ref);
    if (unit) bucket.dealer_refs.add(unit.dealer_ref);
  }
  return {
    ...recall,
    markets: Object.values(markets).map((bucket) => ({
      ...bucket,
      dealer_refs: [...bucket.dealer_refs].sort(),
    })),
    items,
  };
}

// ---------------------------------------------------------------------------
// 解释与汇总
// ---------------------------------------------------------------------------

// 解释一箱产品为何获准出口：标签语言、配方版本、规则版本、检查留痕、
// 柜次核准版本与数量流转，一次取齐。
export function explainCase(database, caseRef) {
  const unit = mustGet(
    database,
    "SELECT * FROM cases WHERE ref = ?",
    [caseRef],
    "case_not_found",
    `箱不存在：${caseRef}`,
  );
  const lot = getLot(database, unit.lot_id);
  const recipe = getRecipeVersion(database, unit.recipe_version_id);
  const label = getLabelLayout(database, unit.label_layout_id);
  const clearedRule = unit.cleared_rule_id ? getMarketRule(database, unit.cleared_rule_id) : null;
  const checks = allRows(
    database,
    "SELECT * FROM compliance_checks WHERE case_ref = ? ORDER BY id",
    caseRef,
  ).map((row) => ({ ...row, failures: asJson(row.failures) }));
  const blocks = allRows(
    database,
    "SELECT * FROM destination_blocks WHERE market = ? AND recipe_version_id = ? ORDER BY id",
    unit.market,
    unit.recipe_version_id,
  );
  const shipment = unit.shipment_id ? getShipment(database, unit.shipment_id) : null;
  const receipts = allRows(
    database,
    "SELECT ref, qty, received_at FROM receipts WHERE case_ref = ? ORDER BY received_at",
    caseRef,
  );
  // 血缘：合并货位的来源批次。
  const ancestors = [];
  const queue = [lot.id];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    const parents = allRows(
      database,
      "SELECT parent_lot_id FROM lot_links WHERE child_lot_id = ?",
      current,
    );
    for (const parent of parents) {
      if (!seen.has(parent.parent_lot_id)) {
        seen.add(parent.parent_lot_id);
        queue.push(parent.parent_lot_id);
        const parentLot = getLot(database, parent.parent_lot_id);
        if (parentLot.batch_id) ancestors.push(parentLot.batch_id);
      }
    }
  }
  const batchIds = [...new Set([...(lot.batch_id ? [lot.batch_id] : []), ...ancestors])];
  const lastCheck = checks.at(-1) ?? null;
  const activeBlock = blocks.find((block) => block.active === 1) ?? null;
  let decision;
  if (unit.status === "recalled") decision = "recalled";
  else if (unit.status === "held") decision = "held";
  else if (activeBlock) decision = "blocked";
  else if (clearedRule && lastCheck && lastCheck.result === "pass") decision = "allowed";
  else decision = "pending";
  return {
    case_ref: unit.ref,
    product_ref: unit.product_ref,
    market: unit.market,
    dealer_ref: unit.dealer_ref,
    qty: unit.qty,
    status: unit.status,
    decision,
    recipe_version: { id: recipe.id, version: recipe.version },
    label: {
      id: label.id,
      language: label.language,
      layout_version: label.layout_version,
      artwork_digest: label.artwork_digest,
    },
    cleared_rule: clearedRule
      ? { id: clearedRule.id, rule_version: clearedRule.rule_version, effective_from: clearedRule.effective_from }
      : null,
    batch_ids: batchIds,
    lot_id: lot.id,
    checks,
    blocks,
    shipment: shipment
      ? {
          id: shipment.id,
          status: shipment.status,
          departed_at: shipment.departed_at,
          arrived_at: shipment.arrived_at,
          cleared_rule_id: shipment.cleared_rule_id,
        }
      : null,
    receipts,
  };
}

// 复购汇总：只按产品/市场聚合，不输出任何经销商合同价格
// （系统根本不存储价格字段），经销商仅以匿名引用计数形式出现。
export function repurchaseReport(database, { product_ref, market } = {}) {
  let sql = `
    SELECT c.product_ref, c.market, r.dealer_ref, r.qty, r.ref
    FROM receipts r JOIN cases c ON c.ref = r.case_ref
    WHERE 1 = 1`;
  const params = [];
  if (product_ref) {
    sql += " AND c.product_ref = ?";
    params.push(product_ref);
  }
  if (market) {
    sql += " AND c.market = ?";
    params.push(market);
  }
  const rows = allRows(database, sql, ...params);
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.product_ref}::${row.market}`;
    const group =
      groups.get(key) ??
      (() => {
        const created = {
          product_ref: row.product_ref,
          market: row.market,
          sold_qty: 0,
          receipt_count: 0,
          dealer_count: 0,
          repeat_dealer_count: 0,
          _dealers: new Map(),
        };
        groups.set(key, created);
        return created;
      })();
    group.sold_qty += row.qty;
    group.receipt_count += 1;
    group._dealers.set(row.dealer_ref, (group._dealers.get(row.dealer_ref) ?? 0) + 1);
  }
  return [...groups.values()].map((group) => {
    group.dealer_count = group._dealers.size;
    group.repeat_dealer_count = [...group._dealers.values()].filter((n) => n >= 2).length;
    delete group._dealers;
    return group;
  });
}

// 批次总览：含数量守恒核对数。
export function batchOverview(database, batchId) {
  const batch = getBatch(database, batchId);
  const lots = allRows(database, "SELECT * FROM lots WHERE batch_id = ? ORDER BY created_at", batchId);
  const lotIds = descendantLotIds(database, lots.map((lot) => lot.id));
  let cases = [];
  if (lotIds.length > 0) {
    const placeholders = lotIds.map(() => "?").join(", ");
    cases = allRows(database, `SELECT * FROM cases WHERE lot_id IN (${placeholders})`, ...lotIds);
  }
  const activeLots = lots.filter((lot) => !lot.consumed_by);
  // 合并可能把数量带离本批次，守恒核对以血缘后代为准：
  // 未消耗后代货位的剩余 + 已装箱数量 == 未消耗后代货位的原始数量。
  const descendants = lotIds
    .map((id) => getLot(database, id))
    .filter((lot) => !lot.consumed_by);
  const conservation = {
    produced_qty: batch.produced_qty,
    active_lot_qty: descendants.reduce((sum, lot) => sum + lot.qty, 0),
    active_lot_remaining: descendants.reduce((sum, lot) => sum + lot.remaining_qty, 0),
    packed_qty: cases.reduce((sum, unit) => sum + unit.qty, 0),
  };
  conservation.conserved =
    conservation.active_lot_remaining + conservation.packed_qty === conservation.active_lot_qty;
  const blocks = allRows(
    database,
    "SELECT * FROM destination_blocks WHERE batch_id = ? OR batch_id IS NULL AND recipe_version_id = ?",
    batchId,
    batch.recipe_version_id,
  );
  return { batch, lots: activeLots, cases, blocks, conservation };
}
