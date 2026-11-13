# Agent 模块架构调整 · 执行进度追踪

> 生成日期：2026-11-13
> 对应实现计划：`docs/superpowers/plans/2026-11-agent-parallel-model.md`
> 对应设计文档：`docs/superpowers/specs/2026-11-13-agent-parallel-model-design.md`
> 当前进度：**0 / 12 任务完成**（未开始）

---

## 一、进度总览

| 指标 | 值 |
|---|---|
| 任务总数 | 12 |
| 已完成 | 0 |
| 进行中 | 0 |
| 未开始 | 12 |
| 完成率 | 0% |

**当前状态**：全部任务未开始，无任何任务相关代码文件或测试文件产生。

---

## 二、执行方式说明

用户已选择 **Subagent-Driven（推荐）** 执行方式。

**环境说明**：`superpowers:subagent-driven-development` 技能未安装在本环境（需从 obra/superpowers 下载完整技能目录 + 多个依赖子技能 + bash 脚本，Windows 环境无法运行）。因此采用**等效核心流程**：

- 每个任务派发一个独立子代理（general-purpose）实现
- 子代理实现后由主代理进行**任务审查**（spec 合规 + 代码质量）
- 任务间不暂停，连续执行
- 全部完成后做全量回归 + 文档同步

---

## 三、任务进度表

| # | 任务 | 涉及文件 | 依赖 | 状态 | 完成标准 |
|---|---|---|---|---|---|
| 1 | AgentClient 抽象协议 + CozeAgentClient 包装 | 新建 `agent_client.py`、`tests/test_agent_client.py` | — | ⬜ 未开始 | `pytest tests/test_agent_client.py` 通过（2 passed） |
| 2 | TraeAgentClient 协议桩 | 新建 `trae_agent_client.py`，追加 `test_agent_client.py` | 1 | ⬜ 未开始 | `pytest tests/test_agent_client.py` 通过（3 passed） |
| 3 | role_store 绑定字段白名单扩展 | 修改 `role_store.py`，追加 `test_role_store.py` | — | ⬜ 未开始 | `pytest tests/test_role_store.py` 通过（含 depends_on/model/agent_env 校验） |
| 4 | config_loader 新增 model_config | 修改 `config_loader.py`，新建 `test_config_model.py` | — | ⬜ 未开始 | `pytest tests/test_config_model.py` 通过 |
| 5 | ModelRouter 模型路由层 | 新建 `model_router.py`、`test_model_router.py` | 4 | ⬜ 未开始 | `pytest tests/test_model_router.py` 通过（5 passed） |
| 6 | CozeClient.chat 支持可选 model | 修改 `coze_client.py`，追加 `test_coze_client.py` | — | ⬜ 未开始 | `pytest tests/test_coze_client.py` 通过（body 含 model） |
| 7 | ParallelAgentExecutor（DAG + 并行 + 超时/重试/降级） | 新建 `parallel_agent_executor.py`、`test_parallel_agent_executor.py` | — | ⬜ 未开始 | `pytest tests/test_parallel_agent_executor.py` 通过 |
| 8 | RoleAgentScheduler 委托并行 + 模型路由 | 修改 `role_agent_scheduler.py`，追加 `test_role_agent_scheduler.py` | 5,7 | ⬜ 未开始 | 新增测试通过 + 既有测试不回归 |
| 9 | routes.py 端点接受扩展字段 | 修改 `routes.py`，追加 `test_novel_creation_routes.py` | 3 | ⬜ 未开始 | `pytest tests/test_novel_creation_routes.py` 通过 |
| 10 | app.py 装配注入 | 修改 `app.py`，追加 `test_app.py` | 5,7 | ⬜ 未开始 | `pytest tests/test_app.py` 通过 |
| 11 | 集成测试（端到端多 Agent 并行聚合） | 新建 `test_parallel_integration.py` | 1,5,7,8 | ⬜ 未开始 | `pytest tests/test_parallel_integration.py` 通过 |
| 12 | 全量回归 + 文档同步 | 修改设计文档 | 1-11 | ⬜ 未开始 | `pytest tests/` 全部 PASS（含既有 30+ 测试不回归） |

**依赖链**：Task 2←1；Task 5←4；Task 8←5,7；Task 9←3；Task 10←5,7；Task 11←1,5,7,8；Task 12←1-11。

---

## 四、当前 git 基线

- 分支：`main`
- HEAD：`ba64282 feat(F9): 角色头像生成与连线配色功能交付`
- 工作区：存在大量与本次任务**无关**的未提交修改（app.py、storage.py、project_store.py、plot_tree.py、static/js、templates/index.html 等，为前序 F9 等改动残留），**本次 12 个任务不会触碰这些文件**，任务相关文件为新增/仅限 `modules/novel_creation/`、`coze_client.py`、`config_loader.py`、`app.py`、`tests/`、`docs/superpowers/`。
- `docs/superpowers/` 为未跟踪目录（设计文档 + 实现计划 + 本追踪文档）。

---

## 五、恢复指引

恢复执行时按以下步骤：

1. 确认 git 状态与 HEAD（基线 `ba64282`）
2. 确认无任务相关代码残留（`agent_client.py` / `model_router.py` / `parallel_agent_executor.py` / `trae_agent_client.py` 均不存在）
3. 从 **Task 1** 开始派发第一个实现子代理
4. 每个任务完成后更新本追踪文档对应状态行（⬜ → 🔄 → ✅）

---

## 六、开放项（实现前需与用户确认，已按可落地路径编写进计划）

| # | 开放项 | 计划处理 | 影响任务 |
|---|---|---|---|
| 1 | Trae 通道协议未定义 | 实现为协议桩（抛 NotImplementedError），真实接入待用户提供契约 | 2 |
| 2 | Coze 运行时 model 未验证 | 按乐观路径实现（body 加可选 model），若实测不通过仅影响 Task 6 | 6 |
| 3 | 超时收尾语义 | 计划 Task 7 已含 future 级超时可选实现 | 7 |
| 4 | agent_env 字段同步 routes | Task 9 处理 | 9 |
| 5 | HTTP 接口兼容 | 新增字段仅作请求体可选扩展，响应格式不变 | 9,12 |
