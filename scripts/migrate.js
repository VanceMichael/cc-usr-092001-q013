import fs from "node:fs";
import path from "node:path";

import { openDatabase } from "../src/schema.js";

const databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = openDatabase(databasePath);
const row = database.prepare("SELECT value FROM service_meta WHERE key = 'schema_version'").get();
database.close();
console.log(`数据库初始化完成：${databasePath}（schema_version=${row.value}）`);
