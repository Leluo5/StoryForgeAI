# ADR-0002：角色 Agent 机制决策

> 日期：2026-11-10 · 状态：已采纳（P2 架构评审通过后生效）
> 类型：架构决策记录（ADR）
> 适用范围：研发
> 维护：02-技术与架构/架构决策记录｜关联：[架构设计文档](../架构设计文档.md)、[需求规格说明书](../../01-产品与设计/需求规格说明书.md)、[功能边界定义](../../01-产品与设计/功能边界定义.md)
> 权威口径：本文档记录「为什么角色 Agent 机制这样设计」，一经采纳不改写结论；如需变更，新增 ADR 并链接本记录。

---

## 一、状态

**已采纳**（P2-T7 架构评审通过后由架构负责人确认）

---

## 二、背景与约束

### 2.1 问题

`StoryForgeAI` 由「Coze 作品展示与在线体验平台」改造为**专业小说 AI 写作软件**，核心需求是为每个小说角色独立配置、绑定、管理独立的 cozeAgent 实例，使角色在创作中保持：

1. **身份一致性**——同一角色每次调用不串角色、不串设定；
2. **记忆连续性**——同一角色跨会话恢复历史记忆；
3. **行为逻辑独立性**——多角色并行写作时不互相覆盖数据。

同时支持**单角色绑定多个 cozeAgent**，按 11 步预设流程有序调用。

### 2.2 约束

| 约束 | 内容 |
| --- | --- |
| 技术栈 | 沿用 Flask 2.x + 原生 JS，不引入新框架 |
| 存储 | JSON 文件（个人规模），预留 SQLite 迁移接口 |
| 性能 | 接口响应 ≤ 200ms（P95）、Agent 调用成功率 ≥ 99.5%、并发 ≥ 50 |
| 边界 | 角色 Agent 禁止跨角色读写、禁止访问管理端、禁止写知识库（[功能边界定义](../../01-产品与设计/功能边界定义.md)） |
| 现状 | `modules/novel_creation/` 为纯空壳，调度器/流程引擎无既有代码基础，需全新实现 |

---

## 三、决策

**采用「角色为聚合根 + 独立 Agent 绑定 + 显式命名空间隔离」的调度机制。**

核心决策点：

1. **角色为调度聚合根**：所有 Agent 调用以 `role_id` 为入口，绑定关系挂在角色下（`RoleAgentBinding` 实体），单角色可绑多 Agent，`step_order` 决定调用顺序。
2. **独立 Agent 实例**：每角色绑定的每个 `agent_id` 独立，不共享上下文；`conversation_id = f"{role_id}:{agent_id}"` 隔离会话。
3. **身份一致性注入**：每次调用在系统提示词前缀注入 `你扮演角色<role_id>，保持身份一致`。
4. **记忆命名空间**：`memory_state` 按 `role_id` 独立命名空间持久化，跨会话恢复。
5. **写锁粒度**：多角色并行写用 `project_id` 锁（`fcntl`/`msvcrt` 封装 `FileLock`），防数据覆盖。
6. **调用模型**：同步调用走线程池（`ThreadPoolExecutor`，`max_workers` 可配）；长任务走任务队列，不阻塞 SSE。

### 3.1 调度伪代码

```python
# modules/novel_creation/role_agent_scheduler.py（P3-T2 实现）
class RoleAgentScheduler:
    def __init__(self, role_store, agent_client, executor, max_workers=8):
        ...

    def invoke_role_agents(self, role_id, step_order, context):
        bindings = self.role_store.get_bindings(role_id, enabled=True)
        bindings = sorted(bindings, key=lambda b: b.step_order)
        for binding in bindings:
            if binding.step_order == step_order or binding.step_order <= step_order:
                sys_prompt = f"你扮演角色{role_id}，保持身份一致"
                memory = self.role_store.get_memory(role_id, binding.agent_id)
                result = self._invoke_sync(binding.agent_id, context, memory, sys_prompt)
                context = merge_result(context, result)
                self.role_store.set_memory(role_id, binding.agent_id, result)
        return context
```

### 3.2 11 步预设流程

`StepFlowEngine` 维护 `DEFAULT_STEPS`（step_order 1-11：外貌特征→个性特点→思维方式→个人能力→情感状态→文化背景→信仰道德→成长线→经历沉淀→人际关系→情节发展），支持重排、单步触发、全流程触发。

---

## 四、备选方案及取舍

| 方案 | 描述 | 取舍理由 |
| --- | --- | --- |
| **A. 角色聚合根 + 独立绑定（采纳）** | 角色为聚合根，绑定实体独立，每 Agent 独立上下文 + role_id 命名空间 | 满足三原则（身份/记忆/独立性）且扩展性好：新增角色/Agent 不改调度逻辑 |
| **B. 单一 Agent 池 + 全局共享上下文** | 所有角色共用 Agent 池，上下文全局 | 实现简单但身份易串、记忆易混、多角色并行必然冲突，**否决** |
| **C. 每角色一个 Agent + 无绑定表** | 角色与 Agent 1:1，无多 Agent 排序 | 不满足「单角色多 Agent 按 11 步有序调用」需求，**否决** |
| **D. 数据库事务 + 行级锁** | SQLite/MySQL 事务保证一致性 | 存储升级成本高，当前 JSON 个人规模不需要；**预留 StorageBackend 抽象，并发 ≥ 50 时评估** |

---

## 五、后果

### 5.1 正面

- 身份一致性、记忆连续性、行为逻辑独立性有明确实现机制，可自动化测试验证（验收 R-01~R-08）。
- 单角色多 Agent 有序调用满足 11 步预设流程，扩展新步骤只需改配置。
- 写锁 + 命名空间隔离保证多角色协同无冲突。

### 5.2 负面 / 成本

- 每个角色需独立维护绑定关系，管理复杂度上升（需角色 Agent 管理界面）。
- `memory_state` 持久化到 JSON，文件量随角色数增长（单项目规模可控）。
- 线程池需控制上限，避免 Agent 调用风暴；长任务必须走队列。
- 文件锁仅单机进程内有效，多进程/多机部署需重新评估（当前单机演示场景可接受）。

---

## 六、关联决策

| 决策 | 关联 |
| --- | --- |
| ADR-0001：PAT 令牌迁移环境变量 | C-003 安全修复，Agent 调用依赖 Coze PAT，两者关联 |
| 架构设计文档 §4 调度机制 | 本 ADR 的机制实现依据 |
| 数据结构设计 §3 角色/绑定/会话 | `RoleAgentBinding`、`AgentSession` 实体落地 |
| 接口契约 §角色接口 | `/api/roles/<id>/agents/invoke` 调用契约 |

---

## 七、验证方式

1. **自动化**：单元测试覆盖调度器排序、身份注入、记忆恢复、写锁（P3-T10）。
2. **手动**：单角色多 Agent 端到端调用（P3 出口准则）、多角色协同并行（P4）。
3. **验收**：角色一致性命中率 100%、记忆连续性 100%、多角色协同无冲突 100%（[验收标准](../../01-产品与设计/验收标准.md) R-01~R-08）。

---

*本文档为 P2-T7 架构评审与 ADR 归档交付物，与[架构设计文档](../架构设计文档.md)、[数据结构设计](../数据结构设计.md)、[接口契约](../接口契约.md)一并提交评审。*
