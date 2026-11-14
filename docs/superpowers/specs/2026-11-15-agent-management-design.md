# 智能体管理模块设计（Agent Management）

> 版本：v1.0 · 状态：待评审（2026-11-15）
> 项目：StoryForgeAI
> 类型：设计规格（Spec）
> 关联：[数据结构设计](../../02-技术与架构/数据结构设计.md)、[接口契约](../../02-技术与架构/接口契约.md)、[目录结构](../../02-技术与架构/目录结构.md)
> 范围：新增与 `novel_creation`、`knowledge_base` 同级的 `agent_management` 模块，并扩展作品级默认 11 步流程 Agent 与多角色并发隔离能力。

---

## 一、背景与目标

### 1.1 背景

当前项目存在三类 Agent 形态，但缺少统一管理入口：

- 角色 Agent：`RoleStore.create_binding` 仅保存 `agent_id` 字符串，模型/平台等配置散落在绑定字段中；
- 小说工具 Agent：工具注册表（`ToolRegistry`）只有工具元数据，没有对应的 Agent 配置；
- 作品级流程 Agent：不存在，11 步流程依赖每个角色各自绑定 Agent，新角色需要手工配置。

### 1.2 目标

1. 新增 `modules/agent_management` 模块，统一管理 `role_agent`、`tool_agent`、`flow_step_agent` 三类 Agent 的配置持久化与全生命周期。
2. 每个 Agent 独立文件存储：`data/agents/<project_id>/<agent_id>.json`。
3. 支持多级虚拟分组与自动分组规则，并提供别名/排序/隐藏/手工分组的覆盖层。
4. 创建作品时自动实例化 11 个作品级流程 Agent（`flow_step_agent`）与 11 个工具 Agent（`tool_agent`）。
5. 作品内新建角色自动绑定该作品级 11 步流程 Agent，无需手工配置，且允许后续覆盖与恢复。
6. 多角色并发调用同一套作品级 Agent 时，上下文、记忆、进度完全隔离。
7. 提供存量角色绑定迁移能力，兼容现有作品管理与角色管理链路。

### 1.3 非目标

- 不提供前端管理界面（本期仅后端模块 + 测试）。
- 不实现 Trae 真实调用通道（沿用现有 `TraeAgentClient` 桩）。
- 不改变 11 步流程定义与现有工具处理器的业务逻辑。
- 不引入数据库，继续使用 JSON 文件 + 文件锁 + 原子写。

---

## 二、术语

| 术语 | 含义 |
| --- | --- |
| 作品 | 小说项目 `Project`，主键 `project_id`（`data/projects/<project_id>.json`） |
| 作品级流程 Agent | `kind=flow_step_agent`，每个作品 11 个，对应 11 步流程 |
| 工具 Agent | `kind=tool_agent`，每个作品每个工具至少 1 个候选，含默认项 |
| 角色 Agent | `kind=role_agent`，角色自定义或迁移生成的 Agent |
| 覆盖层 | `_groups.json`，保存分组别名、排序、隐藏与手工分组 |
| 默认绑定 | 新建角色自动生成的 11 条 `RoleAgentBinding`，指向作品级流程 Agent |

---

## 三、架构与模块边界

### 3.1 新增/调整文件

```text
modules/agent_management/            # 新增，与 knowledge_base / novel_creation 同级
├── __init__.py
├── types.py            # 枚举、默认值、字段校验
├── agent_store.py      # 单 Agent 文件 CRUD、版本快照、_groups.json 读写
├── agent_grouping.py   # 虚拟分组树 + 自动规则 + 覆盖层合并
├── agent_service.py    # 生命周期编排、默认 Agent 开通、角色默认绑定、迁移
└── routes.py           # create_blueprint(service, ...) → /api/agents/*

modules/novel_creation/
├── flow_progress_store.py   # 新增：data/flows/<project_id>/<role_id>.json
├── step_flow_engine.py      # 调整：记录/恢复每角色进度
├── role_store.py            # 调整：绑定新增 agent_ref_id；角色生命周期回调
└── role_agent_scheduler.py  # 调整：按 agent_ref_id 解析 Agent 配置

config/default_flow_agents.json    # 新增：11 步流程 Agent 全局模板
```

### 3.2 依赖方向

