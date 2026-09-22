import { DomainError } from "./errors.js";

const STATUS_BY_CODE = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_EVENT: 409,
  INVALID_TRANSITION: 409,
  QUANTITY_CONSERVATION_VIOLATED: 422,
  COMPLIANCE_BLOCKED: 422,
  RULE_SUPERSEDED: 422,
};

/** 构造请求监听器：写操作走命令/事件入口，读操作走 read 门面。 */
export function createRouter(app) {
  return async function router(request, response) {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok" });
      }
      if (request.method === "POST" && url.pathname === "/v1/events") {
        const body = await readJson(request);
        const result = app.ingestEvent(body);
        return send(response, 202, result);
      }
      const match = matchRoute(request.method, url.pathname);
      if (!match) return send(response, 404, { error: { code: "NOT_FOUND", message: "未知路径" } });

      const body = request.method === "POST" ? await readJson(request) : {};
      const context = { params: match.params, query: url.searchParams, body };
      const result = await match.handler(app, context);
      return send(response, result.statusCode, result.body);
    } catch (error) {
      if (error instanceof DomainError) {
        return send(response, STATUS_BY_CODE[error.code] ?? 400, {
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      if (error instanceof SyntaxError) {
        return send(response, 400, { error: { code: "VALIDATION_FAILED", message: "请求体不是合法 JSON" } });
      }
      console.error(error);
      return send(response, 500, { error: { code: "INTERNAL", message: "内部错误" } });
    }
  };
}

function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = matchPath(route.pattern, pathname);
    if (params) return { handler: route.handler, params };
  }
  return null;
}

function matchPath(pattern, pathname) {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      throw new DomainError("VALIDATION_FAILED", "请求体超过 2MiB 限制");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

const post = (pattern, type) => ({
  method: "POST",
  pattern,
  handler: (app, { params, body }) => ({
    statusCode: 201,
    body: app.command(type, { ...body, ...params }),
  }),
});

const get = (pattern, selector) => ({
  method: "GET",
  pattern,
  handler: (app, context) => ({ statusCode: 200, body: selector(app, context) }),
});

const ROUTES = [
  post("/v1/products", "product.registered"),
  post("/v1/recipes", "recipe.created"),
  post("/v1/labels", "label.created"),
  post("/v1/rules", "rule.created"),
  post("/v1/orders", "order.placed"),
  post("/v1/batches", "batch.produced"),
  post("/v1/batches/:parent_batch_id/splits", "batch.split"),
  post("/v1/batch-merges", "batch.merged"),
  post("/v1/allocations", "batch.allocated"),
  post("/v1/allocations/:allocation_id/pack", "cartons.packed"),
  post("/v1/cartons/:carton_ref/inspections", "carton.inspected"),
  post("/v1/cartons/:carton_ref/reinspections", "carton.reinspected"),
  post("/v1/cartons/:carton_ref/relabel", "carton.relabelled"),
  post("/v1/cartons/:carton_ref/customs-declarations", "carton.customs_declared"),
  post("/v1/container-loads", "container.loaded"),
  post("/v1/containers/:container_ref/departures", "container.departed"),
  post("/v1/containers/:container_ref/arrivals", "container.arrived"),
  post("/v1/cartons/:carton_ref/sell-out-receipts", "carton.sold_out"),
  post("/v1/rule-updates", "rule.update_applied"),
  post("/v1/recalls", "recall.created"),

  get("/v1/batches/:batch_id", (app, { params }) => app.read.batch(params.batch_id)),
  get("/v1/recipes/:recipe_id", (app, { params }) => app.read.recipe(params.recipe_id)),
  get("/v1/labels/:label_id", (app, { params }) => app.read.label(params.label_id)),
  get("/v1/rules/:rule_id", (app, { params }) => app.read.rule(params.rule_id)),
  get("/v1/countries/:country_code/effective-rule",
    (app, { params, query }) => app.read.effectiveRule(params.country_code, query.get("at") ?? new Date().toISOString())),
  get("/v1/cartons/:carton_ref/explain", (app, { params }) => app.read.explain(params.carton_ref)),
  get("/v1/recalls/:recall_id", (app, { params }) => app.read.recall(params.recall_id)),
  get("/v1/repurchase", (app, { query }) => ({
    distributors: app.read.repurchase({ distributor_ref: query.get("distributor_ref") ?? undefined }),
  })),
  get("/v1/conservation", (app) => ({ batches: app.read.conservation() })),
];