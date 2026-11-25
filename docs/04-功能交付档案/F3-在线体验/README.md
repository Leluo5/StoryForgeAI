# F3 · 在线体验 · 分册索引

> 所属：[《功能交付档案》总索引](../README.md)｜第 3 / 4 篇
> 返回：[文档中心](../../README.md)

## 一、来源说明

本功能档案由 SpecForge 功能级工作流（需求澄清 → 技术方案 → 任务规划）生成，共 3 篇分册，对应 StoryForgeAI 的 F3 功能模块（在线体验）。

## 二、篇章导航

| 编号 | 分册 | 内容概要 | 状态 |
| --- | --- | --- | --- |
| 01 | [需求澄清](./01-需求澄清.md) | 三种交互模式、流式输出、参数表单需求 | 已定稿 |
| 02 | [技术方案](./02-技术方案.md) | 参数类型转换、SSE 代理、文件上传、模式路由 | 已定稿 |
| 03 | [任务规划](./03-任务规划.md) | 已实现基线登记 + 偏差登记 + 整改任务 R1–R9 | 整改完成（R1–R9 全绿） |

## 三、阅读路径

- **顺序阅读**：01 → 02 → 03（需求 → 方案 → 任务）。
- **按需跳读**：仅看技术细节 → 02；仅看排期 → 03。
- **回溯原文**：本档案对应 SpecForge 功能级产出，无独立母文档。

## 四、功能说明

- **功能名**：在线体验
- **核心目标**：体验者在页面直接与 Coze 作品交互（对话/表单/混合），支持流式输出与文件上传。
- **涉及代码**：`apps/api/src/writing/experience.{controller,service}.ts`、`apps/web/src/experience/experience-{client,page}.tsx`、`packages/contracts/src/experience.ts`（见 02-技术方案.md）。

## 五、校准记录（2026-11-21）

- 经代码盘点核实：F3 在旧 Flask 底座**已基本实现**（T1–T5 均有落地代码与测试），但 v1.0 任务规划全标「待开始」，与代码不同步。
- 本次将 [03-任务规划.md](./03-任务规划.md) 升级为 v2.0 校准版：登记已实现基线 + 12 项偏差（D1–D12）+ 拆出严格对齐技术方案的整改任务 R1–R9（含 P0 安全项 R4 错误脱敏、R6 统一鉴权，及破坏性变更 R2 路由改名、R3 事件契约统一）。
- 下一步：确认 R1–R9 后进入 F4 编码实现，按 R4/R6 → R1 → R2 → R3 → R5 → R7 → R8 → R9 顺序推进。

## 六、F4 编码实现完成记录（2026-11-21）

R1–R9 全部完成，`tests/test_app.py` 72 用例全绿，`pnpm run ci` 通过。

- **破坏性变更已落地**：R2 路由 `/execute`→`/workflow/run`、请求字段 `inputs`→`params`、非流式成功响应 `{output}`、前端 stream 可切换；R3 chat+workflow SSE 事件统一为 `delta/done/error`（移除前端不消费的 `stream_end/interrupt`）；R6 execute/upload 接入 `require_work_access`，前端统一 `X-Access-Token` 头。
- **健壮性**：R4 错误脱敏（上游原文仅写日志）；R5 流式失败/上游 Error 事件自动降级到非流式 run；R7 中断/失败重试按钮 + isStreaming 复位。
- **已知部分对齐偏差**：Object/Array/File 参数保留前端依赖的友好转换（Array CSV 拆分、Object `{"value":x}` 兜底、File `{"file_id":x}` 包装），仅 Integer/Number 非法转换抛 `ParamError`→400。详见 [03-任务规划.md 偏差登记](./03-任务规划.md)。

## 七、多轮记忆与停止生成修复（2026-11-21）

- 多轮会话改为稳定 `user_id` + Coze URL Query `conversation_id`，真实同页两轮暗号回忆通过。
- 发送按钮在流式期间切换为“停止生成”，支持响应前和生成中取消；保留已生成内容，不显示主动取消错误。
- 防复发测试：Python 相关回归 113 passed，真实 JS DOM 交互测试 3 passed。
- 完整 CI 仍被既有 NestJS PostgreSQL 测试环境故障阻塞，未记为全绿。详见 [BUG-2026-122-01 修复报告](../../BUG修复文档/BUG-2026-122-01-多轮上下文记忆与停止生成修复报告.md)。

## 八、新架构迁移说明（2026-11-25）

- 实现由 Python Flask（`app.py`/`coze_client.py`/`static/js/app.js`）迁移至 TS 新架构，落点为 PostgreSQL（WorkEntity 访问码字段）+ Coze API，迁移提交 `1d3064e`。
- 公开 API：`GET/POST /experience/works`、`/experience/works/:id`、`/experience/works/:id/verify`、`/experience/works/:id/chat`（SSE）。原 `/workflow/run`、`/execute`、`/upload` 由新架构对应控制器承载。
- 契约：`packages/contracts/src/experience.ts`（publicWork / verifyAccess / chatEvent 的 Zod schema）。
- 鉴权：公开无登录；设访问码的作品需 `X-Access-Token`（verify 颁发签名 token）。
- 交互：体验聊天 SSE 事件统一 `delta/done/error`；`interaction_type` 元信息供前端渲染对话/表单/混合。
- 前端：`experience-page.tsx` + `experience-client.ts`（对应旧 `app.js`）。
- 详细差异见 01/02/03 分册「新架构迁移说明」。