- `agent_management` 只依赖 `modules/common/*`，不 import `novel_creation` / `knowledge_base`。
- 通过构造参数注入鸭子类型依赖：
  - `project_store`：读取项目标题、`find_project_by_role`；
  - `role_store`：校验角色、读写绑定；
  - `tool_registry`：工具白名单；
  - `flow_template`：11 步模板（由应用层从 `config/default_flow_agents.json` 加载）。
- `novel_creation` 不直接 import `agent_management`：
  - 角色创建/删除通过 `role_store` 生命周期回调通知；
  - 调度器通过注入的 `agent_resolver(project_id, agent_ref_id)` 解析配置。
- `app.py` 负责全部装配与蓝图注册。

### 3.3 应用装配

```python
# 伪代码，落在 app.py 模块级装配区
_agent_store = AgentStore(os.path.join(DATA_DIR, "agents"))
_agent_service = AgentService(
    _agent_store, _project_store, _role_store, _tool_registry,
    flow_template=load_flow_template(),
)
_flow_progress = FlowProgressStore(os.path.join(DATA_DIR, "flows"))

_role_store.set_lifecycle_hooks(
    on_create=_agent_service.bind_role_default_flow,
    on_delete=_flow_progress.delete_role,
)
_role_scheduler.set_agent_resolver(_agent_service.get_agent)
_step_flow_engine.set_progress_store(_flow_progress)

app.register_blueprint(create_agent_blueprint(_agent_service))
```

创建作品成功后调用 `_agent_service.provision_project_defaults(project)`；失败仅记录日志，不阻断建项目。

---

## 四、存储布局

```text
data/agents/<project_id>/
├── <agent_id>.json              # 单个 Agent（含版本快照）
├── _groups.json                 # 分组覆盖层
└── .locks/
    ├── <agent_id>.lock
    └── _groups.lock

data/flows/<project_id>/
├── <role_id>.json               # 每角色 11 步进度与中间状态
└── .locks/<role_id>.lock

config/default_flow_agents.json  # 11 步流程 Agent 全局模板
```

- 所有写入复用 `modules/common/storage.py` 的 `FileLock` + `atomic_write_json`。
- 读取复用 `read_json`（原子写保证读到完整文件）。

---

## 五、数据模型

### 5.1 Agent 实体

文件：`data/agents/<project_id>/<agent_id>.json`

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | UUID | Agent ID |
| `project_id` | string | 是 | — | 所属小说项目 |
| `kind` | string | 是 | — | `role_agent` / `tool_agent` / `flow_step_agent` |
| `name` | string | 是 | — | 名称 |
| `description` | string | 否 | `""` | 描述 |
| `role_id` | string/null | 条件 | null | `role_agent` 必填 |
| `tool_name` | string/null | 条件 | null | `tool_agent` 必填，须在 ToolRegistry 白名单 |
| `step_order` | number/null | 条件 | null | `flow_step_agent` 必填，1-11 |
| `scope` | string | 是 | `project` | `project` / `role` |
| `platform` | string | 是 | `coze` | `coze` / `trae` |
| `platform_config` | object | 是 | `{}` | 仅非敏感 ID |
| `credential_source` | string | 是 | `global` | 固定引用全局凭据，不存 token |
| `model_config` | object | 是 | 见 5.3 | 10 项调用参数 |
| `status` | string | 是 | `active` | `active` / `disabled` / `archived` |
| `is_default` | boolean | 否 | `false` | 仅 `tool_agent` 有意义 |
| `source` | string | 是 | `manual` | `manual` / `auto` / `template` |
| `tags` | array | 否 | `[]` | 标签 |
| `manual_group_key` | string/null | 否 | null | 手工分组覆盖自动分组 |
| `version_no` | number | 是 | 1 | 当前版本号 |
| `versions` | array | 是 | `[]` | 版本快照，保留最近 50 条 |
| `created_at` / `updated_at` | string | 是 | 当前时间 | ISO 8601 |
| `archived_at` | string/null | 否 | null | 归档时间 |

**kind 与归属校验**

| kind | 必填 | 禁止 | scope 默认 |
| --- | --- | --- | --- |
| `role_agent` | `role_id` | `tool_name`、`step_order` | `role` |
| `tool_agent` | `tool_name` | `role_id`、`step_order` | `project` |
| `flow_step_agent` | `step_order` | `role_id`、`tool_name` | `project` |

### 5.2 平台配置（`platform_config`）

