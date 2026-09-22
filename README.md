# 月饼跨境合规批次台

本项目用于管理出口产品、标签版本与物流批次中的稳定事实和交换边界。仓库提供基础服务、数据库初始化入口、领域说明和一份脱敏示例，便于不同参与方在一致约定下协作。

## 目录

- `contracts/` 保存外部交换字段示例。
- `docs/` 说明领域对象、不变量、时间和标识约定。
- `src/` 保存服务代码：`schema.js`（表结构）、`store.js`（领域逻辑）、`server.js`（HTTP API）。
- `test/` 保存基础行为检查。

## 运行

执行 `make test` 检查基础行为，执行 `make migrate` 初始化本地数据目录，执行 `make run` 启动服务。默认监听 `8080` 端口，健康检查地址为 `/health`。

配置通过环境变量传入（`PORT`、`DATABASE_PATH`），敏感值和本地数据库文件不得提交到仓库。

## API 摘要

所有写接口接受可选 `event_id` 用于幂等重放；时间字段为带偏移量的 ISO 8601。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/recipe-versions` | 登记配方版本（配料、过敏原、营养声明） |
| POST | `/v1/label-layouts` | 登记标签版式（语言、绑定配方、图稿摘要） |
| POST | `/v1/market-rules` | 登记目的国规则版本；自动衔接生效链并按货物环节复评 |
| GET | `/v1/market-rules?market=AU` | 查询规则版本链 |
| POST | `/v1/batches` | 建立生产批次 |
| GET | `/v1/batches/:id` | 批次总览（含数量守恒核对） |
| POST | `/v1/batches/:id/produce` | 生产入库，生成货位 |
| POST | `/v1/lots/:id/split` | 拆分货位（数量必须守恒） |
| POST | `/v1/lots/merge` | 合并同配方货位（保留血缘） |
| POST | `/v1/lots/:id/inspect` | 货位检验 |
| POST | `/v1/cases/scan` | 装箱扫描：逐件校验标签与批次配方、目的国规则一致 |
| GET | `/v1/cases/:ref/explanation` | 解释一箱为何获准出口（规则版本、标签语言、检查留痕） |
| POST | `/v1/shipments` | 建立柜次 |
| POST | `/v1/shipments/:id/load` `/unload` | 装柜 / 卸箱 |
| POST | `/v1/shipments/:id/submit-customs` | 转待报关 |
| POST | `/v1/shipments/:id/depart` `/arrive` | 离港（记录核准规则版本）/ 到港 |
| POST | `/v1/receipts` | 售罄回执（回执号唯一，重传不增量） |
| POST | `/v1/recalls` | 发起召回（按批次或配方版本） |
| GET | `/v1/recalls/:id` | 召回影响面：分市场的剩余包装与经销商引用 |
| GET | `/v1/destination-blocks` | 查询目的地阻断 |
| POST | `/v1/destination-blocks/:id/lift` | 解除阻断（须登记原因） |
| GET | `/v1/reports/repurchase` | 复购汇总（仅聚合，不含价格与经销商明细） |
