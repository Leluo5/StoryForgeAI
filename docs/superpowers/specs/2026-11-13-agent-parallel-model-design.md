# Agent 模块架构调整设计：并行接入 + 模型选择

> 日期：2026-11-13
> 状态：草案（待自审 + 用户审阅）
> 范围：StoryForgeAI agent 模块（modules/novel_creation/ + coze_client.py + config_loader.py）
> 方案：A · 分层抽取 · 独立组件

---

## 一、目标与背景

针对上一轮"Agent 模块深度分析"识别的技术痛点（P1-P10），本设计实现三项核心能力：

1. **动态创建 Agent 实例**：基于角色信息 + 角色流程维度（step_order）的组合条件，动态创建对应智能体。
2. **Coze / Trae 双环境选择与切换**：支持在两种 Agent 运行环境间灵活选择。
3. **可配置模型接入**：根据业务场景选择并对接不同大语言模型。

保留所有现有功能与接口兼容性（HTTP 接口不变，内部 API 签名不变），不破坏现有业务逻辑。

---

## 二、核心能力可实现性判定（基于当前代码验证）

| # | 能力 | 判定 | 依据 |
|---|---|---|---|
| 1 | 动态创建 Agent 实例 | ✅ 可行（已有底座，需扩展） | `role_store.create_binding/get_bindings` 已支撑 `(role_id, agent_id, step_order)` 绑定与命中 |
| 2 | Coze / Trae 双环境切换 | ⚠️ 部分可行（Coze 就绪，Trae 空白） | 后端仅 `CozeClient`；全库无 `TraeAgentClient` |
| 3 | 可配置模型接入 | ⚠️ 条件可行（受 Coze 平台约束） | `coze_client.chat()` 请求体无 model 字段；`config_loader` 无模型字段 |

---

## 三、架构与组件（设计第一节）

### 3.1 分层结构

```
RoleAgentScheduler（保留，公开签名不变）
    ├── 委托 → ModelRouter（新增）      解析模型：全局配置 + 动态指定
    └── 委托 → ParallelAgentExecutor（新增）  DAG 构建 + 层内并行 + 超时/重试/降级 + 聚合
```

- **ModelRouter**（`model_router.py`）：可配置模型列表、默认模型、按场景路由规则 → 输出 `model_id`
- **ParallelAgentExecutor**（`parallel_agent_executor.py`）：`depends_on` 构建 DAG → 拓扑分层 → **层内并行、层间串行** → 结果聚合
- **RoleAgentScheduler**：公开方法签名不变，内部把串行 for 改为委托 `ParallelAgentExecutor.execute`

### 3.2 数据流与接口

```python
class ModelRouter:
    def __init__(self, config_loader, default_model="default"): ...
    def list_models(self) -> list[str]
    def get_default_model(self) -> str
    def resolve(self, scene: ModelScene) -> str   # 场景 → 模型

class ParallelAgentExecutor:
    def __init__(self, agent_client, executor=None, max_workers=8,
                 timeout=30.0, max_retries=2, backoff=1.5): ...
    def execute(self, tasks: list[AgentTask], context: dict) -> ExecuteResult
```

`RoleAgentScheduler` 新增**可选**构造参数：`model_router`、`parallel_executor`、`timeout`、`max_retries`、`backoff`（均向后兼容，缺省时用内置默认值）。现有端点/响应格式/错误码不变。

### 3.3 绑定与存储扩展

- `role_bindings` 新增可选字段：`depends_on`（list[str]，依赖的绑定 id）、`model`（动态指定覆盖）、`agent_env`（"coze"|"trae"，默认 "coze"）
- **旧数据兼容**：无这些字段 → 默认无依赖、用默认模型、用 coze 环境，不迁移
- `config_loader` 全局配置新增 `model_config`：`models` / `default_model` / `route_rules`，加载时对旧配置补默认值

### 3.4 稳定性策略（跳过硬失败）

| 环节 | 行为 |
| --- | --- |
| 超时 | 每 Agent `future.result(timeout=30s)` → `TimeoutError` |
| 重试 | 超限重试 **2 次**，指数退避 `backoff=1.5` |
| 降级 | 超限后**跳过**该 Agent，结果打 `degraded` 标记，**不阻断**后续层 |
| 异常隔离 | 单 Agent 异常只影响自身，`per_agent` 记录，继续执行 |

