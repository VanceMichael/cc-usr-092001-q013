import http from "node:http";
import path from "node:path";

import { openDatabase } from "./schema.js";
import {
  ApiError,
  batchOverview,
  createBatch,
  createLabelLayout,
  createMarketRule,
  createRecipeVersion,
  createShipment,
  departShipment,
  arriveShipment,
  explainCase,
  getRecall,
  getShipment,
  inspectLot,
  issueRecall,
  liftDestinationBlock,
  listDestinationBlocks,
  listMarketRules,
  loadCase,
  mergeLots,
  produceBatch,
  recordReceipt,
  repurchaseReport,
  scanCase,
  splitLot,
  submitShipmentForCustoms,
  unloadCase,
} from "./store.js";

export function healthPayload() {
  return { status: "ok" };
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, "body_too_large", "请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

// 路由表：[方法, 路径正则, 处理器]。处理器是普通函数，调用时 this 绑定为 { db }，
// 返回 [状态码, 响应体, 额外响应头?]。
const routes = [
  ["GET", /^\/health$/, function () {
    return [200, healthPayload()];
  }],
  ["POST", /^\/v1\/recipe-versions$/, function (body) {
    return [201, createRecipeVersion(this.db, body)];
  }],
  ["POST", /^\/v1\/label-layouts$/, function (body) {
    return [201, createLabelLayout(this.db, body)];
  }],
  ["POST", /^\/v1\/market-rules$/, function (body) {
    return [201, createMarketRule(this.db, body)];
  }],
  ["GET", /^\/v1\/market-rules$/, function (body, query) {
    return [200, { rules: listMarketRules(this.db, query.get("market")) }];
  }],
  ["POST", /^\/v1\/batches$/, function (body) {
    return [201, createBatch(this.db, body)];
  }],
  ["GET", /^\/v1\/batches\/([^/]+)$/, function (body, query, [id]) {
    return [200, batchOverview(this.db, decodeURIComponent(id))];
  }],
  ["POST", /^\/v1\/batches\/([^/]+)\/produce$/, function (body, query, [id]) {
    return [201, produceBatch(this.db, decodeURIComponent(id), body)];
  }],
  ["POST", /^\/v1\/lots\/([^/]+)\/split$/, function (body, query, [id]) {
    return [201, splitLot(this.db, decodeURIComponent(id), body)];
  }],
  ["POST", /^\/v1\/lots\/merge$/, function (body) {
    return [201, mergeLots(this.db, body)];
  }],
  ["POST", /^\/v1\/lots\/([^/]+)\/inspect$/, function (body, query, [id]) {
    return [200, inspectLot(this.db, decodeURIComponent(id), body)];
  }],
  ["POST", /^\/v1\/cases\/scan$/, function (body) {
    const result = scanCase(this.db, body);
    const replay = result.replay || result.body.duplicated;
    const headers = replay ? { "idempotent-replay": "true" } : {};
    if (!result.body.ok) {
      return [422, {
        error: {
          code: "compliance_failed",
          message: "装箱合规校验不合格，已阻断对应目的地的货物",
          details: result.body,
        },
      }, headers];
    }
    return [replay ? 200 : 201, result.body, headers];
  }],
  ["GET", /^\/v1\/cases\/([^/]+)\/explanation$/, function (body, query, [ref]) {
    return [200, explainCase(this.db, decodeURIComponent(ref))];
  }],
  ["POST", /^\/v1\/shipments$/, function (body) {
    return [201, createShipment(this.db, body)];
  }],
  ["GET", /^\/v1\/shipments\/([^/]+)$/, function (body, query, [id]) {
    return [200, getShipment(this.db, decodeURIComponent(id))];
  }],
  ["POST", /^\/v1\/shipments\/([^/]+)\/load$/, function (body, query, [id]) {
    const result = loadCase(this.db, decodeURIComponent(id), body);
    const replay = result.replay || result.body.duplicated;
    return [replay ? 200 : 201, result.body, replay ? { "idempotent-replay": "true" } : {}];
  }],
  ["POST", /^\/v1\/shipments\/([^/]+)\/unload$/, function (body, query, [id]) {
    return [200, unloadCase(this.db, decodeURIComponent(id), body)];
  }],
  ["POST", /^\/v1\/shipments\/([^/]+)\/submit-customs$/, function (body, query, [id]) {
    return [200, submitShipmentForCustoms(this.db, decodeURIComponent(id), body)];
  }],
  ["POST", /^\/v1\/shipments\/([^/]+)\/depart$/, function (body, query, [id]) {
    const result = departShipment(this.db, decodeURIComponent(id), body);
    return [200, result.body, result.replay ? { "idempotent-replay": "true" } : {}];
  }],
  ["POST", /^\/v1\/shipments\/([^/]+)\/arrive$/, function (body, query, [id]) {
    const result = arriveShipment(this.db, decodeURIComponent(id), body);
    return [200, result.body, result.replay ? { "idempotent-replay": "true" } : {}];
  }],
  ["POST", /^\/v1\/receipts$/, function (body) {
    const result = recordReceipt(this.db, body);
    const replay = result.replay || result.body.duplicated;
    return [replay ? 200 : 201, result.body, replay ? { "idempotent-replay": "true" } : {}];
  }],
  ["POST", /^\/v1\/recalls$/, function (body) {
    return [201, issueRecall(this.db, body)];
  }],
  ["GET", /^\/v1\/recalls\/([^/]+)$/, function (body, query, [id]) {
    return [200, getRecall(this.db, decodeURIComponent(id))];
  }],
  ["GET", /^\/v1\/destination-blocks$/, function (body, query) {
    return [200, {
      blocks: listDestinationBlocks(this.db, {
        market: query.get("market") ?? undefined,
        active: query.has("active") ? query.get("active") === "true" : undefined,
      }),
    }];
  }],
  ["POST", /^\/v1\/destination-blocks\/(\d+)\/lift$/, function (body, query, [id]) {
    return [200, liftDestinationBlock(this.db, Number(id), body)];
  }],
  ["GET", /^\/v1\/reports\/repurchase$/, function (body, query) {
    return [200, {
      report: repurchaseReport(this.db, {
        product_ref: query.get("product_ref") ?? undefined,
        market: query.get("market") ?? undefined,
      }),
    }];
  }],
];

export function createServer(database) {
  const db =
    database ??
    openDatabase(process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3"));
  const context = { db };
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname;
      for (const [method, pattern, handler] of routes) {
        if (method !== request.method) continue;
        const match = pattern.exec(pathname);
        if (!match) continue;
        const body = request.method === "GET" ? {} : await readBody(request);
        const [status, payload, headers] = handler.call(
          context,
          body,
          url.searchParams,
          match.slice(1),
        );
        sendJson(response, status, payload, headers);
        return;
      }
      sendJson(response, 404, { error: { code: "not_found", message: "路由不存在" } });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
        return;
      }
      sendJson(response, 500, { error: { code: "internal_error", message: "服务内部错误" } });
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "0.0.0.0");
}
