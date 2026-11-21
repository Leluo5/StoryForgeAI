# ArkClaw 独立单轮问答设计

> 版本：v0.1 · 状态：已批准（2026-11-21）
> 适用范围：StoryForgeAI 新版 NestJS/React 工作区中的 ArkClaw 独立验证功能
> 维护：04-功能交付档案｜关联：[文档中心](../../README.md)

## 一、设计结论

本功能在 StoryForgeAI 新版工作区增加一个独立的 ArkClaw 单轮问答页面。浏览器只访问 NestJS，由服务端通过 Agent-to-Agent（A2A）JSON-RPC 接口调用已有 ArkClaw 实例。功能不进入现有 AI 任务队列，不修改角色、章节、剧情或知识库数据。

用户已于 2026-11-21 确认以下决策：

| 决策点 | 结论 |
| --- | --- |
| 接入目标 | 调用已有 ArkClaw 实例，不管理实例生命周期 |
| 首期场景 | 独立对话验证，不接现有创作业务 |
| 对话能力 | 单轮问答，一次性返回完整回答 |
| 验证入口 | 新版 React 独立页面 |
| 实例条件 | ArkClaw 实例与 A2A 凭据已就绪 |
| 验收方式 | 真实实例问答与 Mock 自动化测试均需通过 |
| 实现路径 | 独立 NestJS 适配器与 React 页面 |

## 二、范围与边界

### 2.1 本期包含

- 登录作者可从作品库进入 `/arkclaw` 独立页面
- 作者可输入一个问题并同步获得完整文本回答
- 页面展示发送中、成功和失败状态
- NestJS 提供单轮问答接口并代理 A2A 请求
- 服务端环境变量保存完整 Webhook Endpoint
- 自动化测试覆盖请求契约、A2A 映射、异常和页面交互
- 使用真实 ArkClaw 实例完成一次页面问答验收

### 2.2 本期不包含

- 不创建、配置、启停或删除 ArkClaw 实例
- 不保存聊天历史，不传递 `contextId`，不支持多轮上下文
- 不使用 `message/stream`，不提供流式输出
- 不接入 Agent 配置、BullMQ、AI 任务记录或审计模块
- 不接角色、章节正文、剧情树、知识库或 F11 执行通道
- 不新增数据库表，不迁移旧 Flask 业务数据
- 不提供实例管理、用量统计、服务端重试或限流能力

## 三、方案选型

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 独立后端适配器 | 改动隔离，凭据不进入浏览器，范围与单轮验证一致 | 采用 |
| 复用现有 AI 任务体系 | 可统一任务管理，但引入队列与 Agent 配置等无关复杂度 | 不采用 |
| 浏览器直连 ArkClaw | 代码较少，但 Endpoint 中的凭据会暴露给浏览器 | 禁止 |

ArkClaw Webhook Endpoint 的查询参数包含 `apikey` 与 `clawId`。因此，A2A 请求只能由服务端发起，前端不得持有完整 Endpoint。

## 四、模块与数据流

### 4.1 模块职责

| 模块 | 职责 | 不依赖 |
| --- | --- | --- |
| 共享契约 | 校验问答请求与响应，复用前后端类型 | 数据库、A2A SDK |
| NestJS 控制器 | 登录与 CSRF 校验、请求校验、统一响应包装 | 现有 AI 任务控制器 |
| NestJS 服务 | 读取配置、构造 A2A 请求、超时控制、提取回答 | Agent、BullMQ、TypeORM |
| React 页面 | 输入问题、展示等待状态、回答与脱敏错误 | 编辑器、角色与剧情组件 |
| ArkClaw 实例 | 处理单轮文本问题并返回完整结果 | StoryForgeAI 内部数据 |

### 4.2 同步数据流

```text
登录作者在 /arkclaw 输入问题
  → React 调用 POST /api/v1/arkclaw/chat
  → NestJS 校验 Session、CSRF 与 message
  → ArkClawService 读取 ARKCLAW_A2A_ENDPOINT
  → 服务端发送 JSON-RPC message/send
  → ArkClaw 同步返回 task 结果
  → 服务端拼接 status.message.parts 中的文本
  → React 替换旧回答并显示本次结果
```

每次请求生成新的 JSON-RPC `id` 和 `messageId`。请求不传 `contextId`，因此 ArkClaw 按独立会话处理，不承诺记住上一次问题。

## 五、接口与配置

### 5.1 StoryForgeAI 接口

