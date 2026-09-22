import http from "node:http";
import path from "node:path";

import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { createRouter } from "./http.js";

export function healthPayload() {
  return { status: "ok" };
}

export function createServer(database) {
  const app = createApp(database);
  return http.createServer(createRouter(app));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
  const database = openDatabase(databasePath);
  createServer(database).listen(port, "0.0.0.0", () => {
    console.log(`合规批次台已启动：http://0.0.0.0:${port}`);
  });
}
