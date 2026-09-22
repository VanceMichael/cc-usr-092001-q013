import { DomainError, ErrorCode } from "./errors.js";
import { nowIso, parseInstant } from "./time.js";
import { runInSavepoint } from "./db.js";
import { effectiveRuleAt, getLabel, getRecipe } from "./masterdata.js";
import { evaluateCarton, latestDecision, recordDecision } from "./compliance.js";
import { getBatch, getCarton, hydrateCarton, recordCartonEvent } from "./batches.js";

export const CartonStatus = {
  PACKED: "PACKED",
  INSPECTED: "INSPECTED",
  CUSTOMS_DECLARED: "CUSTOMS_DECLARED",
  LOADED: "LOADED",
  DEPARTED: "DEPARTED",
  ARRIVED: "ARRIVED",
  SOLD_OUT: "SOLD_OUT",
};

const STATUS_RANK = {
  PACKED: 0,
  INSPECTED: 1,
  CUSTOMS_DECLARED: 2,
  LOADED: 3,
  DEPARTED: 4,
  ARRIVED: 5,
  SOLD_OUT: 6,
};

// 各推进动作要求的当前状态；重复扫描到已处于（或越过）目标状态时按幂等处理。
const ADVANCE_ACTIONS = {
  CUSTOMS_DECLARE: { from: "INSPECTED", to: "CUSTOMS_DECLARED", requireCompliance: true },
  LOAD: { from: "CUSTOMS_DECLARED", to: "LOADED", requireCompliance: true },
  ARRIVE: { from: "DEPARTED", to: "ARRIVED" },
  SELL_OUT: { from: "ARRIVED", to: "SOLD_OUT" },
};

/* ---------------- 逐件合规核验（装箱后、报关前） ---------------- */

/**
 * 检验一箱：按该时刻目的国现行规则核验。不合格只置本箱 held（阻断对应目的地的这箱货），
 * 不影响同批次其他箱或其他目的地。
 * 重复扫描已检验箱返回既有结论（幂等，不产生增量）；返工重贴后状态回到 PACKED，可重新检验。
 */
export function inspectCarton(database, input) {
  const cartonRef = input.carton_ref;
  const at = parseInstant(input.at ?? nowIso(), "at");
  const carton = getCarton(database, cartonRef);

  if (STATUS_RANK[carton.status] >= STATUS_RANK.INSPECTED && !carton.held) {
    return { carton_ref: cartonRef, idempotent: true, decision: latestDecision(database, cartonRef) };
  }
  if (carton.held && carton.status !== "PACKED") {
    throw new DomainError(ErrorCode.INVALID_TRANSITION, `箱 ${cartonRef} 处于扣留状态，请发起复验或返工重贴`);
  }
  // PACKED 状态下：同标签已有结论时，重复扫描直接返回该结论；重贴后标签变更才会重新检验
  if (carton.status === "PACKED") {
    const decision = latestDecision(database, cartonRef);
    if (decision && decision.label_id === carton.label_id) {
      return { carton_ref: cartonRef, idempotent: true, passed: decision.passed, rule_id: decision.rule_id, findings: decision.findings, decision };
    }
  }
  return runEvaluation(database, { carton, at, eventId: input.event_id, action: "INSPECT", advanceOnPass: true });
}

/**
 * 复验：离港前任何状态都可发起，按当前现行规则重新核验（规则临时更新后由系统批量调用）。
 * 复验通过且箱仍在 PACKED 时推进到 INSPECTED；否则只刷新扣留结论，不改物流状态。
 */
export function reinspectCarton(database, input) {
  const cartonRef = input.carton_ref;
  const at = parseInstant(input.at ?? nowIso(), "at");
  const carton = getCarton(database, cartonRef);
  if (STATUS_RANK[carton.status] >= STATUS_RANK.DEPARTED) {
    throw new DomainError(ErrorCode.INVALID_TRANSITION, "货物已离港，规则版本已冻结，不能复验");
  }
  return runEvaluation(database, { carton, at, eventId: input.event_id, action: "REINSPECT", advanceOnPass: carton.status === "PACKED" });
}

