import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/server.js";
import { freshDb, seedMasterData, T } from "./helpers.js";

async function withServer(run) {
  const db = freshDb();
  seedMasterData(db);
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test("HTTP 端到端：主数据 → 生产 → 装箱 → 装柜 → 离港 → 解释", async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });

    let result = await post(base, "/v1/batches", {
      id: "B-API-1",
      product_ref: "P-MOONCAKE",
      recipe_version_id: "RV-1",
      planned_qty: 100,
      created_at: T.produce,
    });
    assert.equal(result.status, 201);

    result = await post(base, "/v1/batches/B-API-1/produce", {
      lot_id: "L-API-1",
      qty: 100,
      at: T.produce,
    });
    assert.equal(result.status, 201);

    result = await post(base, "/v1/lots/L-API-1/inspect", { result: "pass", at: T.produce });
    assert.equal(result.status, 200);

    // 中文标签发 AU：422，且响应携带不合格项。
    result = await post(base, "/v1/cases/scan", {
      case_ref: "CASE-API-BAD",
      lot_id: "L-API-1",
      qty: 10,
      market: "AU",
      dealer_ref: "DEALER-A",
      label_layout_id: "LBL-ZH-V1",
      packed_at: T.pack,
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, "compliance_failed");
    assert.ok(result.body.error.details.failures.includes("language_not_accepted"));

    // 英文标签：通过；带 event_id 重复提交返回重放。
    const scanBody = {
      event_id: "EV-API-1",
      case_ref: "CASE-API-1",
      lot_id: "L-API-1",
      qty: 10,
      market: "AU",
      dealer_ref: "DEALER-A",
      label_layout_id: "LBL-EN-V1",
      packed_at: T.pack,
    };
    result = await post(base, "/v1/cases/scan", scanBody);
    assert.equal(result.status, 201);
    const replay = await post(base, "/v1/cases/scan", scanBody);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replay"), "true");

    // 之前中文标签触发的 AU 阻断仍在，先解除才能装柜。
    const blocks = await fetch(`${base}/v1/destination-blocks?market=AU&active=true`);
    const [{ id: blockId }] = (await blocks.json()).blocks;
    result = await post(base, `/v1/destination-blocks/${blockId}/lift`, {
      reason: "已确认换用英文版式",
      lifted_at: T.pack,
    });
    assert.equal(result.status, 200);

    await post(base, "/v1/shipments", { id: "SHP-API-1", market: "AU", created_at: T.pack });
    result = await post(base, "/v1/shipments/SHP-API-1/load", { case_ref: "CASE-API-1" });
    assert.equal(result.status, 201);
    result = await post(base, "/v1/shipments/SHP-API-1/depart", { departed_at: T.depart });
    assert.equal(result.status, 200);
    assert.equal(result.body.cleared_rule_id, "MR-AU-1");

    const explanation = await fetch(`${base}/v1/cases/CASE-API-1/explanation`);
    const detail = await explanation.json();
    assert.equal(detail.decision, "allowed");
    assert.equal(detail.label.language, "en");

    // 未知路由与坏 JSON。
    const missing = await fetch(`${base}/v1/nope`);
    assert.equal(missing.status, 404);
    const badJson = await fetch(`${base}/v1/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
  });
});
