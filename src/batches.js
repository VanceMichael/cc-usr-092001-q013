import { DomainError, ErrorCode } from "./errors.js";
import { nowIso, parseInstant } from "./time.js";
import { getLabel, getRecipe } from "./masterdata.js";

export const BatchStatus = {
  PRODUCED: "PRODUCED",
  MERGED: "MERGED",
};

export const OrderStatus = {
  PLANNED: "PLANNED", // 未生产
  PARTIAL: "PARTIAL",
  FULFILLED: "FULFILLED",
};

/* ---------------- 经销商订单（合同价单独存放，读取路径永不输出） ---------------- */

export function createOrder(database, input) {
  const orderId = requireRef(input.order_id, "order_id");
  const clientRef = requireRef(input.client_ref, "client_ref");
  const distributorRef = requireRef(input.distributor_ref, "distributor_ref");
  const sku = requireRef(input.sku, "sku");
  const countryCode = requireRef(input.country_code, "country_code").toUpperCase();
  const quantity = requirePositiveInt(input.quantity, "quantity");
  const price = input.contract_price;

  const existing = database
    .prepare("SELECT * FROM orders WHERE distributor_ref = ? AND client_ref = ?")
    .get(distributorRef, clientRef);
  // 经销商重传：返回既有订单，不新增货量
  if (existing) {
    return { order_id: existing.order_id, duplicated: true };
  }
  database
    .prepare(
      `INSERT INTO orders(order_id, client_ref, distributor_ref, sku, country_code,
                          quantity, fulfilled_qty, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, 0, 'PLANNED', ?)`,
    )
    .run(orderId, clientRef, distributorRef, sku, countryCode, quantity, nowIso());
  if (price) {
    if (!Number.isInteger(price.amount_minor) || price.amount_minor < 0 || !price.currency) {
      throw new DomainError(ErrorCode.VALIDATION, "contract_price 需要 amount_minor（非负整数）与 currency");
    }
    database
      .prepare("INSERT INTO order_contract_prices(order_id, amount_minor, currency) VALUES(?, ?, ?)")
      .run(orderId, price.amount_minor, price.currency);
  }
  return { order_id: orderId, duplicated: false };
}

export function publicOrder(order) {
  const { fulfilled_qty: fulfilledQty, ...rest } = order;
  return { ...rest, fulfilled_qty: fulfilledQty };
}

/* ---------------- 生产批次 ---------------- */

export function produceBatch(database, input) {
  const batchId = requireRef(input.batch_id, "batch_id");
  const sku = requireRef(input.sku, "sku");
  const recipeId = requireRef(input.recipe_id, "recipe_id");
  const quantity = requirePositiveInt(input.quantity, "quantity");
  const producedAt = parseInstant(input.produced_at, "produced_at");
  const recipe = getRecipe(database, recipeId);
  if (recipe.sku !== sku) {
    throw new DomainError(ErrorCode.VALIDATION, `配方 ${recipeId} 不属于产品 ${sku}`);
  }
  if (database.prepare("SELECT 1 FROM production_batches WHERE batch_id = ?").get(batchId)) {
    throw new DomainError(ErrorCode.CONFLICT, `生产批次 ${batchId} 已存在`);
  }
  database
    .prepare(
      `INSERT INTO production_batches(batch_id, sku, recipe_id, initial_qty, current_qty,
                                      status, produced_at)
       VALUES(?, ?, ?, ?, ?, 'PRODUCED', ?)`,
    )
    .run(batchId, sku, recipeId, quantity, quantity, producedAt);
  return { batch_id: batchId, current_qty: quantity };
}

export function getBatch(database, batchId) {
  const row = database.prepare("SELECT * FROM production_batches WHERE batch_id = ?").get(batchId);
  if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `批次 ${batchId} 不存在`);
  return withAvailability(database, row);
}

function withAvailability(database, batch) {
  const reserved =
    database
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM allocations WHERE batch_id = ?")
      .get(batch.batch_id).q ?? 0;
  return { ...batch, reserved_qty: reserved, available_qty: batch.current_qty - reserved };
}

/**
 * 数量守恒校验（可随时对任意批次运行）：
 * 初始量 − Σ拆出 + Σ并入 = 当前量；
 * 已预留量 ≤ 当前量；箱内实物合计 ≤ 预留量。
 */