function runEvaluation(database, { carton, at, eventId, action, advanceOnPass }) {
  const rule = effectiveRuleAt(database, carton.country_code, at);
  const batch = getBatch(database, carton.batch_id);
  const recipe = getRecipe(database, batch.recipe_id);
  const label = getLabel(database, carton.label_id);
  const result = evaluateCarton({ recipe, label, rule });
  recordDecision(database, { cartonRef: carton.carton_ref, rule, recipe, label, result, trigger: action, decidedAt: at });

  database
    .prepare("UPDATE cartons SET held = ?, held_findings = ?, updated_at = ? WHERE carton_ref = ?")
    .run(result.passed ? 0 : 1, JSON.stringify(result.findings), at, carton.carton_ref);

  if (result.passed && advanceOnPass) {
    advanceStatus(database, carton.carton_ref, carton.status, "INSPECTED", action, at, eventId);
  } else {
    recordCartonEvent(database, {
      cartonRef: carton.carton_ref, action, fromStatus: carton.status, toStatus: carton.status,
      eventId: eventId ?? null, occurredAt: at,
      note: result.passed ? "复验通过" : `阻断：${result.findings.map((f) => f.code).join(",")}`,
    });
  }
  return {
    carton_ref: carton.carton_ref,
    idempotent: false,
    passed: result.passed,
    rule_id: rule.rule_id,
    findings: result.findings,
  };
}

/* ---------------- 返工重贴：被阻断的箱更换合规标签后重走流程 ---------------- */

/**
 * 重贴标签：仅允许离港前。新标签必须仍与批次配方一致；箱状态回到 PACKED，
 * 须重新检验、报关、装柜（已装柜的箱视为卸柜返工）。离港后只能走召回。
 */
export function relabelCarton(database, input) {
  const cartonRef = input.carton_ref;
  const labelId = input.label_id;
  if (!labelId) throw new DomainError(ErrorCode.VALIDATION, "label_id 必填");
  const at = parseInstant(input.at ?? nowIso(), "at");
  const carton = getCarton(database, cartonRef);
  if (STATUS_RANK[carton.status] >= STATUS_RANK.DEPARTED) {
    throw new DomainError(ErrorCode.INVALID_TRANSITION, "货物已离港，不能重贴标签；请走召回流程");
  }
  const batch = getBatch(database, carton.batch_id);
  const label = getLabel(database, labelId);
  if (label.sku !== carton.sku || label.recipe_id !== batch.recipe_id) {
    throw new DomainError(
      ErrorCode.VALIDATION,
      `新标签 ${labelId} 必须基于批次 ${batch.batch_id} 的配方 ${batch.recipe_id}`,
    );
  }
  if (label.label_id === carton.label_id) {
    throw new DomainError(ErrorCode.VALIDATION, `箱 ${cartonRef} 已使用标签 ${labelId}`);
  }
  const wasLoaded = carton.status === "LOADED";
  database
    .prepare(
      `UPDATE cartons SET label_id = ?, status = 'PACKED', held = 0, held_findings = NULL,
                          container_ref = NULL, updated_at = ?
       WHERE carton_ref = ?`,
    )
    .run(labelId, at, cartonRef);
  recordCartonEvent(database, {
    cartonRef, action: "RELABEL", fromStatus: carton.status, toStatus: "PACKED",
    eventId: input.event_id ?? null, occurredAt: at,
    note: `更换为标签 ${labelId}${wasLoaded ? "，自货柜卸下返工" : ""}，待重新检验`,
  });
  return { carton_ref: cartonRef, label_id: labelId, status: "PACKED", reinspection_required: true };
}

/* ---------------- 报关 / 装柜 / 离港 / 到港 / 售罄 ---------------- */

export function declareCustoms(database, input) {
  return advance(database, { ...input, action: "CUSTOMS_DECLARE" });
}