接口为 `POST /api/v1/arkclaw/chat`，复用 `SessionGuard`、`CsrfGuard`、`ZodValidationPipe` 与 `ok()` 响应包装。

请求字段如下：

| 字段 | 类型 | 规则 | 说明 |
| --- | --- | --- | --- |
| `message` | `string` | 去除首尾空白后 1–4000 字 | 用户本次问题 |

成功响应的数据字段如下：

| 字段 | 类型 | 规则 | 说明 |
| --- | --- | --- | --- |
| `answer` | `string` | 非空文本 | ArkClaw 本次完整回答 |

成功响应示例如下，外层 `request_id` 沿用现有请求标识：

```json
{
  "data": {
    "answer": "我是 ArkClaw 智能体。"
  },
  "request_id": "req-example"
}
```

每次提交都代表一次新的调用，不提供服务端幂等键。页面在请求进行中禁用提交按钮，防止重复点击；服务端不自动重试。

### 5.2 A2A 请求映射

服务端使用 Node.js 22 自带 `fetch`，不新增 A2A SDK 或 HTTP 依赖。请求体固定使用 `jsonrpc: "2.0"` 与 `method: "message/send"`，同步等待完整结果。

```json
{
  "jsonrpc": "2.0",
  "id": "<REQUEST_UUID>",
  "method": "message/send",
  "params": {
    "message": {
      "parts": [
        {
          "kind": "text",
          "text": "<USER_MESSAGE>"
        }
      ],
      "messageId": "<MESSAGE_UUID>",
      "role": "user"
    }
  }
}
```

服务端仅接受 `result.kind` 为 `task` 且 `result.status.state` 为 `completed` 的结果，并提取 `result.status.message.parts` 中 `kind` 为 `text` 的内容按原顺序拼接。缺失 `result`、返回 JSON-RPC `error`、任务未完成或没有非空文本时，均视为无效上游响应。

### 5.3 环境配置

新增可选环境变量 `ARKCLAW_A2A_ENDPOINT`，值由部署者从 ArkClaw 控制台复制到服务端 `.env`。变量保持可选，避免未启用本功能的开发、测试环境在启动时失败；调用接口时若未配置则返回 `503`。

`.env.example` 只登记变量名与用途，不写真实 Endpoint。真实 Endpoint 不得进入前端环境变量、源码、测试夹具、文档、日志或错误响应。

## 六、页面交互

作品库增加“ArkClaw 验证”入口，独立页面提供“返回作品库”操作。页面路由按现有懒加载方式注册，未登录时仍由现有会话门禁拦截。

页面包含以下可见元素：

- 标题与“单轮问答，不保存历史”的边界说明
- 与 `label` 关联的问题多行输入框，最大长度 4000 字
- 发送按钮；空白问题禁止提交，发送中显示“发送中”并禁用输入和按钮
- 回答区域；使用纯文本与保留换行样式展示，不使用 `dangerouslySetInnerHTML`
- 错误区域；使用 `role="alert"` 展示脱敏提示

新提问会替换旧回答。失败后保留当前输入，便于作者修改后手动重试；页面刷新后不恢复问题或回答。布局沿用现有设计令牌，在 375、768、1024、1440 像素视口下不得出现阻断性溢出，键盘可完成全部操作。

## 七、异常与安全

| 场景 | HTTP 状态 | 页面行为 |
| --- | --- | --- |
| 未登录 | `401` | 沿用现有登录处理 |
| CSRF 校验失败 | `403` | 显示请求校验失败 |
| 空白或超长问题 | `422` | 显示字段错误，不调用 ArkClaw |
| 未配置 Endpoint | `503` | 提示服务尚未配置 |
| 上游 HTTP、JSON-RPC 或任务失败 | `502` | 提示 ArkClaw 调用失败 |
| 网络连接失败 | `502` | 提示 ArkClaw 连接失败，可手动重试 |
| 上游响应缺少文本或结构异常 | `502` | 提示上游响应无效 |
| 120 秒超时 | `504` | 提示调用超时，可手动重试 |

服务端不得把上游响应原文、请求 URL 或网络异常对象直接透传给浏览器。错误响应只返回固定、脱敏的说明。若记录运行日志，只允许包含 `request_id`、耗时和上游 HTTP 状态，不记录完整 Endpoint、问题或回答。

超时统一为 120000 ms，与 ArkClaw 官方基础调用示例一致。网络失败、超时和上游错误均不自动重试，避免重复消耗调用额度。

## 八、测试与验收

### 8.1 自动化测试