---

## 四、架构验证：现有支撑点与潜在瓶颈

### 4.1 支撑点（可直接复用）

- **绑定语义完整**：`create_binding` 已强制 `step_order ∈ [1,11]` 且同角色同步骤唯一，`get_bindings` 按 step_order 排序——即"角色信息 × 流程维度"的组合条件。
- **DI 注入完备**：`create_app` 已注入 `role_store / project_store / agent_client / executor`，新组件可沿用同一注入模式。
- **契约清晰**：`CozeClient.chat(bot_id, user_message, conversation_id, parameters) -> dict{success, content}`，`_call_agent` 已按此调用。
- **错误映射就绪**：`AppError` 400/404/409/502/500 已覆盖并行/降级所需错误码。

### 4.2 潜在瓶颈（真实代码证据）

| 瓶颈 | 证据 | 影响 |
|---|---|---|
| 绑定字段白名单过窄 | `update_binding` allowed = {agent_id, step_order, workflow_id, enabled}；`create_binding` 只读 workflow_id/enabled | `depends_on`、`model`、`agent_env` 无法落库 |
| 无统一客户端协议 | 仅 `CozeClient` 一类，`_call_agent` 硬编码 | 切 Trae 需新增实现 + 抽象基类 |
| Coze chat 无 model 入口 | body 仅 bot_id/user_id/stream/auto_save/additional_messages/conversation_id/custom_variables | 经 Coze 通道运行时换模型无落点 |
| 超时无法外部控制 | timeout=30/15、max_poll=60 硬编码 | 外层超时时 Coze 内部轮询仍在后台跑，线程占用不释放 |
| 调度器串行 | `invoke_role_agents` 内 for 循环顺序调用 | 需 DAG 拓扑分层重写 |
| 记忆并发写 | `set_memory` 走文件锁；并行多 Agent 写同一文件 | 文件锁串行化，吞吐受限，需评估 |

---

## 五、实现障碍与架构调整建议

### 障碍 1：绑定字段白名单（阻塞 depends_on/model/agent_env）
- `role_store.create_binding`：`**extra` 显式提取 `depends_on`（默认 []）、`model`（默认 None）、`agent_env`（默认 "coze"），做类型校验。
- `update_binding` allowed 扩展为 `{agent_id, step_order, workflow_id, enabled, depends_on, model, agent_env}`。
- 旧数据读取用 `.get("depends_on", [])` 兜底。

### 障碍 2：Coze / Trae 双通道（核心缺口）
- 定义抽象基类 `AgentClient`，契约 `chat(bot_id, user_message, conversation_id="", parameters=None, **kwargs)`。
- `CozeAgentClient` 包装现有 `CozeClient`（保持 `_call_agent` 契约不变）。
- 新建 `TraeAgentClient` 实现同一契约。**开放项**：Trae 的 Agent 调用通道（HTTP 网关 / MCP / Tool / 本地 CLI）**尚未定义**，需实现前与用户对齐。
- 调度器按 `binding.agent_env` 路由：注入 `clients: dict[str, AgentClient]`，缺省 `{"coze": CozeAgentClient}`。

### 障碍 3：模型接入在 Coze 通道受限
- 若 Coze 允许 `v3/chat` 传 model：在 `CozeClient.chat` body 加 `model` 字段（最省路径）。
- 若 Coze 强制 bot 绑定模型（更可能）：模型路由只影响提示词/路由决策，或经 TraeAgentClient 对接自建/第三方 LLM 网关。
- **开放项**：需用 Coze API 实测一次判定该约束。

### 障碍 4：超时与后台线程泄漏
- 外层 `future.result(timeout)` 触发 TimeoutError 后，需 `future.cancel()` + `add_done_callback` 收尾，避免半写记忆与线程泄漏。

### 障碍 5：记忆并发写吞吐（可选性能级）
- 若实测发现瓶颈，可改 `set_memory` 为批量合并（层结束后一次写回），或引入 `(role_id, agent_id)` 分段锁。

---

## 六、各模块交互逻辑