export function loadContainer(database, input) {
  const containerRef = input.container_ref;
  if (!containerRef) throw new DomainError(ErrorCode.VALIDATION, "container_ref 必填");
  const cartonRefs = input.carton_refs;
  if (!Array.isArray(cartonRefs) || cartonRefs.length === 0) {
    throw new DomainError(ErrorCode.VALIDATION, "carton_refs 至少包含一箱");
  }
  const at = parseInstant(input.at ?? nowIso(), "at");
  return runInSavepoint(database, "load_container", () => {
    const loaded = [];
    for (const cartonRef of cartonRefs) {
      const result = advance(database, { carton_ref: cartonRef, at, action: "LOAD", event_id: input.event_id });
      if (!result.idempotent) {
        database.prepare("UPDATE cartons SET container_ref = ?, updated_at = ? WHERE carton_ref = ?")
          .run(containerRef, at, cartonRef);
      } else if (result.container_ref !== containerRef) {
        throw new DomainError(
          ErrorCode.CONFLICT,
          `箱 ${cartonRef} 已装入货柜 ${result.container_ref}，重复扫描不能改挂其他货柜`,
        );
      }
      loaded.push(cartonRef);
    }
    return { container_ref: containerRef, cartons: loaded };
  });
}

export function departContainer(database, input) {
  const containerRef = input.container_ref;
  const at = parseInstant(input.at ?? nowIso(), "at");
  const cartons = database
    .prepare("SELECT * FROM cartons WHERE container_ref = ? ORDER BY carton_ref")
    .all(containerRef)
    .map(hydrateCarton);
  if (cartons.length === 0) throw new DomainError(ErrorCode.NOT_FOUND, `货柜 ${containerRef} 内无货物`);

  return runInSavepoint(database, "depart_container", () => {
    const departed = [];
    for (const carton of cartons) {
      const rank = STATUS_RANK[carton.status];
      if (rank > STATUS_RANK.LOADED) {
        // 离港后的重复离港扫描
        departed.push({ carton_ref: carton.carton_ref, idempotent: true, rule_id: carton.rule_id_at_departure });
        continue;
      }
      if (carton.status !== "LOADED") {
        throw new DomainError(
          ErrorCode.INVALID_TRANSITION,
          `箱 ${carton.carton_ref} 状态 ${carton.status}，不能离港（须已装柜）`,
        );
      }
      if (carton.held) {
        throw new DomainError(
          ErrorCode.COMPLIANCE_BLOCKED,
          `箱 ${carton.carton_ref} 存在未解除的合规阻断，不能离港；阻断仅限该目的地对应货物`,
        );
      }
      // 离港即冻结：把当时有效的规则版本固化到箱上
      const rule = effectiveRuleAt(database, carton.country_code, at);
      database
        .prepare("UPDATE cartons SET status = 'DEPARTED', rule_id_at_departure = ?, updated_at = ? WHERE carton_ref = ?")
        .run(rule.rule_id, at, carton.carton_ref);
      recordCartonEvent(database, {
        cartonRef: carton.carton_ref, action: "DEPART", fromStatus: "LOADED", toStatus: "DEPARTED",
        eventId: input.event_id, occurredAt: at, note: `锁定规则 ${rule.rule_id}`,
      });
      departed.push({ carton_ref: carton.carton_ref, idempotent: false, rule_id: rule.rule_id });
    }
    return { container_ref: containerRef, departed };
  });
}

export function arriveContainer(database, input) {
  const containerRef = input.container_ref;
  const at = parseInstant(input.at ?? nowIso(), "at");
  const cartons = database
    .prepare("SELECT * FROM cartons WHERE container_ref = ? ORDER BY carton_ref")
    .all(containerRef)
    .map(hydrateCarton);
  if (cartons.length === 0) throw new DomainError(ErrorCode.NOT_FOUND, `货柜 ${containerRef} 内无货物`);
  return runInSavepoint(database, "arrive_container", () => {
    const arrived = [];
    for (const carton of cartons) {
      const result = advance(database, { carton_ref: carton.carton_ref, at, action: "ARRIVE", event_id: input.event_id });
      arrived.push({ carton_ref: carton.carton_ref, idempotent: result.idempotent });
    }
    return { container_ref: containerRef, arrived };
  });
}

export function sellOutCarton(database, input) {
  // 售罄回执：重复回执幂等，不改变任何数量
  return advance(database, { ...input, action: "SELL_OUT" });
}