| platform | 字段 | 必填 | 说明 |
| --- | --- | --- | --- |
| `coze` | `bot_id` | 否（允许空占位） | Coze Bot ID |
| `coze` | `workspace_id` | 否 | 工作空间 ID |
| `trae` | `agent_id` | 否（允许空占位） | Trae Agent 标识 |
| `trae` | `endpoint` | 否 | 预留调用地址 |

- 不存储 PAT Token / API Key；调用时按以下顺序解析，API 响应永不返回凭据：
  1. `global_config.agent_credentials.coze_pat_token`（管理端配置，返回时脱敏）；
  2. 环境变量 `COZE_PAT_TOKEN`；
  3. 均不存在 → `400 未配置全局 Coze PAT Token`。
- 空 `bot_id` 视为「未配置」，调用时返回明确错误，不做静默跳过。

### 5.3 模型参数（`model_config`，10 项）

| 字段 | 类型 | 默认 | 校验 |
| --- | --- | --- | --- |
| `model` | string | `""` | 空表示跟随全局默认 |
| `temperature` | number | `0.7` | 0 ~ 2 |
| `top_p` | number | `1.0` | 0 ~ 1 |
| `max_tokens` | number | `2048` | 1 ~ 32768 整数 |
| `system_prompt` | string | `""` | — |
| `stream` | boolean | `false` | — |
| `frequency_penalty` | number | `0` | -2 ~ 2 |
| `presence_penalty` | number | `0` | -2 ~ 2 |
| `response_format` | string | `text` | `text` / `json` / `markdown` |
| `stop` | array | `[]` | 最多 4 项，每项 ≤ 64 字符 |

### 5.4 版本快照

```json
{
  "version_no": 2,
  "change_type": "create|update|archive|restore|rollback",
  "note": "",
  "created_at": "2026-11-15T10:00:00",
  "snapshot": { "Agent 全量配置，不含 versions" }
}
```

- 创建时写入 `version_no=1` 的 `create` 快照。
- 更新/归档/恢复/回滚各写一条快照。
- 超过 50 条删除最旧快照。
- 列表与详情默认不返回 `versions`；`include_versions=true` 才返回。

### 5.5 分组覆盖层

文件：`data/agents/<project_id>/_groups.json`

```json
{
  "project_id": "...",
  "schema_version": 1,
  "overrides": [
    { "key": "project:<id>", "name": "别名", "sort_order": 0, "hidden": false },
    { "key": "role:<id>", "name": "别名", "sort_order": 1, "hidden": false }
  ],
  "manual_groups": [
    { "id": "manual:<uuid>", "parent_key": "project:<id>", "name": "自定义分组", "sort_order": 9 }
  ],
  "updated_at": "..."
}
```

### 5.6 角色绑定扩展

`RoleAgentBinding` 新增字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `agent_ref_id` | string/null | 指向 Agent 实体；为空时走旧逻辑 |
| `agent_id` | string | 兼容字段：`platform_config.bot_id`，为空则回落 `agent_ref_id`，保证会话 key 非空 |

### 5.7 角色流程进度

文件：`data/flows/<project_id>/<role_id>.json`

```json
{
  "project_id": "...",
  "role_id": "...",
  "run_id": "uuid",
  "status": "idle|running|done|failed",
  "current_step": 3,
  "completed_steps": [1, 2, 3],
  "steps": [
    {
      "step_order": 1,
      "status": "done",
      "output": {},
      "started_at": "...",
      "finished_at": "...",
      "error": ""
    }
  ],
  "context": {},
  "started_at": "...",
  "updated_at": "...",
  "last_error": ""
}
```

### 5.8 11 步模板

文件：`config/default_flow_agents.json`

```json
{
  "version": 1,
  "steps": [
    {
      "step_order": 1,
      "name": "外貌特征",
      "desc": "角色外观设定",
      "platform": "coze",
      "platform_config": { "bot_id": "", "workspace_id": "" },
      "model_config": { "model": "", "temperature": 0.7, "top_p": 1.0, "max_tokens": 2048 }
    }
  ]
}
```

- 必须包含 1-11 完整步骤，`step_order` 唯一且连续（上例仅展示第 1 步结构）。
- 缺失文件时回退到 `DEFAULT_STEPS` + 空平台配置（占位）。
- 模板中的 `bot_id` 为空表示占位，调用时返回「未配置」错误。

---

## 六、分组规则

### 6.1 虚拟分组树

