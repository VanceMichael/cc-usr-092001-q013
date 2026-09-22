import { DomainError, ErrorCode } from "./errors.js";
import { receiveEvent } from "./events.js";
import {
  createDestinationRule,
  createLabelLayout,
  createRecipeVersion,
  effectiveRuleAt,
  getLabel,
  getRecipe,
  getRule,
  registerProduct,
} from "./masterdata.js";
import {
  allocateBatch,
  createOrder,
  getBatch,
  listCartonsByBatch,
  mergeBatches,
  packCartons,
  produceBatch,
  splitBatch,
  verifyConservation,
} from "./batches.js";
import {
  applyRuleUpdate,
  arriveContainer,
  declareCustoms,
  departContainer,
  inspectCarton,
  loadContainer,
  reinspectCarton,
  relabelCarton,
  sellOutCarton,
} from "./logistics.js";
import {
  conservationReport,
  createRecall,
  explainCarton,
  getRecall,
  repurchaseSummary,
} from "./traceability.js";

const ENVELOPE_FIELDS = [
  "event_id",
  "source",
  "source_sequence",
  "event_type",
  "occurred_at",
  "subject_ref",
  "payload_digest",
];

/** 应用门面：领域操作均通过这里进入，事件信封在此统一去重。 */
export function createApp(database) {
  /** 事件类型到领域处理函数的映射；处理函数接收信封上下文与载荷。 */
  const handlers = {
    "product.registered": (_ctx, p) => registerProduct(database, p),
    "recipe.created": (_ctx, p) => createRecipeVersion(database, p),
    "label.created": (_ctx, p) => createLabelLayout(database, p),
    "rule.created": (_ctx, p) => createDestinationRule(database, p),
    "order.placed": (_ctx, p) => createOrder(database, p),
    "batch.produced": (_ctx, p) => produceBatch(database, p),
    "batch.split": (ctx, p) => splitBatch(database, { ...p, event_id: ctx.event.eventId }),
    "batch.merged": (_ctx, p) => mergeBatches(database, p),
    "batch.allocated": (_ctx, p) => allocateBatch(database, p),
    "cartons.packed": (ctx, p) => packCartons(database, { ...p, event_id: ctx.event.eventId }),
    "carton.inspected": (ctx, p) => inspectCarton(database, { ...p, event_id: ctx.event.eventId }),
    "carton.reinspected": (ctx, p) => reinspectCarton(database, { ...p, event_id: ctx.event.eventId }),
    "carton.relabelled": (ctx, p) => relabelCarton(database, { ...p, event_id: ctx.event.eventId }),
    "carton.customs_declared": (ctx, p) => declareCustoms(database, { ...p, event_id: ctx.event.eventId }),
    "container.loaded": (ctx, p) => loadContainer(database, { ...p, event_id: ctx.event.eventId }),
    "container.departed": (ctx, p) => departContainer(database, { ...p, event_id: ctx.event.eventId }),
    "container.arrived": (ctx, p) => arriveContainer(database, { ...p, event_id: ctx.event.eventId }),
    "carton.sold_out": (ctx, p) => sellOutCarton(database, { ...p, event_id: ctx.event.eventId }),
    "rule.update_applied": (_ctx, p) => applyRuleUpdate(database, p),
    "recall.created": (_ctx, p) => createRecall(database, p),
  };

  const invoke = (type, payload, ctx = { event: { eventId: null } }) => {
    const handler = handlers[type];
    if (!handler) throw new DomainError(ErrorCode.VALIDATION, `未知事件类型：${type}`);
    return handler(ctx, payload ?? {});
  };

  /** 完整事件信封入口（POST /v1/events）。event_id/来源序号去重，occurred_at 原样保留。 */
  const ingestEvent = (envelope) =>
    receiveEvent(database, envelope, (ctx) => invoke(ctx.event.eventType, ctx.payload, ctx));

  /**
   * 命令式入口：载荷自带信封字段时按信封幂等处理，否则直接执行
   *（业务键唯一约束对箱号扫描、经销商重传另有兜底）。
   */
  const command = (type, body) => {
    const hasEnvelope = body && body.event_id && body.source && body.source_sequence != null;
    if (hasEnvelope) {
      const { payload, ...rest } = body;
      return ingestEvent({ ...rest, event_type: rest.event_type ?? type, payload: payload ?? stripEnvelope(body) });
    }
    return invoke(type, body);
  };

  const read = {
    batch: (id) => ({
      batch: getBatch(database, id),
      conservation: verifyConservation(database, id),
      cartons: listCartonsByBatch(database, id),
    }),
    recipe: (id) => getRecipe(database, id),
    label: (id) => getLabel(database, id),
    rule: (id) => getRule(database, id),
    effectiveRule: (countryCode, at) => effectiveRuleAt(database, countryCode, at),
    explain: (cartonRef) => explainCarton(database, cartonRef),
    recall: (id) => getRecall(database, id),
    repurchase: (query) => repurchaseSummary(database, query),
    conservation: () => conservationReport(database),
  };

  return { database, ingestEvent, command, read };
}

function stripEnvelope(body) {
  const rest = { ...body };
  for (const field of ENVELOPE_FIELDS) delete rest[field];
  return rest;
}