function advance(database, input) {
  const cartonRef = input.carton_ref;
  const at = parseInstant(input.at ?? nowIso(), "at");
  const action = input.action;
  const spec = ADVANCE_ACTIONS[action];
  const carton = getCarton(database, cartonRef);
  const rank = STATUS_RANK[carton.status];
  const targetRank = STATUS_RANK[spec.to];

  // 重复扫描：已处于或越过目标状态，不产生任何增量
  if (rank >= targetRank) {
    return { carton_ref: cartonRef, idempotent: true, status: carton.status, container_ref: carton.container_ref };
  }
  // 合规扣留优先于状态错误暴露：不合格项只阻断对应目的地的货物
  if (spec.requireCompliance) {
    const decision = latestDecision(database, cartonRef);
    const notCleared =
      carton.held || !decision || !decision.passed || decision.label_id !== carton.label_id;
    if (notCleared) {
      throw new DomainError(
        ErrorCode.COMPLIANCE_BLOCKED,
        `箱 ${cartonRef} 缺少当前标签 ${carton.label_id} 的有效通过核验，${action} 被阻断；仅阻断该目的地对应货物`,
        { findings: carton.held ? (decision?.findings ?? carton.held_findings ?? []) : [] },
      );
    }
  }
  if (carton.status !== spec.from) {
    throw new DomainError(
      ErrorCode.INVALID_TRANSITION,
      `箱 ${cartonRef} 当前状态 ${carton.status}，不能执行 ${action}（须为 ${spec.from}）`,
    );
  }
  advanceStatus(database, cartonRef, spec.from, spec.to, action, at, input.event_id);
  return { carton_ref: cartonRef, idempotent: false, status: spec.to };
}

function advanceStatus(database, cartonRef, fromStatus, toStatus, action, at, eventId) {
  database.prepare("UPDATE cartons SET status = ?, updated_at = ? WHERE carton_ref = ?")
    .run(toStatus, at, cartonRef);
  recordCartonEvent(database, { cartonRef, action, fromStatus, toStatus, eventId: eventId ?? null, occurredAt: at });
}

/* ---------------- 规则临时更新的三类分流 ---------------- */

/**
 * 规则临时更新后按货物所处阶段分流：
 * - 已离港（DEPARTED/ARRIVED/SOLD_OUT）：沿用离港时锁定的规则，冻结不动；
 * - 已生产未离港（PACKED/INSPECTED/CUSTOMS_DECLARED/LOADED）：按更新时刻现行规则重新核验，
 *   不合格只扣留对应目的地的箱；
 * - 未生产货物（仅有订单/待投产）：不处理，将来检验时自然解析到新规则版本。
 */
export function applyRuleUpdate(database, input) {
  const countryCode = requireCode(input.country_code);
  const at = parseInstant(input.at ?? nowIso(), "at");
  const rule = effectiveRuleAt(database, countryCode, at);

  const rows = database
    .prepare("SELECT * FROM cartons WHERE country_code = ? ORDER BY status, carton_ref")
    .all(countryCode)
    .map(hydrateCarton);

  return runInSavepoint(database, "rule_update", () => {
    const frozen = [];
    const reevaluated = [];
    for (const carton of rows) {
      if (STATUS_RANK[carton.status] >= STATUS_RANK.DEPARTED) {
        frozen.push({ carton_ref: carton.carton_ref, status: carton.status, locked_rule_id: carton.rule_id_at_departure });
        continue;
      }
      const batch = getBatch(database, carton.batch_id);
      const recipe = getRecipe(database, batch.recipe_id);
      const label = getLabel(database, carton.label_id);
      const result = evaluateCarton({ recipe, label, rule });
      recordDecision(database, {
        cartonRef: carton.carton_ref, rule, recipe, label, result, trigger: "RULE_UPDATE", decidedAt: at,
      });
      database
        .prepare("UPDATE cartons SET held = ?, held_findings = ?, updated_at = ? WHERE carton_ref = ?")
        .run(result.passed ? 0 : 1, JSON.stringify(result.findings), at, carton.carton_ref);
      reevaluated.push({ carton_ref: carton.carton_ref, status: carton.status, passed: result.passed, findings: result.findings });
    }
    return {
      country_code: countryCode,
      applied_rule_id: rule.rule_id,
      frozen_departed: frozen,
      reevaluated,
      unproduced_note: "未生产货物不重评；其未来检验时自动适用届时有效规则版本",
    };
  });
}

function requireCode(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(ErrorCode.VALIDATION, "country_code 必填");
  }
  return value.toUpperCase();
}
