# F12 · 工作流管理

> 版本：v1.0 · 状态：已实现（2026-11-21）
> 维护：04-功能交付档案｜项目：StoryForgeAI —— 专业小说 AI 写作软件
> 类型：功能交付档案分册索引
> 所属：[功能交付档案总索引](../README.md)
>
> 独立的工作流管理模块，完全复刻 agent 管理模块的四层架构与交互风格，承接 Coze 工作流导入与全生命周期管理。

## 一、功能概述

- **归属**：`modules/workflow_management/`，四层结构（types / store / service / routes），与 `modules/agent_management/` 对齐。
- **职责**：工作流的创建、编辑、删除、列表查询、详情查看、启用/禁用状态控制、归档/恢复、版本快照与回滚。
- **导入归属**：Coze 工作流进入本模块的**全局未分类池**（`project_id="_global"`），不绑定小说项目，按 `platform_config.workflow_id` 幂等更新。

## 二、数据模型（Workflow）

| 字段 | 说明 |
|------|------|
| `id` | 工作流唯一 id（uuid） |
| `project_id` | 固定 `_global` |
| `name` / `description` | 名称 / 简介 |
| `status` | `active` / `disabled` / `archived` |
| `platform` | 固定 `coze` |
| `platform_config` | `{workflow_id, workspace_id}`，白名单，不持久化 PAT/token |
| `params` | 参数定义（list） |
| `llm_config` | `{base_url, api_key, model}`，api_key 可选敏感字段 |
| `source` | `manual` / `coze_import` |
| `icon_url` | 图标 |
| `version_no` / `versions` | 版本号 / 快照（上限 `MAX_VERSIONS=50`） |
| `created_at` / `updated_at` / `archived_at` | 时间戳 |

## 三、存储布局

```
data/workflows/
  _global/                       # 全局未分类池
    <workflow_id>.json
  _global/.locks/
    <workflow_id>.lock           # 进程锁
```

## 四、API 路由（Blueprint: `workflow_management`，url_prefix `/api`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/workflows` | 创建工作流 |
| GET | `/workflows` | 列表查询（分页 + `status`/`keyword` 过滤） |
| GET | `/workflows/<wid>` | 详情（`include_versions` 可选） |
| PUT | `/workflows/<wid>` | 更新（白名单 + 版本递增） |
| POST | `/workflows/<wid>/status` | 启用/禁用 |
| POST | `/workflows/<wid>/archive` | 归档 |
| POST | `/workflows/<wid>/restore` | 恢复 |
| DELETE | `/workflows/<wid>` | 删除（`force` 参数；未归档需 force 或先归档） |
| GET | `/workflows/<wid>/versions` | 版本列表 |
| POST | `/workflows/<wid>/versions/<int:no>/rollback` | 回滚到指定版本 |

- 统一响应：`{code:0, data, message}`；错误经 `AppError` 映射为 `{code, data:null, message}`。
- 分页解析：`page=max(1,int(...))`，`page_size=min(100,max(1,int(...)))`，非法抛 400。
- 权限：与 agent 模块一致，不额外 `require_admin`（`/api/admin/*` 由外层治理；`/api/workflows/*` 与 `GET /api/agents` 同权级）。

## 五、Coze 导入改造

- `app.py::import_works()` 的 workflow 分支改为调用 `_workflow_service.import_coze_workflow(wf_info, workspace_id)`，返回键由 `work_id` 改为 `workflow_id`。
- `work_manager.import_workflow` 保留（旧接口 `/api/admin/works/import-workflow` 兼容），仅 `import_works` 不再调用它。
- 前端资源导入面板：勾选 workflow 后，导入结果进入工作流管理 Tab；说明文案改为「智能体将进入 Agent 管理，工作流将进入工作流管理」。

## 六、存量迁移

- 装配时执行 `_bootstrap_workflow_migration()`，调用 `migrate_from_work_manager(work_manager)`。
- 筛选条件：`coze_meta.type=="workflow"` 且含 `coze_workflow_id`（或 `coze_meta.workflow_id`）。
- 幂等：重复执行 migrated=0；try/except 容错，失败仅 `app.logger.warning`。

## 七、前端

- Tab 区新增「工作流管理」按钮（`data-tab="workflows"`）+ `#tab-workflows` 面板 + `#admin-workflows-list`。
- `app.js`：`state.adminWorkflows`、`api.getWorkflows/createWorkflow/updateWorkflow/deleteWorkflow/setWorkflowStatus`、`loadAdminData()` 并行加载、`renderAdminWorkflows()`、`openWorkflowForm/submitWorkflowForm/closeWorkflowForm/deleteWorkflow/toggleWorkflowStatus`、`WORKFLOW_TEXT` 文案集中对象。
- `importSelectedResources()` 兼容读取 `workflow_id || work_id`。
- CSS：`.workflow-status-active` / `.workflow-status-inactive` 徽章。

## 八、测试

| 文件 | 覆盖 |
|------|------|
| `tests/test_workflow_types.py` | 常量集、`default_llm_config`、`validate_platform_config`（丢弃 token）、`validate_llm_config`、`validate_status` |
| `tests/test_workflow_store.py` | create/get、唯一冲突 409、list 过滤、update 白名单+版本递增、set_status、archive/restore/delete、versions+rollback、版本超 50 截断 |
| `tests/test_workflow_service.py` | 首次导入 create、幂等 update、缺 id 400、存量迁移过滤与幂等 |
| `tests/test_app.py` | `test_admin_page_exposes_workflow_pool`、`TestImportWorks.test_workflow_success`、`TestWorkflowApi` |

## 九、相关文件

```
modules/workflow_management/__init__.py
modules/workflow_management/types.py
modules/workflow_management/workflow_store.py
modules/workflow_management/workflow_service.py
modules/workflow_management/routes.py
app.py                          # 装配 + import_works 改造 + _bootstrap_workflow_migration
templates/index.html            # Tab 按钮 + #tab-workflows 面板 + 导入文案
static/js/app.js                # api/state/render/表单/WORKFLOW_TEXT
static/css/style.css            # .workflow-status-* 徽章
tests/test_workflow_types.py
tests/test_workflow_store.py
tests/test_workflow_service.py
```