| 层级 | 必测内容 |
| --- | --- |
| 共享契约 | 空白、超长与合法问题；合法回答响应 |
| 后端服务 | A2A 请求体、文本拼接、无 `contextId`、超时、网络失败、上游错误、异常响应、未配置 |
| 后端接口 | Session、CSRF、请求校验、成功包装与脱敏错误 |
| 前端组件 | 输入校验、发送中禁重、成功替换回答、失败保留输入 |
| 页面路由 | 作品库入口、独立页面加载与返回作品库 |
| 回归门禁 | `pnpm run ci` 全部通过 |

自动化测试使用 Mock `fetch` 或测试替身，不访问真实 ArkClaw，不把真实凭据写入测试环境。

### 8.2 真实实例验收

1. 部署者在本地服务端 `.env` 配置真实 `ARKCLAW_A2A_ENDPOINT`，不将值发送到聊天或写入文档。
2. 启动 NestJS 与 React 开发环境并登录 StoryForgeAI。
3. 从作品库打开“ArkClaw 验证”，输入“请用一句话介绍你自己”并发送。
4. 页面在 120 秒内显示一段非空回答，浏览器网络请求中不出现 ArkClaw Endpoint、`apikey` 或 `clawId`。
5. 再发送一次问题，确认页面只显示本次回答，且两次请求不共享 `contextId`。

真实问答通过且完整 CI 全绿，才判定本功能验收通过。任何 Git 提交前再次执行 `pnpm run ci`。

## 九、风险与回滚

| 风险 | 控制方式 | 回滚方式 |
| --- | --- | --- |
| Endpoint 泄露 | 仅服务端持有，错误与日志脱敏 | 立即在 ArkClaw 控制台轮换凭据 |
| 同步请求长时间占用 | 120 秒超时，页面禁重，不自动重试 | 移除路由与模块注册 |
| 上游响应结构变化 | 严格提取与异常测试 | 停用页面入口，不影响其他模块 |
| 影响现有创作链路 | 独立模块，不注册为现有 Provider | 删除独立模块与页面即可回滚 |

本功能不修改数据库，回滚无需数据迁移或历史数据修复。

## 十、关联文件

以下为实施计划的变更边界，文件名用于定位，不代表本设计阶段已经修改：

| 文件或目录 | 计划职责 |
| --- | --- |
| `packages/contracts/src/arkclaw.ts` | 问答请求与响应契约 |
| `packages/contracts/src/index.ts` | 导出共享契约 |
| `apps/api/src/arkclaw/` | 独立控制器、服务、模块与测试 |
| `apps/api/src/config/env.ts` | 可选 Endpoint 配置 |
| `apps/api/src/app.module.ts` | 注册独立模块 |
| `apps/web/src/arkclaw/` | 独立页面、客户端、样式与测试 |
| `apps/web/src/app.tsx` | 注册懒加载路由 |
| `apps/web/src/works/works-page.tsx` | 增加验证入口 |
| `.env.example` | 登记配置变量占位说明 |

实施时不得修改现有 `AiModelProvider`、`PlotModelProvider`、F11 通道或任何角色、正文、剧情写回逻辑。

## 十一、参考来源

- 火山引擎：《[ArkClaw A2A 接口集成基础调用说明](https://docs.volcengine.com/docs/arkclaw/arkclaw-a2a-api-integration-basic-calls?lang=zh)》，访问日期：2026-11-21
- 火山引擎：《[ArkClaw A2A 接口集成与 Session 多轮会话最佳实践](https://docs.volcengine.com/docs/ArkClaw/2563047?lang=zh)》，访问日期：2026-11-21
- 火山引擎：《[管理 ArkClaw 实例——设置 Webhook](https://www.volcengine.com/docs/87732/2545152?lang=zh)》，访问日期：2026-11-21

## 十二、评审记录

| 日期 | 评审人 | 结论 |
| --- | --- | --- |
| 2026-11-21 | 用户 | 已确认口头设计草案与书面设计，批准制定实施计划 |
| 2026-11-21 | 实施 | 实施验收暂停：完整 CI 门禁因无关既有改动失败（`apps/web/src/agent/agent-panel.tsx` 的 `PLATFORM_LABEL` 缺少 `flowise` 键，系另一 F11/Agent 多平台开发将 `AgentPlatform` 扩为 mock/coze/flowise 所致，非 ArkClaw 引入，ArkClaw 计划禁止修改 Agent/F11 代码）。ArkClaw 自身 API 18/18、Web 7/7 测试及类型检查均通过。待无关改动方修复后恢复验收。 |