```text
全部
└── 作品：<project.title>                     key=project:<project_id>
    ├── 默认11步流程                          key=flow_group
    │   └── 第1步…第11步                     按 step_order 排序
    ├── 角色：<role.name>                     key=role:<project_id>:<role_id>
    │   └── 该角色 role_agent
    ├── 小说工具                              key=tool_group
    │   ├── <tool_name>                       key=tool:<project_id>:<tool_name>
    │   │   └── 候选 tool_agent（默认项标记）
    │   └── …其余工具
    └── 自定义分组（manual_groups）
```

### 6.2 自动规则

1. `role_agent` → `role:<project_id>:<role_id>` 分组；同角色多个 Agent 自动汇总。
2. `flow_step_agent` → `flow_group` 分组，按 `step_order` 排序。
3. `tool_agent` → 先归入 `tool_group`，再按 `tool_name` 归入工具子分组。
4. 所有分组最终挂在 `project:<project_id>` 下。

### 6.3 覆盖层优先级

1. `manual_group_key` 非空 → 使用手工分组（不参与自动规则）。
2. 否则按自动规则归组。
3. 覆盖层 `name` / `sort_order` / `hidden` 作用于任意节点（含项目、角色、工具、流程组）。
4. 覆盖层不存在时使用默认名称与自然排序。

---

## 七、生命周期与状态机

```text
active ⇄ disabled
   │         │
   └→ archived ←┘
        │
        └→ restore → active
        └→ delete（硬删，需已归档或 force=true）
```

| 操作 | 规则 |
| --- | --- |
| 创建 | 写 `version_no=1` 快照；`tool_agent` 首个候选自动 `is_default=true` |
| 更新 | 白名单字段；写新版本快照；`is_default` 切换时事务性取消旧默认 |
| 禁用 | `status=disabled`，不参与默认解析，绑定调度跳过 |
| 归档 | `status=archived`，写 `archived_at` 与快照；绑定保留 |
| 恢复 | `status=active`，清空 `archived_at`，写快照 |
| 硬删 | 默认要求已归档；`force=true` 可强制；级联解除角色绑定与工具默认标记 |
| 回滚 | 以目标版本 `snapshot` 覆盖当前配置，生成新版本号，不删除历史 |

---

## 八、关键流程

### 8.1 创建作品

1. `project_store.create_project` 原逻辑不变。
2. `agent_service.provision_project_defaults(project)`：
   - 读取 11 步模板，生成 11 个 `flow_step_agent`（`source=template`，`scope=project`）；
   - 为每个已注册工具生成 1 个 `tool_agent`（`source=auto`，首个 `is_default=true`）；
   - 幂等：按 `(kind, step_order)` / `(kind, tool_name)` 跳过已存在项。
3. 任一步失败只记录日志，不阻断项目创建；可通过 `provision` 接口重试。

### 8.2 创建角色

所有角色创建入口（路由 / 知识库导入 / 角色版图 AI）统一经 `RoleStore.create_role`：

1. 角色写入项目文件。
2. 触发生命周期回调 `bind_role_default_flow(project_id, role_id)`：
   - 读取该项目 11 个 active `flow_step_agent`；
   - 对缺失的 `step_order` 创建绑定：
     - `agent_ref_id = agent.id`
     - `agent_id = platform_config.bot_id or agent.id`
     - `enabled = true`
     - `model = model_config.model`
     - `agent_env = platform`
   - 已存在绑定不覆盖。
3. 回调失败只记录日志，不影响角色创建。

### 8.3 恢复默认绑定

`POST /api/roles/<role_id>/agents/reset-default`

| mode | 行为 |
| --- | --- |
| `fill`（默认） | 只补齐缺失步骤 |
| `replace` | 删除该角色全部绑定后重建 11 条默认绑定 |

### 8.4 流程调用与进度

`StepFlowEngine.trigger_flow` / `trigger_step` 注入 `FlowProgressStore`：

1. 获取 `(project_id, role_id)` 独立执行锁；失败返回 `409 该角色流程正在执行`。
2. 初始化/更新进度：`run_id`、`status=running`、`current_step`。
3. 每步执行前写 `started_at`，执行后写 `output` / `status` / `finished_at` 并落盘。
4. 全部完成 → `done`；任一步失败 → `failed` + `last_error`。
5. 释放锁。

### 8.5 调度器解析 Agent

`RoleAgentScheduler._invoke_agent`：

