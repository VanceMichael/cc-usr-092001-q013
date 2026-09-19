import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec("CREATE TABLE IF NOT EXISTS service_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
database.prepare("INSERT OR IGNORE INTO service_meta(key, value) VALUES(?, ?)").run("schema_version", "1");
database.close();
console.log(`数据库初始化完成：${databasePath}`);
