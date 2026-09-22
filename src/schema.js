// 数据库结构定义。所有写路径（服务、迁移脚本、测试）共用同一份 DDL，
// 保证本地文件库与内存库结构一致。
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "2";

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS service_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 配方版本：同一产品的配方不可变快照，标签与合规校验都引用它。
CREATE TABLE IF NOT EXISTS recipe_versions (
  id TEXT PRIMARY KEY,
  product_ref TEXT NOT NULL,
  version TEXT NOT NULL,
  ingredients TEXT NOT NULL,        -- JSON 数组，配料受控词
  allergens TEXT NOT NULL,          -- JSON 数组，过敏原受控词
  nutrition_claims TEXT NOT NULL,   -- JSON 数组，营养声明
  created_at TEXT NOT NULL,
  UNIQUE (product_ref, version)
);

-- 包装/标签版式：某一语言、绑定某一配方版本的版面。
CREATE TABLE IF NOT EXISTS label_layouts (
  id TEXT PRIMARY KEY,
  product_ref TEXT NOT NULL,
  language TEXT NOT NULL,
  layout_version TEXT NOT NULL,
  recipe_version_id TEXT NOT NULL REFERENCES recipe_versions(id),
  allergens_declared TEXT NOT NULL, -- JSON 数组，版面上实际标注的过敏原
  nutrition_claims TEXT NOT NULL,   -- JSON 数组，版面上实际标注的营养声明
  artwork_digest TEXT NOT NULL,     -- sha256:... 受控引用
  effective_from TEXT NOT NULL
);

-- 目的国规则：按生效时间衔接的版本链。
CREATE TABLE IF NOT EXISTS market_rules (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,             -- 目的国/市场代码，如 AU、KR
  rule_version TEXT NOT NULL,
  required_languages TEXT NOT NULL,   -- JSON 数组，可接受的标签语言
  banned_ingredients TEXT NOT NULL,   -- JSON 数组，禁用配料
  required_allergens TEXT NOT NULL,   -- JSON 数组，必须标注的过敏原
  packaging_requirements TEXT NOT NULL, -- JSON 对象，包装规范要点
  effective_from TEXT NOT NULL,
  effective_to TEXT,                  -- 被后继版本接替时回填
  created_at TEXT NOT NULL,
  UNIQUE (market, rule_version)
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  product_ref TEXT NOT NULL,
  recipe_version_id TEXT NOT NULL REFERENCES recipe_versions(id),
  planned_qty INTEGER NOT NULL CHECK (planned_qty > 0),
  produced_qty INTEGER NOT NULL DEFAULT 0 CHECK (produced_qty >= 0),
  status TEXT NOT NULL DEFAULT 'planned', -- planned / in_production / completed / review
  note TEXT,
  created_at TEXT NOT NULL
);

-- 货位（lot）：数量守恒的基本容器。拆分/合并通过消耗父 lot、
-- 生成子 lot 完成，lot_links 记录血缘，召回与解释沿血缘追溯。
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES batches(id),  -- 合并产生的 lot 为 NULL，血缘见 lot_links
  recipe_version_id TEXT NOT NULL REFERENCES recipe_versions(id),
  qty INTEGER NOT NULL CHECK (qty >= 0),
  remaining_qty INTEGER NOT NULL CHECK (remaining_qty >= 0),
  stage TEXT NOT NULL,              -- produced / inspected / failed
  consumed_by TEXT,                 -- 消耗本 lot 的操作（split:<id> / merge:<id>）
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lot_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_lot_id TEXT NOT NULL REFERENCES lots(id),
  child_lot_id TEXT NOT NULL REFERENCES lots(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  kind TEXT NOT NULL                -- split / merge
);

-- 箱：装箱扫描时建立的可追踪最小单位。
CREATE TABLE IF NOT EXISTS cases (
  ref TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES lots(id),
  product_ref TEXT NOT NULL,
  recipe_version_id TEXT NOT NULL REFERENCES recipe_versions(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  market TEXT NOT NULL,
  dealer_ref TEXT NOT NULL,         -- 经销商稳定引用编号，不含合同信息
  label_layout_id TEXT NOT NULL REFERENCES label_layouts(id),
  cleared_rule_id TEXT REFERENCES market_rules(id), -- 装箱时核准所依据的规则版本
  status TEXT NOT NULL DEFAULT 'packed', -- packed / held / loaded / departed / arrived / sold / recalled
  hold_reason TEXT,
  shipment_id TEXT REFERENCES shipments(id),
  packed_at TEXT NOT NULL
);

-- 合规检查留痕：每次扫描与每次规则更新复评都记录结论与依据。
CREATE TABLE IF NOT EXISTS compliance_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_ref TEXT,
  lot_id TEXT,
  market TEXT NOT NULL,
  rule_id TEXT REFERENCES market_rules(id),
  label_layout_id TEXT,
  result TEXT NOT NULL,             -- pass / fail
  failures TEXT NOT NULL,           -- JSON 数组，机器可读的不合格项代码
  trigger TEXT NOT NULL,            -- pack_scan / rule_update
  checked_at TEXT NOT NULL
);

-- 目的地级阻断：只阻断 (市场, 配方[, 批次]) 维度上的货物。
CREATE TABLE IF NOT EXISTS destination_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  recipe_version_id TEXT NOT NULL,
  batch_id TEXT,                    -- 为空表示该配方发往该市场的全部货物
  reason TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  lifted_at TEXT,
  lift_reason TEXT
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'loading', -- loading / pending_customs / departed / arrived
  cleared_rule_id TEXT REFERENCES market_rules(id), -- 离港时核准所依据的规则版本
  created_at TEXT NOT NULL,
  departed_at TEXT,
  arrived_at TEXT
);

-- 售罄/销售回执：ref 唯一，经销商重传不产生新记录。
CREATE TABLE IF NOT EXISTS receipts (
  ref TEXT PRIMARY KEY,
  case_ref TEXT NOT NULL REFERENCES cases(ref),
  dealer_ref TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recalls (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,         -- batch / recipe_version
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recall_items (
  recall_id TEXT NOT NULL REFERENCES recalls(id),
  case_ref TEXT NOT NULL REFERENCES cases(ref),
  market TEXT NOT NULL,
  status_at_recall TEXT NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (recall_id, case_ref)
);

-- 规则临时更新时对已离港货物的告知留痕（不追溯其既有核准）。
CREATE TABLE IF NOT EXISTS rule_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  rule_id TEXT NOT NULL REFERENCES market_rules(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 事件幂等：同一 event_id 只处理一次，重放返回首次结果。
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  response TEXT NOT NULL,           -- JSON，首次处理结果
  processed_at TEXT NOT NULL
);
`;

export function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(SCHEMA_SQL);
  database
    .prepare("INSERT OR IGNORE INTO service_meta(key, value) VALUES(?, ?)")
    .run("schema_version", SCHEMA_VERSION);
  return database;
}