export function verifyConservation(database, batchId) {
  const batch = database.prepare("SELECT * FROM production_batches WHERE batch_id = ?").get(batchId);
  if (!batch) throw new DomainError(ErrorCode.NOT_FOUND, `批次 ${batchId} 不存在`);
  const splitOut =
    database
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM batch_lineage WHERE parent_batch_id = ?")
      .get(batchId).q ?? 0;
  const splitIn =
    database
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM batch_lineage WHERE child_batch_id = ?")
      .get(batchId).q ?? 0;
  // 统一守恒式：初始量 − 流出血缘（拆出/合出）+ 流入血缘（拆入/并入）= 当前量
  const expected = batch.initial_qty - splitOut + splitIn;
  if (expected !== batch.current_qty) {
    throw new DomainError(
      ErrorCode.QUANTITY_CONSERVATION,
      `批次 ${batchId} 数量不守恒：账面 ${batch.current_qty}，推演应为 ${expected}`,
      { batch_id: batchId, current: batch.current_qty, expected },
    );
  }
  const reserved =
    database
      .prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM allocations WHERE batch_id = ?")
      .get(batchId).q ?? 0;
  if (reserved > batch.current_qty) {
    throw new DomainError(
      ErrorCode.QUANTITY_CONSERVATION,
      `批次 ${batchId} 预留 ${reserved} 超过当前量 ${batch.current_qty}`,
    );
  }
  const packed =
    database
      .prepare(
        `SELECT COALESCE(SUM(c.quantity), 0) AS q
         FROM cartons c JOIN allocations a ON c.allocation_id = a.allocation_id
         WHERE a.batch_id = ?`,
      )
      .get(batchId).q ?? 0;
  if (packed > batch.current_qty) {
    throw new DomainError(
      ErrorCode.QUANTITY_CONSERVATION,
      `批次 ${batchId} 已装箱 ${packed} 超过当前量 ${batch.current_qty}`,
    );
  }
  return { batch_id: batchId, initial: batch.initial_qty, flowed_out: splitOut, flowed_in: splitIn, current: batch.current_qty, reserved, packed };
}

/* ---------------- 拆批：同一批次按数量拆给不同经销商 ---------------- */

export function splitBatch(database, input) {
  const parentId = requireRef(input.parent_batch_id, "parent_batch_id");
  const childId = requireRef(input.child_batch_id, "child_batch_id");
  const quantity = requirePositiveInt(input.quantity, "quantity");
  const parent = getBatch(database, parentId);
  if (parent.status !== BatchStatus.PRODUCED) {
    throw new DomainError(ErrorCode.INVALID_TRANSITION, `批次 ${parentId} 状态为 ${parent.status}，不可再拆`);
  }
  if (quantity > parent.available_qty) {
    throw new DomainError(
      ErrorCode.QUANTITY_CONSERVATION,
      `拆出 ${quantity} 超过批次 ${parentId} 未预留量 ${parent.available_qty}`,
    );
  }
  if (database.prepare("SELECT 1 FROM production_batches WHERE batch_id = ?").get(childId)) {
    throw new DomainError(ErrorCode.CONFLICT, `子批次 ${childId} 已存在`);
  }
  database
    .prepare("UPDATE production_batches SET current_qty = current_qty - ? WHERE batch_id = ?")
    .run(quantity, parentId);
  database
    .prepare(
      `INSERT INTO production_batches(batch_id, sku, recipe_id, initial_qty, current_qty,
                                      status, produced_at)
       VALUES(?, ?, ?, 0, ?, 'PRODUCED', ?)`,
    )
    .run(childId, parent.sku, parent.recipe_id, quantity, nowIso());
  database
    .prepare(
      `INSERT INTO batch_lineage(lineage_id, kind, parent_batch_id, child_batch_id, quantity,
                                 event_id, created_at)
       VALUES(?, 'SPLIT', ?, ?, ?, ?, ?)`,
    )
    .run(`LG-${childId}`, parentId, childId, quantity, input.event_id ?? null, nowIso());
  return { parent_batch_id: parentId, child_batch_id: childId, quantity };
}

/* ---------------- 合批：仅允许同产品同配方版本合流 ---------------- */