1. 若 `binding.agent_ref_id` 存在，经注入的 `agent_resolver` 读取 Agent。
2. `status != active` → 跳过该绑定并记 `skipped` 审计。
3. 使用 Agent 的 `platform` / `model_config.model` / `platform_config.bot_id`。
4. `bot_id` 为空 → 抛 `400 作品级流程 Agent 未配置`（不静默跳过）。
5. 会话与记忆 key 保持 `(role_id, agent_id)`，不因共享 Agent 而变化。

### 8.6 小说工具默认 Agent 解析

`POST /api/projects/<project_id>/tools/<tool>` 调用前：

1. 经 `agent_service.resolve_default_tool_agent(project_id, tool_name)` 取 active 默认工具 Agent；
2. 注入 `context["tool_agent"] = {id, name, platform, model}`（只读）；
3. 工具审计 `ToolCallRecord` 记录 `agent_id`；
4. 本期不改变工具处理器内部逻辑；切换默认项后，下一次工具调用即使用新 Agent 的配置。

---

## 九、API 契约

统一响应：`{"code": 0, "data": ..., "message": "ok"}`；错误：`{"code": <非0>, "data": null, "message": "..."}`。

### 9.1 Agent CRUD

| 方法/路径 | 请求要点 | 响应 | 错误码 |
| --- | --- | --- | --- |
| `POST /api/agents` | `project_id`、`kind`、`name` 及归属字段 | Agent（不含 versions） | 400/404/409 |
| `GET /api/agents` | `project_id` 必填；`kind`/`status`/`role_id`/`tool_name`/`keyword`/`page`/`page_size` | `{items,total}` | 400 |
| `GET /api/agents/<id>` | `include_versions` | Agent | 404 |
| `PUT /api/agents/<id>` | 白名单字段 | Agent | 400/404 |
| `POST /api/agents/<id>/archive` | — | Agent | 404 |
| `POST /api/agents/<id>/restore` | — | Agent | 404 |
| `DELETE /api/agents/<id>` | `force` | `{success:true}` | 404/409 |
| `GET /api/agents/<id>/versions` | — | 版本列表（不含 snapshot） | 404 |
| `POST /api/agents/<id>/versions/<no>/rollback` | — | Agent | 400/404 |

### 9.2 分组

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/agents/groups?project_id=` | 返回虚拟分组树，含节点计数 |
| `PUT /api/agents/groups/overrides` | upsert 覆盖层：`key`/`name`/`sort_order`/`hidden` |
| `DELETE /api/agents/groups/overrides?project_id=&key=` | 删除覆盖 |
| `POST /api/agents/groups/manual` | 新建手工分组 |
| `DELETE /api/agents/groups/manual/<group_id>?project_id=` | 删除手工分组（组内 Agent 回落自动分组） |
| `PUT /api/agents/<id>/group` | 设置 `manual_group_key`（null 清除） |

### 9.3 工具 Agent

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/agents/tools?project_id=` | 工具 → 候选列表 + 默认项 |
| `POST /api/agents/tools/<tool_name>/switch` | `{project_id, agent_id}` 切换默认（事务性） |
| `POST /api/agents/projects/<project_id>/provision` | 幂等补建 11 步 + 工具 Agent |
| `POST /api/agents/projects/<project_id>/bind-roles` | 为项目内所有存量角色补齐默认绑定 |

### 9.4 角色默认流程

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/roles/<role_id>/agents/reset-default` | `{mode: fill|replace}` |
| `GET /api/roles/<role_id>/flow-progress` | 查询角色进度 |
| `POST /api/roles/<role_id>/flow-progress/reset` | 重置进度为 idle |

### 9.5 迁移

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/agents/migrations/role-bindings` | `{dry_run: true}` 扫描并回填 `agent_ref_id` |

---

## 十、并发隔离设计

| 维度 | 隔离方式 |
| --- | --- |
| 会话 | `conversation_id = f"{role_id}:{agent_id}"`，共享 Agent 不共享会话 |
| 记忆 | `agent_sessions` 的 `(role_id, agent_id)` 唯一命名空间 |
| 上下文 | 每次调用复制 context；调度器无可变跨角色状态 |
| 进度 | 每角色独立进度文件 `data/flows/<project_id>/<role_id>.json` |
| 执行 | 每 `(project_id, role_id)` 独立锁文件；不同角色并行 |
| 审计 | `ToolCallRecord` 记录 `role_id` + `agent_id`，可追溯 |

