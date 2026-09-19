import assert from "node:assert/strict";
import test from "node:test";

import { healthPayload } from "../src/server.js";

test("健康检查返回服务状态", () => {
  assert.deepEqual(healthPayload(), { status: "ok" });
});