export function mergeBatches(database, input) {
  const mergedId = requireRef(input.merged_batch_id, "merged_batch_id");
  const sourceIds = input.source_batch_ids;
  if (!Array.isArray(sourceIds) || sourceIds.length < 2) {
    throw new DomainError(ErrorCode.VALIDATION, "source_batch_ids 至少包含两个批次");
  }
  if (database.prepare("SELECT 1 FROM production_batches WHERE batch_id = ?").get(mergedId)) {
    throw new DomainError(ErrorCode.CONFLICT, `合并批次 ${mergedId} 已存在`);
  }
  const sources = sourceIds.map((id) => getBatch(database, id));
  const first = sources[0];
  for (const source of sources) {
    if (source.status !== BatchStatus.PRODUCED) {
      throw new DomainError(ErrorCode.INVALID_TRANSITION, `批次 ${source.batch_id} 已${source.status === "MERGED" ? "合出" : "终态"}，不可参与合并`);
    }
    if (source.reserved_qty > 0) {
      throw new DomainError(ErrorCode.QUANTITY_CONSERVATION, `批次 ${source.batch_id} 存在已预留货物，不可合并`);
    }
    if (source.sku !== first.sku || source.recipe_id !== first.recipe_id) {
      throw new DomainError(ErrorCode.VALIDATION, "只有同产品、同配方版本的批次才能合并；不同配方须先建立新配方再投产");
    }
  }
  const total = sources.reduce((sum, source) => sum + source.current_qty, 0);
  database
    .prepare(
      `INSERT INTO production_batches(batch_id, sku, recipe_id, initial_qty, current_qty,
                                      status, produced_at)
       VALUES(?, ?, ?, 0, ?, 'PRODUCED', ?)`,
    )
    .run(mergedId, first.sku, first.recipe_id, total, nowIso());
  for (const source of sources) {
    database
      .prepare("UPDATE production_batches SET current_qty = 0, status = 'MERGED' WHERE batch_id = ?")
      .run(source.batch_id);
    database
      .prepare(
        `INSERT INTO batch_lineage(lineage_id, kind, parent_batch_id, child_batch_id, quantity,
                                   event_id, created_at)
         VALUES(?, 'MERGE', ?, ?, ?, ?, ?)`,
      )
      .run(`LG-${source.batch_id}-${mergedId}`, source.batch_id, mergedId, source.current_qty, input.event_id ?? null, nowIso());
  }
  return { merged_batch_id: mergedId, quantity: total, source_batch_ids: sourceIds };
}

/** 批次沿拆分/合并血缘向下展开（召回定位用）。 */
export function descendantBatches(database, batchId) {
  const result = new Set();
  const walk = (id) => {
    const rows = database
      .prepare("SELECT child_batch_id FROM batch_lineage WHERE parent_batch_id = ?")
      .all(id);
    for (const row of rows) {
      if (!result.has(row.child_batch_id)) {
        result.add(row.child_batch_id);
        walk(row.child_batch_id);
      }
    }
  };
  walk(batchId);
  return [batchId, ...result];
}

/* ---------------- 分配：把某批次数量预留给某经销商订单 ---------------- */