同一角色重复调用：`try_acquire` 失败 → `409 该角色流程正在执行`。
多角色并发调用：各自锁文件与进度文件不同，互不阻塞。

---

## 十一、存量迁移

### 11.1 角色绑定迁移

1. 扫描 `data/projects/*.json` 的 `role_bindings`。
2. 对无 `agent_ref_id` 的绑定：
   - 在本项目 Agent 中按 `agent_id == platform_config.bot_id` 匹配；
   - 匹配不到则创建 `role_agent`：`platform=binding.agent_env`、`bot_id=binding.agent_id`、`model=binding.model`、`role_id=binding.role_id`、`source=manual`。
3. 写回 `agent_ref_id`。
4. 幂等可重复执行；`dry_run=true` 只返回统计与样例。

### 11.2 存量项目回填

- `POST /api/agents/projects/<project_id>/provision`：补建缺失的 11 步与工具 Agent。
- `POST /api/agents/projects/<project_id>/bind-roles`：为所有存量角色补齐默认绑定。

---

## 十二、错误码

| 场景 | 码 |
| --- | --- |
| 参数/字段校验失败、kind 归属不匹配、模型参数越界 | 400 |
| 项目/角色/Agent/绑定/分组不存在 | 404 |
| 同 step 重复、同工具多个默认、未归档硬删 | 409 |
| 工具未注册 | 404 |
| 角色流程正在执行 | 409 |
| 上游 Agent 调用失败 | 502 |

---

## 十三、测试与验收

### 13.1 测试文件

| 文件 | 覆盖 |
| --- | --- |
| `tests/test_agent_store.py` | CRUD、版本快照/保留上限、归档恢复、敏感字段不落盘不回传 |
| `tests/test_agent_grouping.py` | 角色/工具/11 步自动分组、覆盖层别名排序隐藏、手工分组 |
| `tests/test_agent_routes.py` | 全部接口、错误码、分页过滤、版本接口 |
| `tests/test_agent_tool_switch.py` | 多候选、默认唯一、切换事务性 |
| `tests/test_project_provisioning.py` | 建作品生成 11+11 Agent、幂等补建 |
| `tests/test_role_default_binding.py` | 新建角色自动 11 条绑定（路由/导入两条路径）、不覆盖改绑、reset-default |
| `tests/test_flow_progress_isolation.py` | 3 角色并发跑流程，进度/上下文/记忆/conversation 互不串扰 |
| `tests/test_scheduler_agent_ref.py` | agent_ref_id 解析、归档跳过、未配置 bot 的明确报错 |
| `tests/test_role_binding_migration.py` | 迁移正确性、幂等、dry-run |

### 13.2 核心验收场景

1. **创建作品时自动生成完整 11 步 Agent 链**：`test_project_provisioning`。
2. **新建角色自动关联默认 Agent**：`test_role_default_binding`（含知识库导入路径）。
3. **单作品多角色同时发起流程调用无数据串扰**：`test_flow_progress_isolation`。

### 13.3 CI

- `python scripts/run_checks.py --path .`
- `python -m pytest -q`
- `python -m compileall -q .`

---

## 十四、风险与约束

| 风险 | 缓解 |
| --- | --- |
| 文件数增长（每项目 22+ Agent 文件） | 个人规模可接受；列表按项目目录扫描；后续可迁移 SQLite |
| 版本快照使单文件变大 | 保留最近 50 条；列表默认剥离 `versions` |
| 回调失败导致默认绑定缺失 | 失败只记日志；提供 `provision` / `bind-roles` / `reset-default` 补偿 |
| 共享 Agent 的并发限流 | 依赖上游平台限流；本地按角色隔离，不额外串行化 |
| 模板 bot_id 未配置导致流程不可执行 | 调用时返回明确错误；模板可在配置文件中统一补齐 |

---

## 十五、文档同步

实现完成后同步更新：

- `docs/02-技术与架构/数据结构设计.md`：新增 Agent、AgentVersion、FlowProgress 实体与索引。
- `docs/02-技术与架构/接口契约.md`：新增 `/api/agents/*` 与角色默认流程接口。
- `docs/02-技术与架构/目录结构.md`：新增模块与数据目录。
- `docs/04-功能交付档案/`：新增本功能交付档案（需求澄清 / 技术方案 / 任务规划 / 验证结论）。

---

*本设计为 2026-11-15 智能体管理模块与作品级 11 步流程 Agent 的实施依据，评审通过后进入任务规划与编码实现。*
