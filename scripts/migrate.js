import path from "node:path";

import { openDatabase, SCHEMA_VERSION } from "../src/db.js";

const databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
const database = openDatabase(databasePath);
database.close();
console.log(`数据库初始化完成（schema v${SCHEMA_VERSION}）：${databasePath}`);
