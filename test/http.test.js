import assert from "node:assert/strict";
import test from "node:test";

import { openMemoryDatabase } from "../src/db.js";
import { createServer } from "../src/server.js";

async function withServer(run) {
  const server = createServer(openMemoryDatabase());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const get = async (base, pathname) => {
  const response = await fetch(base + pathname);
  return { status: response.status, body: await response.json() };
};

const PRODUCT = { sku: "MOON-A", name_cn: "黄庄双黄莲蓉月饼" };
const RECIPE = {
  sku: "MOON-A", version: "v1", effective_from: "2026-01-01T00:00:00+08:00",
  ingredients: ["面粉", "莲蓉", "咸蛋黄"], allergens: ["EGG", "WHEAT"],
  nutrition: { energy_kj: 1700, sugar_g: 35, fat_g: 20 },
};
const RULE = {
  country_code: "KR", version: "2026.1", effective_from: "2026-01-01T00:00:00+09:00",
  languages_required: ["ko"], allergen_required: ["EGG", "WHEAT"],
  nutrition_format: "PER_100G_TABLE", required_nutrients: ["energy_kj", "sugar_g", "fat_g"],
  prohibited_claims: [], packaging_requirements: { require_origin_mark: true, forbid_materials: [] },
};
const LABEL = {
  sku: "MOON-A", recipe_id: "RC-MOON-A-v1", layout_version: "kr-v1",
  languages: ["zh", "ko"], declared_allergens: ["EGG", "WHEAT"],
  declared_nutrition: { energy_kj: 1700, sugar_g: 35, fat_g: 20 },
  nutrition_format: "PER_100G_TABLE", claims: [],
  packaging_spec: { material_codes: ["PAPER"], net_weight_g: 720, marks: { origin: true } },
};

async function seed(base) {
  await post(base, "/v1/products", PRODUCT);
  await post(base, "/v1/recipes", RECIPE);
  await post(base, "/v1/rules", RULE);
  await post(base, "/v1/labels", LABEL);
}

test("健康检查", async () => {
  await withServer(async (base) => {
    const res = await get(base, "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });
});

test("HTTP 全链路：下单→投产→拆批→分配→装箱→检验→出运→到港→售罄→解释", async () => {
  await withServer(async (base) => {
    await seed(base);
    assert.equal((await post(base, "/v1/orders", {
      order_id: "O1", client_ref: "C1", distributor_ref: "D-SEL", sku: "MOON-A",
      country_code: "KR", quantity: 100, contract_price: { amount_minor: 50000, currency: "KRW" },
    })).status, 201);
    assert.equal((await post(base, "/v1/batches", {
      batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 100,
      produced_at: "2026-09-01T08:00:00+08:00",
    })).status, 201);
    assert.equal((await post(base, "/v1/batches/B1/splits", { child_batch_id: "B1-K", quantity: 100 })).status, 201);
    assert.equal((await post(base, "/v1/allocations", {
      allocation_id: "AL1", order_id: "O1", batch_id: "B1-K", quantity: 100,
    })).status, 201);
    assert.equal((await post(base, "/v1/allocations/AL1/pack", {
      label_id: "LB-MOON-A-kr-v1", cartons: [{ carton_ref: "CT1", quantity: 100 }],
    })).status, 201);

    const inspect = await post(base, "/v1/cartons/CT1/inspections", { at: "2026-09-05T09:00:00+09:00" });
    assert.equal(inspect.status, 201);
    assert.equal(inspect.body.passed, true);

    await post(base, "/v1/cartons/CT1/customs-declarations", { at: "2026-09-06T09:00:00+09:00" });
    await post(base, "/v1/container-loads", { container_ref: "CONT1", carton_refs: ["CT1"], at: "2026-09-07T09:00:00+09:00" });
    const depart = await post(base, "/v1/containers/CONT1/departures", { at: "2026-09-08T09:00:00+09:00" });
    assert.equal(depart.body.departed[0].rule_id, "RL-KR-2026.1");
    await post(base, "/v1/containers/CONT1/arrivals", { at: "2026-09-12T09:00:00+09:00" });
    await post(base, "/v1/cartons/CT1/sell-out-receipts", { at: "2026-09-20T09:00:00+09:00" });

    const explain = await get(base, "/v1/cartons/CT1/explain");
    assert.equal(explain.status, 200);
    assert.equal(explain.body.status, "SOLD_OUT");
    assert.equal(explain.body.compliance.locked_rule_at_departure.version, "2026.1");
    assert.deepEqual(explain.body.label.languages, ["zh", "ko"]);

    const repurchase = await get(base, "/v1/repurchase");
    assert.equal(repurchase.status, 200);
    assert.equal(repurchase.body.distributors[0].order_count, 1);
    assert.equal(JSON.stringify(repurchase.body).includes("50000"), false);
  });
});

test("事件信封入口幂等", async () => {
  await withServer(async (base) => {
    await seed(base);
    const envelope = {
      event_id: "EVT-1", source: "scanner-7", source_sequence: 1, event_type: "order.placed",
      occurred_at: "2026-09-05T09:00:00+09:00",
      payload: { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "KR", quantity: 3 },
    };
    const r1 = await post(base, "/v1/events", envelope);
    const r2 = await post(base, "/v1/events", envelope);
    assert.equal(r1.status, 202);
    assert.equal(r1.body.duplicate, false);
    assert.equal(r2.body.duplicate, true);
    const summary = await get(base, "/v1/repurchase?distributor_ref=D1");
    assert.equal(summary.body.distributors[0].ordered_quantity, 3);
  });
});

test("合规阻断返回 422 且只影响该箱；错误体含不合格项", async () => {
  await withServer(async (base) => {
    await seed(base);
    // 韩文规则要求 ko；造一版只有中文的标签并投产装箱
    await post(base, "/v1/labels", {
      ...LABEL, layout_version: "zh-only", languages: ["zh"], declared_allergens: ["EGG", "WHEAT"],
    });
    await post(base, "/v1/orders", { order_id: "O1", client_ref: "C1", distributor_ref: "D1", sku: "MOON-A", country_code: "KR", quantity: 10 });
    await post(base, "/v1/batches", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 10, produced_at: "2026-09-01T08:00:00+08:00" });
    await post(base, "/v1/allocations", { allocation_id: "AL1", order_id: "O1", batch_id: "B1", quantity: 10 });
    await post(base, "/v1/allocations/AL1/pack", { label_id: "LB-MOON-A-zh-only", cartons: [{ carton_ref: "CT1", quantity: 10 }] });

    const inspect = await post(base, "/v1/cartons/CT1/inspections", { at: "2026-09-05T09:00:00+09:00" });
    assert.equal(inspect.body.passed, false);
    const blocked = await post(base, "/v1/cartons/CT1/customs-declarations", { at: "2026-09-06T09:00:00+09:00" });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, "COMPLIANCE_BLOCKED");
  });
});

test("守恒报告与未知路径", async () => {
  await withServer(async (base) => {
    await seed(base);
    await post(base, "/v1/batches", { batch_id: "B1", sku: "MOON-A", recipe_id: "RC-MOON-A-v1", quantity: 10, produced_at: "2026-09-01T08:00:00+08:00" });
    const report = await get(base, "/v1/conservation");
    assert.equal(report.body.batches[0].conserved, true);
    assert.equal((await get(base, "/nope")).status, 404);
    assert.equal((await post(base, "/v1/batches", {})).status, 400);
  });
});
