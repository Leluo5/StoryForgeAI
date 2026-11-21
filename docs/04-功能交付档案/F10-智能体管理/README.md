# F10 · 智能体管理 · 交付档案

> 所属：[《功能交付档案》总索引](../README.md)｜第 10 篇
> 返回：[文档中心](../../README.md)

## 一、需求要点

1. **作品级 Agent 池**：每个小说项目拥有独立 Agent 集合，支持创建 / 查询 / 更新 / 归档 / 恢复 / 删除 / 版本回滚，文件按项目目录隔离（`data/agents/<project_id>/<agent_id>.json`）。
2. **全局未分类 Agent 池**：Coze Bot 导入到 `data/agents/_global/`，类型为 `unclassified`、作用域为 `global`；不绑定作品、角色、工具或流程步骤，按 `bot_id` 幂等更新。
3. **作品级三类 Agent**：`role_agent`（角色绑定）、`tool_agent`（工具默认执行者）、`flow_step_agent`（11 步流程每步执行者），统一分组树（自动分组 + 覆盖层别名/排序/隐藏 + 手工分组）。
4. **建作品自动开通**：创建作品时幂等生成 11 个流程步骤 Agent 与各工具默认 Agent；新建角色时自动绑定 11 条默认流程绑定（路由与知识库导入两条路径一致），已有自定义绑定不被覆盖。
5. **工具 Agent 切换**：同一工具多候选时保持默认项唯一，切换具备事务性；工具调用解析当前项目默认 Agent 并注入上下文。
6. **每角色流程进度隔离**：`data/flows/<project_id>/<role_id>.json` 独立记录 11 步状态与输出，不同角色并发执行互不串扰；同角色并发触发返回 409。
7. **安全边界**：Agent 文件仅保存 `bot_id`、`workspace_id` 等非敏感配置，API 响应永不返回 PAT Token / API Key。
8. **存量迁移**：`POST /api/agents/migrations/role-bindings` 为存量角色绑定回填 `agent_ref_id`，默认 `dry_run=true`，可幂等重跑。

## 二、设计链接

| 文档 | 说明 |
| --- | --- |
| [智能体管理设计规格](../../superpowers/specs/2026-11-15-agent-management-design.md) | 架构边界、存储布局、数据模型、API 契约、并发隔离、迁移与错误码 |
| [智能体管理实施计划](../../superpowers/plans/2026-11-15-agent-management.md) | Task 1-12 任务拆解与验收 |
| [数据结构设计](../../02-技术与架构/数据结构设计.md) | §3.7 Agent、§3.8 角色流程进度（FlowProgress） |
| [接口契约](../../02-技术与架构/接口契约.md) | §十 智能体管理接口（`/api/agents/*`、角色默认流程与进度） |
| [目录结构](../../02-技术与架构/目录结构.md) | `modules/agent_management/`、`data/agents/`、`data/flows/`、`config/default_flow_agents.json` |

## 三、实现文件清单

| 文件 | 职责 |
| --- | --- |
| `modules/agent_management/types.py` | Agent 数据结构、kind 校验、10 项默认模型参数 |
| `modules/agent_management/agent_store.py` | 按项目目录的 Agent CRUD、版本快照（保留 50 条）、归档/恢复、敏感字段过滤 |
| `modules/agent_management/agent_grouping.py` | 虚拟分组树：角色/工具/11 步自动分组 + 覆盖层 + 手工分组 |
| `modules/agent_management/agent_service.py` | Coze 全局 Agent 幂等导入、作品开通、角色默认绑定、工具默认切换、存量绑定迁移 |
| `modules/agent_management/routes.py` | `/api/agents/*`、`/api/roles/<role_id>/agents/reset-default`、`/api/roles/<role_id>/flow-progress` |
| `modules/novel_creation/flow_progress_store.py` | 每角色 11 步进度存储与执行锁 |
| `modules/novel_creation/role_store.py` | 绑定扩展 `agent_ref_id` + 角色生命周期回调（创建/删除） |
| `modules/novel_creation/role_agent_scheduler.py` | 按 `agent_ref_id` 解析 Agent 配置，归档/未配置时明确报错 |
| `modules/novel_creation/step_flow_engine.py` | `trigger_step` / `trigger_flow` 写入每角色进度 |
| `modules/novel_creation/routes.py` | 建作品/建角色生命周期钩子、工具默认 Agent 注入 |
| `app.py` | 装配智能体管理模块（AgentService / FlowProgressStore / 蓝图注册） |
| `config/default_flow_agents.json` | 11 步流程 Agent 模板 |
| `data/agents/` · `data/flows/` | 运行时数据目录（运行时生成，不入库） |

## 四、核心验收场景与测试命令

### 场景 1：创建作品时自动生成完整 11 步 Agent 链

- 测试：`tests/test_agent_service_defaults.py::test_provision_creates_11_flow_and_tool_agents`、`::test_provision_is_idempotent`
- 命令：`python -m pytest tests/test_agent_service_defaults.py -q`

### 场景 2：新建角色自动关联默认 Agent（含导入路径）

- 测试：`tests/test_role_store_hooks.py::test_create_and_delete_role_trigger_hooks`、`tests/test_agent_integration.py::test_project_and_role_end_to_end_auto_provision`
- 命令：`python -m pytest tests/test_role_store_hooks.py tests/test_agent_integration.py -q`

### 场景 3：单作品多角色并发发起流程调用无数据串扰

- 测试：`tests/test_flow_progress_isolation.py::test_multi_role_concurrent_flow_isolated`（3 角色并发，校验进度 / 步骤输出 / 角色标识隔离）
- 命令：`python -m pytest tests/test_flow_progress_isolation.py -q`

### 场景 4：Coze Bot 导入全局未分类池且重复导入不重复

- 测试：`tests/test_agent_service_defaults.py::test_import_coze_agent_uses_global_pool_and_is_idempotent`、`tests/test_app.py::TestImportWorks::test_bot_success`
- 命令：`python -m pytest tests/test_agent_service_defaults.py::test_import_coze_agent_uses_global_pool_and_is_idempotent tests/test_app.py::TestImportWorks -q`

### 全量 CI

```bash
python scripts/run_checks.py --path .
python -m compileall -q .
python -m pytest -q
```

---

*本文档为 F10 智能体管理功能交付档案，随功能变更同步更新。*
