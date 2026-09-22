# 月饼跨境合规批次台

管理黄庄月饼出口过程中的产品配方版本、过敏原与营养声明、多语言包装版式、目的国规则与生效日期，
并跟踪生产批次的拆分、合并、逐件检验、装柜、离港、到港与售罄回执。核心约束：

- 标签必须与该批次所用配方版本一致，传统中文标识必须保留，同时满足目的国语言/配料/包装规范；
- 任何不合格项只阻断对应目的地的货物；
- 数量全程守恒，重复扫描与经销商重传不增加货量；
- 规则临时更新时，已离港货物冻结、待报关货物重评、未生产货物适用新版；
- 召回可精确找到受影响市场与剩余包装；
- 每箱都能解释为何获准出口、采用哪种语言标签和哪版规则；
- 复购汇总不泄露经销商合同价格。

技术栈：Node.js 22 内置 `node:sqlite` 与 `node:http`，无第三方运行时依赖。

## 运行

```bash
make test      # 运行全部测试
make migrate   # 初始化本地数据库（data/app.sqlite3）
make run       # 启动服务，默认 :8080，健康检查 GET /health
```

配置通过环境变量传入：`PORT`、`DATABASE_PATH`。本地数据库文件不提交（已在 `.gitignore`）。

## 典型流程

```bash
# 1. 主数据：产品 → 配方版本 → 目的国规则 → 标签版式
POST /v1/products     {"sku":"MOON-A","name_cn":"黄庄双黄莲蓉月饼"}
POST /v1/recipes      {"sku":"MOON-A","version":"v1","effective_from":"…",
                       "ingredients":[…],"allergens":["EGG","WHEAT"],
                       "nutrition":{"energy_kj":1700,"sugar_g":35,"fat_g":20}}
POST /v1/rules        {"country_code":"AU","version":"2026.1","effective_from":"…",
                       "languages_required":["en"],"allergen_required":["EGG","WHEAT","PEANUT"], …}
POST /v1/labels       {"sku":"MOON-A","recipe_id":"RC-MOON-A-v1","layout_version":"au-v1",
                       "languages":["zh","en"],"declared_allergens":[…], …}

# 2. 订单（合同价仅写入，不出现在任何读取结果）与生产
POST /v1/orders       {"order_id":"O-1","distributor_ref":"D-SYD","client_ref":"C-AU-1",
                       "sku":"MOON-A","country_code":"AU","quantity":100,
                       "contract_price":{"amount_minor":288000,"currency":"AUD"}}
POST /v1/batches      {"batch_id":"B-001","sku":"MOON-A","recipe_id":"RC-MOON-A-v1", …}

# 3. 同一批次拆给不同经销商，再分配、逐件装箱
POST /v1/batches/B-001/splits     {"child_batch_id":"B-001-A","quantity":100}
POST /v1/allocations              {"allocation_id":"AL-1","order_id":"O-1", …}
POST /v1/allocations/AL-1/pack    {"label_id":"LB-MOON-A-au-v1",
                                   "cartons":[{"carton_ref":"CT-1","quantity":60}, …]}

# 4. 逐件合规检验（不通过只扣留本箱）；返工可重贴后复验
POST /v1/cartons/CT-1/inspections          {"at":"2026-09-05T09:00:00+10:00"}
POST /v1/cartons/CT-1/relabel              {"label_id":"LB-MOON-A-au-v2"}
POST /v1/cartons/CT-1/inspections          {"at":"…"}

# 5. 报关 → 装柜 → 离港（锁定规则版本）→ 到港 → 售罄回执
POST /v1/cartons/CT-1/customs-declarations
POST /v1/container-loads        {"container_ref":"CONT-1","carton_refs":["CT-1"]}
POST /v1/containers/CONT-1/departures
POST /v1/containers/CONT-1/arrivals
POST /v1/cartons/CT-1/sell-out-receipts

# 6. 规则临时更新（已离港冻结 / 待报关重评 / 未生产不处理）
POST /v1/rules        {"country_code":"AU","version":"2026.2", …}
POST /v1/rule-updates {"country_code":"AU","at":"2026-09-11T00:00:00+10:00"}

# 7. 召回、出口解释、复购汇总
POST /v1/recalls              {"scope":"RECIPE","subject_id":"RC-MOON-A-v1"}
GET  /v1/cartons/CT-1/explain
GET  /v1/repurchase
GET  /v1/conservation
```

### 事件信封入口

外部扫描器/经销商系统也可走统一信封 `POST /v1/events`（字段见 `contracts/event.example.json`）：
`event_id` 重放幂等；`(source, source_sequence)` 冲突拒绝；`occurred_at` 原样保留。
命令式端点的请求体若自带 `event_id/source/source_sequence` 字段，同样按信封幂等处理。

### 错误约定

错误响应为 `{"error":{"code","message","details"}}`：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | VALIDATION_FAILED | 字段不合法 |
| 404 | NOT_FOUND | 引用对象不存在 |
| 409 | CONFLICT / INVALID_TRANSITION | 唯一键冲突、状态不能推进 |
| 422 | QUANTITY_CONSERVATION_VIOLATED | 数量守恒被破坏 |
| 422 | COMPLIANCE_BLOCKED | 合规未通过，仅阻断对应目的地货物 |

## 目录

- `src/db.js`：SQLite schema 与迁移、保存点助手。
- `src/masterdata.js`：产品、配方版本、标签版式、目的国规则与生效日期解析。
- `src/batches.js`：订单、生产批次、拆分/合并守恒、分配、装箱。
- `src/compliance.js`：逐件合规核验（纯规则比对）与决策落库。
- `src/logistics.js`：检验/复验/返工重贴、报关装柜离港到港售罄、规则更新分流。
- `src/traceability.js`：召回、单箱出口解释、复购汇总、守恒报告。
- `src/events.js`：交换事件信封、幂等与原始时间保留。
- `src/app.js` / `src/http.js` / `src/server.js`：应用门面、HTTP 路由与服务入口。
- `test/`：基于 `node:test` 的领域与 HTTP 端到端测试。
- `docs/domain.md`：领域对象、状态机与不变量说明。
- `contracts/`：外部交换字段示例。
