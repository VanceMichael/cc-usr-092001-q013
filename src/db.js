import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "2";

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS service_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY,
    name_cn TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recipe_versions (
    recipe_id TEXT PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    version TEXT NOT NULL,
    ingredients TEXT NOT NULL,
    allergens TEXT NOT NULL,
    nutrition TEXT NOT NULL,
    formula_digest TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL,
    UNIQUE(sku, version)
  );

  CREATE TABLE IF NOT EXISTS label_layouts (
    label_id TEXT PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    recipe_id TEXT NOT NULL REFERENCES recipe_versions(recipe_id),
    layout_version TEXT NOT NULL,
    languages TEXT NOT NULL,
    declared_allergens TEXT NOT NULL,
    declared_nutrition TEXT NOT NULL,
    nutrition_format TEXT NOT NULL DEFAULT 'PER_100G_TABLE',
    claims TEXT NOT NULL,
    packaging_spec TEXT NOT NULL,
    label_digest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL,
    UNIQUE(sku, layout_version)
  );

  CREATE TABLE IF NOT EXISTS destination_rules (
    rule_id TEXT PRIMARY KEY,
    country_code TEXT NOT NULL,
    version TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    require_chinese_presence INTEGER NOT NULL DEFAULT 1,
    languages_required TEXT NOT NULL,
    allergen_required TEXT NOT NULL,
    nutrition_format TEXT NOT NULL,
    required_nutrients TEXT NOT NULL,
    nutrition_tolerance REAL NOT NULL DEFAULT 0.2,
    prohibited_claims TEXT NOT NULL,
    packaging_requirements TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'EFFECTIVE',
    created_at TEXT NOT NULL,
    UNIQUE(country_code, version)
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    subject_ref TEXT,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT,
    UNIQUE(source, source_sequence)
  );

  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    client_ref TEXT NOT NULL,
    distributor_ref TEXT NOT NULL,
    sku TEXT NOT NULL REFERENCES products(sku),
    country_code TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    fulfilled_qty INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    created_at TEXT NOT NULL,
    UNIQUE(distributor_ref, client_ref)
  );

  CREATE TABLE IF NOT EXISTS order_contract_prices (
    order_id TEXT PRIMARY KEY REFERENCES orders(order_id),
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS production_batches (
    batch_id TEXT PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    recipe_id TEXT NOT NULL REFERENCES recipe_versions(recipe_id),
    initial_qty INTEGER NOT NULL CHECK(initial_qty >= 0),
    current_qty INTEGER NOT NULL CHECK(current_qty >= 0),
    status TEXT NOT NULL DEFAULT 'PRODUCED',
    produced_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS batch_lineage (
    lineage_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('SPLIT','MERGE')),
    parent_batch_id TEXT NOT NULL REFERENCES production_batches(batch_id),
    child_batch_id TEXT NOT NULL REFERENCES production_batches(batch_id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    event_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS allocations (
    allocation_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(order_id),
    batch_id TEXT NOT NULL REFERENCES production_batches(batch_id),
    distributor_ref TEXT NOT NULL,
    sku TEXT NOT NULL,
    country_code TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    packed_qty INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cartons (
    carton_ref TEXT PRIMARY KEY,
    allocation_id TEXT NOT NULL REFERENCES allocations(allocation_id),
    batch_id TEXT NOT NULL REFERENCES production_batches(batch_id),
    sku TEXT NOT NULL,
    country_code TEXT NOT NULL,
    label_id TEXT NOT NULL REFERENCES label_layouts(label_id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    status TEXT NOT NULL DEFAULT 'PACKED',
    held INTEGER NOT NULL DEFAULT 0,
    held_findings TEXT,
    container_ref TEXT,
    rule_id_at_departure TEXT,
    packed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS carton_events (
    carton_event_id TEXT PRIMARY KEY,
    carton_ref TEXT NOT NULL REFERENCES cartons(carton_ref),
    action TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    event_id TEXT,
    occurred_at TEXT NOT NULL,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS compliance_decisions (
    decision_id TEXT PRIMARY KEY,
    carton_ref TEXT NOT NULL REFERENCES cartons(carton_ref),
    rule_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    formula_digest TEXT NOT NULL,
    label_digest TEXT NOT NULL,
    passed INTEGER NOT NULL,
    findings TEXT NOT NULL,
    trigger TEXT NOT NULL,
    decided_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recalls (
    recall_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('RECIPE','LABEL','BATCH')),
    subject_id TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recall_findings (
    finding_id TEXT PRIMARY KEY,
    recall_id TEXT NOT NULL REFERENCES recalls(recall_id),
    country_code TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    allocation_id TEXT NOT NULL,
    carton_ref TEXT NOT NULL,
    label_id TEXT NOT NULL,
    carton_status TEXT NOT NULL,
    remaining INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recipe_sku ON recipe_versions(sku);
  CREATE INDEX IF NOT EXISTS idx_rules_country ON destination_rules(country_code, effective_from);
  CREATE INDEX IF NOT EXISTS idx_orders_distributor ON orders(distributor_ref);
  CREATE INDEX IF NOT EXISTS idx_allocations_batch ON allocations(batch_id);
  CREATE INDEX IF NOT EXISTS idx_allocations_order ON allocations(order_id);
  CREATE INDEX IF NOT EXISTS idx_cartons_allocation ON cartons(allocation_id);
  CREATE INDEX IF NOT EXISTS idx_cartons_batch ON cartons(batch_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_carton ON compliance_decisions(carton_ref, decided_at);
  CREATE INDEX IF NOT EXISTS idx_lineage_parent ON batch_lineage(parent_batch_id);
  CREATE INDEX IF NOT EXISTS idx_lineage_child ON batch_lineage(child_batch_id);
  CREATE INDEX IF NOT EXISTS idx_findings_recall ON recall_findings(recall_id);
  `,
];

export function openDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

export function migrate(database) {
  database.exec(MIGRATIONS[0]);
  database
    .prepare("INSERT OR IGNORE INTO service_meta(key, value) VALUES(?, ?)")
    .run("schema_version", SCHEMA_VERSION);
}

export function openMemoryDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  return database;
}

/** 在保存点内执行：无论调用方是否已持有事务都安全；出错回滚到保存点并抛出。 */
export function runInSavepoint(database, name, fn) {
  database.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    database.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    database.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