```
create_app (app.py)
  └─ 注入 role_store / project_store / agent_client / executor
       └─ RoleAgentScheduler（保留，公开签名不变）
            ├─ 命中绑定：get_bindings(project_id, role_id, enabled=True) → 过滤 step_order <= 当前 step
            ├─ 新增委托 → ModelRouter.resolve(scene) → model_id（读取 config_loader.model_config，可被 binding.model 覆盖）
            ├─ 新增委托 → ParallelAgentExecutor.execute(tasks, context)
            │    depends_on 构建 DAG → 拓扑分层 → 层内并行、层间串行
            │    稳定性：future.result(timeout=30s) / 重试2次退避1.5 / 降级跳过打 degraded
            └─ 调 _call_agent → clients[agent_env].chat(bot_id, user_message, conversation_id, parameters)
                 ├─ CozeAgentClient → CozeClient.chat（现有逻辑）
                 └─ TraeAgentClient（新建，通道待澄清）
                      └─ 写回记忆：set_memory(project_id, role_id, agent_id, ...)
                      └─ 审计：append_tool_call(project_id, tool_name, req, resp, status)
```

**关键不变量**：`RoleAgentScheduler` 对外方法（`invoke_role_agents`/`trigger_step`/`trigger_flow`）签名与现有调用方（`step_flow_engine`、`routes.py`）完全不变；`merge_result` 语义不变。

---

## 七、关键技术点实现路径

| 技术点 | 路径 | 风险 |
|---|---|---|
| 绑定字段扩展 | role_store 白名单 + **extra 显式提取 + 类型校验 | 低 |
| 统一客户端协议 | AgentClient 抽象基类 + CozeAgentClient 包装 + TraeAgentClient 新建 | 中（Trae 通道未定义） |
| 模型路由层 | ModelRouter + config_loader.model_config（热更新走现有 save_global_config） | 中（Coze 是否支持运行时 model 待实测） |
| DAG 并行 | ParallelAgentExecutor：邻接表建图 → 拓扑分层 → 层内并发 | 中（环检测显式抛 400） |
| 超时/重试/降级 | future.result(timeout) + 指数退避 + degraded 聚合 | 中（后台线程收尾需设计） |
| 兼容性 | 缺省参数内置默认；旧绑定无新字段兜底 | 低 |

---

## 八、功能边界与约束条件

**已存在、必须保留的硬约束**：
- `step_order ∈ [1,11]`，同角色同步骤唯一绑定。
- 记忆命名空间 `(role_id, agent_id)` 隔离；`conversation_id = f"{role_id}:{agent_id}"` 禁止跨角色复用。
- `merge_result` 只浅层合并一层，不深改嵌套结构。
- 审计失败不阻断主流程。

**新引入、需在实现前明确的约束（开放项 TODO）**：
1. **Trae 通道协议未定义**：调用入口（HTTP 网关 / MCP / Tool / 本地 CLI）需用户澄清；未澄清前 TraeAgentClient 先做协议桩。
2. **Coze 运行时模型参数未验证**：`v3/chat` 是否接受 model 字段待实测；未实测前能力 3 判定为条件可行。
3. **超时收尾语义**：外层超时后 Coze 内部轮询仍在后台，需明确 cancel / add_done_callback 收尾。
4. **agent_env 字段**：需同步 `routes.py` 绑定创建/更新端点接受该字段，否则前端无法配置。
5. **HTTP 接口兼容**：现有端点/响应格式/错误码保持不变；新增字段仅作请求体可选扩展。

---

## 九、测试策略（设计第一节）

- `test_model_router.py`：列表/默认/场景路由/无匹配回退/热更新
- `test_parallel_agent_executor.py`：DAG 拓扑、层内并行、超时降级、重试、异常隔离、聚合
- 更新 `test_role_agent_scheduler.py`：原串行语义 → 委托并行后结果不变（兼容）、depends_on、degraded
- `test_parallel_integration.py`：端到端多 Agent 并行 → 聚合

---

## 十、验证结论

- **方案 A 架构成立**，组件职责清晰，与现有 DI 范式、错误映射、存储模型兼容。
- **三项核心能力判定**：能力 1 可直接落地（扩展白名单即可）；能力 2、3 需各补一个前置澄清/实测（Trae 通道协议、Coze 运行时 model 支持），否则只能交付"框架就绪 + 桩实现"。
- **建议下一步**：先与用户对齐两个开放项（① Trae 调用通道协议；② Coze 是否支持运行时指定模型），这两项直接决定能力 2、3 的最终交付形态。