export function allocateBatch(database, input) {
  const allocationId = requireRef(input.allocation_id, "allocation_id");
  const orderId = requireRef(input.order_id, "order_id");
  const batchId = requireRef(input.batch_id, "batch_id");
  const quantity = requirePositiveInt(input.quantity, "quantity");

  const order = database.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId);
  if (!order) throw new DomainError(ErrorCode.NOT_FOUND, `订单 ${orderId} 不存在`);
  const batch = getBatch(database, batchId);
  if (batch.sku !== order.sku) {
    throw new DomainError(ErrorCode.VALIDATION, `批次产品 ${batch.sku} 与订单产品 ${order.sku} 不一致`);
  }
  const remaining = order.quantity - order.fulfilled_qty;
  const already =
    database
      .prepare("SELECT COALESCE(SUM(quantity), 0) - COALESCE(SUM(packed_qty), 0) AS q FROM allocations WHERE order_id = ?")
      .get(orderId).q ?? 0;
  if (quantity > remaining - already) {
    throw new DomainError(
      ErrorCode.QUANTITY_CONSERVATION,
      `分配 ${quantity} 超出订单 ${orderId} 未满足量 ${Math.max(remaining - already, 0)}`,
    );
  }
  if (quantity > batch.available_qty) {
    throw new DomainError(
      ErrorCode.QUANTITY_CONSERVATION,
      `批次 ${batchId} 未预留量仅 ${batch.available_qty}，无法分配 ${quantity}`,
    );
  }
  database
    .prepare(
      `INSERT INTO allocations(allocation_id, order_id, batch_id, distributor_ref, sku,
                               country_code, quantity, packed_qty, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(allocationId, orderId, batchId, order.distributor_ref, order.sku, order.country_code, quantity, nowIso());
  return { allocation_id: allocationId, quantity };
}

/* ---------------- 装箱：逐件指定标签版式，数量只减不增 ---------------- */

export function packCartons(database, input) {
  const allocationId = requireRef(input.allocation_id, "allocation_id");
  const labelId = requireRef(input.label_id, "label_id");
  const allocation = database.prepare("SELECT * FROM allocations WHERE allocation_id = ?").get(allocationId);
  if (!allocation) throw new DomainError(ErrorCode.NOT_FOUND, `分配 ${allocationId} 不存在`);
  const label = getLabel(database, labelId);
  if (label.sku !== allocation.sku) {
    throw new DomainError(ErrorCode.VALIDATION, `标签 ${labelId} 不属于产品 ${allocation.sku}`);
  }
  const batch = getBatch(database, allocation.batch_id);
  if (label.recipe_id !== batch.recipe_id) {
    throw new DomainError(
      ErrorCode.VALIDATION,
      `装箱标签 ${labelId} 基于配方 ${label.recipe_id}，批次 ${batch.batch_id} 使用 ${batch.recipe_id}；标签必须与批次配方一致`,
    );
  }

  const specs = normalizeCartonSpecs(input.cartons);
  const total = specs.reduce((sum, spec) => sum + spec.quantity, 0);
  const room = allocation.quantity - allocation.packed_qty;
  // 重复扫描与超量都不允许：箱号冲突优先报出，保证重复扫描不会被当成超量
  for (const spec of specs) {
    if (database.prepare("SELECT 1 FROM cartons WHERE carton_ref = ?").get(spec.carton_ref)) {
      throw new DomainError(ErrorCode.CONFLICT, `箱号 ${spec.carton_ref} 已存在；重复扫描不增加货量`);
    }
  }
  if (total > room) {
    throw new DomainError(
      ErrorCode.QUANTITY_CONSERVATION,
      `本次装箱 ${total} 超过分配 ${allocationId} 未装箱量 ${room}；重复扫描与重传不会增加货量`,
    );
  }
  const packedAt = nowIso();
  const created = [];
  for (const spec of specs) {
    database
      .prepare(
        `INSERT INTO cartons(carton_ref, allocation_id, batch_id, sku, country_code, label_id,
                             quantity, status, held, packed_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'PACKED', 0, ?, ?)`,
      )
      .run(
        spec.carton_ref,
        allocationId,
        allocation.batch_id,
        allocation.sku,
        allocation.country_code,
        labelId,
        spec.quantity,
        packedAt,
        packedAt,
      );
    recordCartonEvent(database, {
      cartonRef: spec.carton_ref,
      action: "PACK",
      fromStatus: "-",
      toStatus: "PACKED",
      eventId: input.event_id ?? null,
      occurredAt: packedAt,
    });
    created.push({ carton_ref: spec.carton_ref, quantity: spec.quantity });
  }
  database.prepare("UPDATE allocations SET packed_qty = packed_qty + ? WHERE allocation_id = ?").run(total, allocationId);
  const orderId = allocation.order_id;
  database
    .prepare(
      `UPDATE orders SET fulfilled_qty = (
         SELECT COALESCE(SUM(packed_qty), 0) FROM allocations WHERE order_id = ?
       ),
       status = CASE
         WHEN (SELECT COALESCE(SUM(packed_qty), 0) FROM allocations WHERE order_id = ?) >= quantity
           THEN 'FULFILLED' ELSE 'PARTIAL' END
       WHERE order_id = ?`,
    )
    .run(orderId, orderId, orderId);
  return { allocation_id: allocationId, cartons: created, packed_total: total };
}

function normalizeCartonSpecs(inputSpecs) {
  if (!Array.isArray(inputSpecs) || inputSpecs.length === 0) {
    throw new DomainError(ErrorCode.VALIDATION, "cartons 至少包含一箱");
  }
  return inputSpecs.map((spec) => ({
    carton_ref: requireRef(spec.carton_ref, "carton_ref"),
    quantity: requirePositiveInt(spec.quantity, "quantity"),
  }));
}

export function getCarton(database, cartonRef) {
  const row = database.prepare("SELECT * FROM cartons WHERE carton_ref = ?").get(cartonRef);
  if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `箱 ${cartonRef} 不存在`);
  return hydrateCarton(row);
}

export function hydrateCarton(row) {
  return {
    ...row,
    held: row.held === 1,
    held_findings: row.held_findings ? JSON.parse(row.held_findings) : null,
  };
}

export function recordCartonEvent(database, { cartonRef, action, fromStatus, toStatus, eventId, occurredAt, note }) {
  const id = `CE-${cartonRef}-${action}-${Date.parse(occurredAt)}-${Math.random().toString(36).slice(2, 8)}`;
  database
    .prepare(
      `INSERT INTO carton_events(carton_event_id, carton_ref, action, from_status, to_status,
                                 event_id, occurred_at, note)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, cartonRef, action, fromStatus, toStatus, eventId ?? null, occurredAt, note ?? null);
  return id;
}

/* ---------------- 查询 ---------------- */

function requireRef(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 为必填字符串`);
  }
  return value;
}

function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DomainError(ErrorCode.VALIDATION, `${field} 必须是正整数`);
  }
  return value;
}

export function listCartonsByBatch(database, batchId) {
  return database
    .prepare("SELECT * FROM cartons WHERE batch_id = ? ORDER BY packed_at, carton_ref")
    .all(batchId)
    .map(hydrateCarton);
}

export function listCartonsByContainer(database, containerRef) {
  return database
    .prepare("SELECT * FROM cartons WHERE container_ref = ? ORDER BY carton_ref")
    .all(containerRef)
    .map(hydrateCarton);
}
