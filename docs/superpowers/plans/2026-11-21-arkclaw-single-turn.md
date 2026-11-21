# ArkClaw 独立单轮问答实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新版 React/NestJS 工作区交付登录作者可用的 ArkClaw 独立单轮文本问答验证页，浏览器只访问同源后端，并完成 Mock 自动化测试与真实实例验收。

**Architecture:** 共享 Zod 契约定义输入输出；独立 NestJS 模块使用 Node.js 22 原生 `fetch` 调用 ArkClaw A2A `message/send`，完成 120 秒超时、严格结果提取和固定脱敏错误；React 独立页面复用现有 `apiRequest`、Session/CSRF、路由和响应包装，不接入数据库、BullMQ、Agent 配置或现有 AI Provider。

**Tech Stack:** Node.js 22.16.0、pnpm 10.12.4、TypeScript、Zod 3、NestJS 11、React 19、React Router、Vitest、Testing Library、Supertest。

---

## 一、执行约束与文件地图

### 1.1 执行约束

- 唯一需求来源为 `docs/superpowers/specs/2026-11-21-arkclaw-single-turn-design.md`；实施中不得扩大为多轮、流式、历史保存、实例管理或创作业务接入。
- 每项任务开始前先运行 `skill-router`，再按其路由使用 `test-driven-development`；严格完成“失败测试 → 最小实现 → 通过测试”后再进入下一项任务。
- 工作区已有 Flask、旧 UI、测试和文档改动；不得覆盖、回滚或暂存本计划之外的文件。
- 自动化测试不得访问真实 ArkClaw。真实 Endpoint 只能由部署者写入服务端 `.env`，不得粘贴到聊天、源码、测试、日志或文档。
- 下列提交步骤仅在用户明确要求 Git 提交时执行；每次提交前都必须重新运行完整 `pnpm run ci`，且只暂存当次列出的文件。未获提交要求时，执行到测试通过即停止该任务。
- 不新增 npm 依赖，不修改 `AiModelProvider`、`PlotModelProvider`、F11、角色、正文、剧情或知识库代码。

### 1.2 文件职责

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `packages/contracts/src/arkclaw.ts` | 新建 | 问题与回答的共享 Zod 契约 |
| `packages/contracts/src/arkclaw.test.ts` | 新建 | 契约边界测试 |
| `packages/contracts/src/index.ts` | 修改 | 导出 ArkClaw 契约 |
| `apps/api/src/arkclaw/arkclaw.service.ts` | 新建 | A2A 请求、超时、响应提取和脱敏异常 |
| `apps/api/src/arkclaw/arkclaw.service.test.ts` | 新建 | 全 Mock 的上游交互测试 |
| `apps/api/src/arkclaw/arkclaw.controller.ts` | 新建 | 同源问答接口、鉴权与响应包装 |
| `apps/api/src/arkclaw/arkclaw.module.ts` | 新建 | 独立模块组装及生产配置注入 |
| `apps/api/test/arkclaw.e2e-spec.ts` | 新建 | Session、CSRF、校验、状态码与 envelope 测试 |
| `apps/api/src/config/env.ts` | 修改 | 可选服务端 Endpoint 配置 |
| `apps/api/src/app.module.ts` | 修改 | 注册 ArkClaw 模块 |
| `apps/web/src/arkclaw/arkclaw-client.ts` | 新建 | 同源 API 客户端 |
| `apps/web/src/arkclaw/arkclaw-client.test.ts` | 新建 | 请求路径、CSRF 和响应解析测试 |
| `apps/web/src/arkclaw/arkclaw-page.tsx` | 新建 | 单轮问答页面状态与交互 |
| `apps/web/src/arkclaw/arkclaw-page.test.tsx` | 新建 | 禁重、替换、失败保留和返回测试 |
| `apps/web/src/arkclaw/arkclaw-page.css` | 新建 | 响应式布局与纯文本回答样式 |
| `apps/web/src/app.tsx`、`apps/web/src/app.test.tsx` | 修改 | 懒加载独立路由及测试 |
| `apps/web/src/works/works-page.tsx`、`apps/web/src/works/works-page.test.tsx` | 修改 | 作品库入口及测试 |
| `.env.example` | 修改 | 仅登记配置变量名和用途 |

## 二、实施任务

### Task 1: 建立共享问答契约

**Files:**
- Create: `packages/contracts/src/arkclaw.ts`
- Create: `packages/contracts/src/arkclaw.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [x] **Step 1: 写契约失败测试**

创建 `packages/contracts/src/arkclaw.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { arkClawChatRequestSchema, arkClawChatResponseSchema } from './arkclaw';

describe('ArkClaw chat contracts', () => {
  it('trims a valid message and enforces the 1–4000 character boundary', () => {
    expect(arkClawChatRequestSchema.parse({ message: '  请介绍自己  ' })).toEqual({ message: '请介绍自己' });
    expect(arkClawChatRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(arkClawChatRequestSchema.safeParse({ message: '问'.repeat(4000) }).success).toBe(true);
    expect(arkClawChatRequestSchema.safeParse({ message: '问'.repeat(4001) }).success).toBe(false);
  });

  it('accepts only a non-blank answer object', () => {
    expect(arkClawChatResponseSchema.parse({ answer: '第一段\n第二段' })).toEqual({ answer: '第一段\n第二段' });
    expect(arkClawChatResponseSchema.safeParse({ answer: '   ' }).success).toBe(false);
    expect(arkClawChatResponseSchema.safeParse({ answer: '有效', extra: true }).success).toBe(false);
  });
});
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `pnpm --filter @storyforge/contracts exec vitest run src/arkclaw.test.ts`

Expected: FAIL，提示无法解析 `./arkclaw`。

- [x] **Step 3: 写最小契约并导出**

创建 `packages/contracts/src/arkclaw.ts`：

```ts
import { z } from 'zod';

export const arkClawChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000)
}).strict();

export const arkClawChatResponseSchema = z.object({
  answer: z.string().refine((value) => value.trim().length > 0)
}).strict();

export type ArkClawChatRequest = z.infer<typeof arkClawChatRequestSchema>;
export type ArkClawChatResponse = z.infer<typeof arkClawChatResponseSchema>;
```

在 `packages/contracts/src/index.ts` 末尾追加：

```ts
export * from './arkclaw';
```

- [x] **Step 4: 运行契约测试与构建**

Run: `pnpm --filter @storyforge/contracts exec vitest run src/arkclaw.test.ts`
Then: 测试通过后运行 `pnpm --filter @storyforge/contracts build`

Expected: 2 个测试 PASS，TypeScript 构建成功，`dist/arkclaw.js` 与声明文件生成。

- [ ] **Step 5: 仅在用户要求时提交**

Run: `pnpm run ci`，通过后再执行：

```bash
git add packages/contracts/src/arkclaw.ts packages/contracts/src/arkclaw.test.ts packages/contracts/src/index.ts
git commit -m "feat: add ArkClaw chat contracts"
```

### Task 2: 实现 ArkClaw A2A 服务端适配器

**Files:**
- Create: `apps/api/src/arkclaw/arkclaw.service.ts`
- Create: `apps/api/src/arkclaw/arkclaw.service.test.ts`

- [x] **Step 1: 写 A2A 映射与异常失败测试**

创建 `apps/api/src/arkclaw/arkclaw.service.test.ts`：

```ts
import { HttpException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArkClawService } from './arkclaw.service';

const endpoint = 'https://arkclaw.invalid/a2a/jsonrpc?apikey=fake-key&clawId=fake-claw';

function completed(parts: unknown[] = [{ kind: 'text', text: '完整回答' }]) {
  return {
    jsonrpc: '2.0', id: 'upstream-1',
    result: { kind: 'task', status: { state: 'completed', message: { parts } } }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function capture(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('Expected an HttpException');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ArkClawService', () => {
  it('sends message/send without contextId and joins only text parts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completed([
      { kind: 'text', text: '第一段\n' }, { kind: 'file', url: 'https://files.invalid/a' }, { kind: 'text', text: '第二段' }
    ])));
    const service = new ArkClawService(endpoint, fetchMock);

    await expect(service.chat('请介绍自己')).resolves.toEqual({ answer: '第一段\n第二段' });
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(calledUrl).toBe(endpoint);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(body).toEqual({
      jsonrpc: '2.0', id: expect.any(String), method: 'message/send',
      params: { message: { parts: [{ kind: 'text', text: '请介绍自己' }], messageId: expect.any(String), role: 'user' } }
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.params.message.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.id).not.toBe(body.params.message.messageId);
    expect(body.params.message).not.toHaveProperty('contextId');
  });

  it('returns 503 without fetching when the endpoint is absent', async () => {
    const fetchMock = vi.fn();
    const error = await capture(new ArkClawService(undefined, fetchMock).chat('问题'));
    expect(error.getStatus()).toBe(503);
    expect(error.message).toBe('ArkClaw 服务尚未配置');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream HTTP failures to a fixed 502 without leaking the endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ secret: 'must-not-leak' }, 401));
    const error = await capture(new ArkClawService(endpoint, fetchMock).chat('问题'));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toBe('ArkClaw 调用失败');
    expect(error.message).not.toContain('fake-key');
  });

  it('maps network failures to 502', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(`fetch failed: ${endpoint}`));
    const error = await capture(new ArkClawService(endpoint, fetchMock).chat('问题'));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toBe('ArkClaw 连接失败，请稍后手动重试');
  });

  it.each([
    { jsonrpc: '2.0', id: '1', error: { code: -1, message: 'secret upstream error' } },
    { ...completed(), error: { code: -1, message: 'result and error must be mutually exclusive' } },
    { result: { kind: 'task', status: { state: 'failed', message: { parts: [{ kind: 'text', text: '失败' }] } } } },
    completed([{ kind: 'file', url: 'https://files.invalid/a' }]),
    completed([{ kind: 'text', text: '   ' }]),
    null
  ])('rejects invalid, failed, or textless upstream payloads with 502', async (payload) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    const error = await capture(new ArkClawService(endpoint, fetchMock).chat('问题'));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toBe('ArkClaw 返回了无效响应');
  });

  it('maps malformed JSON to an invalid-response 502', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{bad json', { status: 200 }));
    const error = await capture(new ArkClawService(endpoint, fetchMock).chat('问题'));
    expect(error.getStatus()).toBe(502);
    expect(error.message).toBe('ArkClaw 返回了无效响应');
  });

  it('aborts at the configured timeout and returns 504', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = capture(new ArkClawService(endpoint, fetchMock, 1000).chat('问题'));
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;
    expect(error.getStatus()).toBe(504);
    expect(error.message).toBe('ArkClaw 调用超时，请稍后手动重试');
  });
});
```

- [x] **Step 2: 运行测试并确认服务不存在**

Run: `pnpm --filter @storyforge/api exec vitest run src/arkclaw/arkclaw.service.test.ts`

Expected: FAIL，提示无法解析 `./arkclaw.service`。

- [x] **Step 3: 写最小 A2A 服务实现**

创建 `apps/api/src/arkclaw/arkclaw.service.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { BadGatewayException, GatewayTimeoutException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ArkClawChatResponse } from '@storyforge/contracts';
import { z } from 'zod';

const a2aTaskResponseSchema = z.object({
  result: z.object({
    kind: z.literal('task'),
    status: z.object({
      state: z.literal('completed'),
      message: z.object({
        parts: z.array(z.object({ kind: z.string(), text: z.string().optional() }).passthrough())
      }).passthrough()
    }).passthrough()
  }).passthrough(),
  error: z.never().optional()
}).passthrough();

@Injectable()
export class ArkClawService {
  constructor(
    private readonly endpoint: string | undefined,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 120_000
  ) {}

  async chat(message: string): Promise<ArkClawChatResponse> {
    if (!this.endpoint) throw new ServiceUnavailableException('ArkClaw 服务尚未配置');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: randomUUID(),
            method: 'message/send',
            params: {
              message: {
                parts: [{ kind: 'text', text: message }],
                messageId: randomUUID(),
                role: 'user'
              }
            }
          }),
          signal: controller.signal
        });
      } catch {
        if (controller.signal.aborted) throw new GatewayTimeoutException('ArkClaw 调用超时，请稍后手动重试');
        throw new BadGatewayException('ArkClaw 连接失败，请稍后手动重试');
      }

      if (!response.ok) throw new BadGatewayException('ArkClaw 调用失败');

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw new GatewayTimeoutException('ArkClaw 调用超时，请稍后手动重试');
        throw new BadGatewayException('ArkClaw 返回了无效响应');
      }

      const parsed = a2aTaskResponseSchema.safeParse(payload);
      if (!parsed.success) throw new BadGatewayException('ArkClaw 返回了无效响应');
      const answer = parsed.data.result.status.message.parts
        .filter((part) => part.kind === 'text')
        .map((part) => part.text ?? '')
        .join('');
      if (!answer.trim()) throw new BadGatewayException('ArkClaw 返回了无效响应');
      return { answer };
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

- [x] **Step 4: 运行服务测试与类型检查**

Run: `pnpm --filter @storyforge/api exec vitest run src/arkclaw/arkclaw.service.test.ts`
Then: 测试通过后运行 `pnpm --filter @storyforge/api typecheck`

Expected: 所有服务测试 PASS，类型检查成功；测试运行期间无真实网络访问。

- [ ] **Step 5: 仅在用户要求时提交**

Run: `pnpm run ci`，通过后再执行：

```bash
git add apps/api/src/arkclaw/arkclaw.service.ts apps/api/src/arkclaw/arkclaw.service.test.ts
git commit -m "feat: add ArkClaw A2A server adapter"
```

### Task 3: 注册 NestJS 接口与可选配置

**Files:**
- Create: `apps/api/src/arkclaw/arkclaw.controller.ts`
- Create: `apps/api/src/arkclaw/arkclaw.module.ts`
- Create: `apps/api/test/arkclaw.e2e-spec.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/app.module.ts`

- [x] **Step 1: 写接口失败测试**

创建 `apps/api/test/arkclaw.e2e-spec.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Author } from '@storyforge/contracts';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { ArkClawController } from '../src/arkclaw/arkclaw.controller';
import { ArkClawService } from '../src/arkclaw/arkclaw.service';
import { AuthService } from '../src/auth/auth.service';
import { CsrfGuard } from '../src/auth/csrf.guard';
import { SessionGuard } from '../src/auth/session.guard';
import { RequestIdMiddleware } from '../src/common/request-id.middleware';

const author: Author = { id: randomUUID(), email: 'author@example.com', display_name: 'Author' };
const chat = vi.fn();
const validate = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ArkClawController],
    providers: [
      { provide: ArkClawService, useValue: { chat } },
      { provide: AuthService, useValue: { validate } },
      SessionGuard,
      CsrfGuard
    ]
  }).compile();
  app = module.createNestApplication();
  const requestId = new RequestIdMiddleware();
  app.use(requestId.use.bind(requestId));
  configureApp(app);
  await app.init();
});

afterAll(async () => app.close());

beforeEach(() => {
  chat.mockReset();
  validate.mockReset().mockResolvedValue(author);
});

function authorizedPost() {
  return request(app.getHttpServer())
    .post('/api/v1/arkclaw/chat')
    .set('Cookie', ['storyforge_session=session', 'storyforge_csrf=csrf'])
    .set('x-csrf-token', 'csrf');
}

describe('ArkClaw chat endpoint', () => {
  it('requires Session and CSRF before calling the service', async () => {
    await request(app.getHttpServer()).post('/api/v1/arkclaw/chat').send({ message: '问题' }).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/arkclaw/chat')
      .set('Cookie', ['storyforge_session=session', 'storyforge_csrf=csrf'])
      .send({ message: '问题' })
      .expect(403);
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns field errors for a blank message without calling the service', async () => {
    const response = await authorizedPost().send({ message: '   ' }).expect(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.field_errors.message).toBeDefined();
    expect(chat).not.toHaveBeenCalled();
  });

  it('trims input and wraps the answer with the response request id', async () => {
    chat.mockResolvedValue({ answer: '完整回答' });
    const response = await authorizedPost().send({ message: '  请介绍自己  ' }).expect(200);
    expect(chat).toHaveBeenCalledWith('请介绍自己');
    expect(response.body).toEqual({
      data: { answer: '完整回答' },
      request_id: response.headers['x-request-id']
    });
  });

  it.each([
    { exception: new ServiceUnavailableException('ArkClaw 服务尚未配置'), status: 503 },
    { exception: new BadGatewayException('ArkClaw 调用失败'), status: 502 },
    { exception: new GatewayTimeoutException('ArkClaw 调用超时，请稍后手动重试'), status: 504 }
  ])('preserves only fixed service errors with the expected status', async ({ exception, status }) => {
    chat.mockRejectedValue(exception);
    const response = await authorizedPost().send({ message: '问题' }).expect(status);
    expect(response.body.error.message).toBe(exception.message);
    expect(JSON.stringify(response.body)).not.toContain('fake-key');
    expect(JSON.stringify(response.body)).not.toContain('clawId=');
  });
});
```

- [x] **Step 2: 运行测试并确认控制器不存在**

Run: `pnpm --filter @storyforge/api exec vitest run test/arkclaw.e2e-spec.ts`

Expected: FAIL，提示无法解析 `arkclaw.controller`。

- [x] **Step 3: 写控制器、模块和配置**

创建 `apps/api/src/arkclaw/arkclaw.controller.ts`：

```ts
import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { arkClawChatRequestSchema, type ArkClawChatRequest, type ArkClawChatResponse } from '@storyforge/contracts';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest, type SuccessEnvelope } from '../common/http';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ArkClawService } from './arkclaw.service';

@Controller('arkclaw')
@UseGuards(SessionGuard)
export class ArkClawController {
  constructor(@Inject(ArkClawService) private readonly arkClaw: ArkClawService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async chat(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(arkClawChatRequestSchema)) input: ArkClawChatRequest
  ): Promise<SuccessEnvelope<ArkClawChatResponse>> {
    return ok(request, await this.arkClaw.chat(input.message));
  }
}
```

创建 `apps/api/src/arkclaw/arkclaw.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { env } from '../config/env';
import { ArkClawController } from './arkclaw.controller';
import { ArkClawService } from './arkclaw.service';

@Module({
  imports: [AuthModule],
  controllers: [ArkClawController],
  providers: [{
    provide: ArkClawService,
    useFactory: () => new ArkClawService(env.ARKCLAW_A2A_ENDPOINT)
  }]
})
export class ArkClawModule {}
```

在 `apps/api/src/config/env.ts` 的 `SESSION_TTL_SECONDS` 后追加字段，保留尾随逗号风格与现有格式一致：

```ts
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(2_592_000).default(604_800),
  ARKCLAW_A2A_ENDPOINT: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional()
  )
```

在 `apps/api/src/app.module.ts` 添加导入并把 `ArkClawModule` 加到 `imports` 数组末尾：

```ts
import { ArkClawModule } from './arkclaw/arkclaw.module';
```

```ts
imports: [TypeOrmModule.forRoot({ ...AppDataSource.options }), AuthModule, WritingModule, RevisionModule, AiTaskModule, AgentModule, PlotModule, CharacterModule, ArkClawModule],
```

- [x] **Step 4: 运行接口、服务测试与类型检查**

Run: `pnpm --filter @storyforge/api exec vitest run test/arkclaw.e2e-spec.ts src/arkclaw/arkclaw.service.test.ts`
Then: 测试通过后运行 `pnpm --filter @storyforge/api typecheck`

Expected: 所有 ArkClaw 测试 PASS；401、403、422、200、502、503、504 均符合预期；类型检查成功。

- [ ] **Step 5: 仅在用户要求时提交**

Run: `pnpm run ci`，通过后再执行：

```bash
git add apps/api/src/arkclaw apps/api/test/arkclaw.e2e-spec.ts apps/api/src/config/env.ts apps/api/src/app.module.ts
git commit -m "feat: expose authenticated ArkClaw chat endpoint"
```

### Task 4: 添加浏览器同源客户端

**Files:**
- Create: `apps/web/src/arkclaw/arkclaw-client.ts`
- Create: `apps/web/src/arkclaw/arkclaw-client.test.ts`

- [x] **Step 1: 写客户端失败测试**

创建 `apps/web/src/arkclaw/arkclaw-client.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { sendArkClawMessage } from './arkclaw-client';

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'storyforge_csrf=; Max-Age=0';
});

describe('sendArkClawMessage', () => {
  it('posts trimmed input only to the same-origin API with cookies and CSRF', async () => {
    document.cookie = 'storyforge_csrf=csrf-token';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { answer: '完整回答' }, request_id: 'req-1'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendArkClawMessage('  请介绍自己  ')).resolves.toEqual({ answer: '完整回答' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/arkclaw/chat', expect.objectContaining({
      method: 'POST', credentials: 'include', body: JSON.stringify({ message: '请介绍自己' })
    }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('apikey');
    expect(url).not.toContain('clawId');
    expect(init.headers).toMatchObject({ 'x-csrf-token': 'csrf-token' });
  });

  it('preserves structured API failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'INTERNAL_ERROR', message: 'ArkClaw 服务尚未配置' }, request_id: 'req-2'
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })));

    const pending = sendArkClawMessage('问题');
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({ status: 503, message: 'ArkClaw 服务尚未配置', requestId: 'req-2' });
  });
});
```

- [x] **Step 2: 运行测试并确认客户端不存在**

Run: `pnpm --filter @storyforge/web exec vitest run src/arkclaw/arkclaw-client.test.ts`

Expected: FAIL，提示无法解析 `./arkclaw-client`。

- [x] **Step 3: 写同源客户端**

创建 `apps/web/src/arkclaw/arkclaw-client.ts`：

```ts
import {
  arkClawChatRequestSchema,
  arkClawChatResponseSchema,
  type ArkClawChatResponse
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

export function sendArkClawMessage(message: string): Promise<ArkClawChatResponse> {
  const input = arkClawChatRequestSchema.parse({ message });
  return apiRequest('/api/v1/arkclaw/chat', arkClawChatResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}
```

- [x] **Step 4: 运行客户端测试**

Run: `pnpm --filter @storyforge/web exec vitest run src/arkclaw/arkclaw-client.test.ts`

Expected: 2 个测试 PASS，fetch 只收到 `/api/v1/arkclaw/chat`。

- [ ] **Step 5: 仅在用户要求时提交**

Run: `pnpm run ci`，通过后再执行：

```bash
git add apps/web/src/arkclaw/arkclaw-client.ts apps/web/src/arkclaw/arkclaw-client.test.ts
git commit -m "feat: add same-origin ArkClaw web client"
```

### Task 5: 实现独立单轮问答页面

**Files:**
- Create: `apps/web/src/arkclaw/arkclaw-page.tsx`
- Create: `apps/web/src/arkclaw/arkclaw-page.test.tsx`
- Create: `apps/web/src/arkclaw/arkclaw-page.css`

- [x] **Step 1: 写页面交互失败测试**

创建 `apps/web/src/arkclaw/arkclaw-page.test.tsx`：

```tsx
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { sendArkClawMessage } from './arkclaw-client';
import { ArkClawPage } from './arkclaw-page';

vi.mock('./arkclaw-client', () => ({ sendArkClawMessage: vi.fn() }));

function renderPage() {
  return render(<MemoryRouter initialEntries={['/arkclaw']}><Routes>
    <Route path="/arkclaw" element={<ArkClawPage />} />
    <Route path="/works" element={<p>作品库页面</p>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => vi.mocked(sendArkClawMessage).mockReset());

describe('ArkClawPage', () => {
  it('rejects blank input without calling the API', async () => {
    renderPage();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(sendArkClawMessage).not.toHaveBeenCalled();
  });

  it('disables input and duplicate submission while pending', async () => {
    let finish!: (value: { answer: string }) => void;
    vi.mocked(sendArkClawMessage).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPage();
    await userEvent.type(screen.getByLabelText('问题'), '请介绍自己');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled();
    expect(screen.getByLabelText('问题')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '发送中…' }));
    expect(sendArkClawMessage).toHaveBeenCalledTimes(1);
    await act(async () => finish({ answer: '完整回答' }));
    expect(await screen.findByText('完整回答')).toBeVisible();
    expect(screen.getByLabelText('问题')).toBeEnabled();
  });

  it('replaces the previous answer on a new successful question', async () => {
    vi.mocked(sendArkClawMessage)
      .mockResolvedValueOnce({ answer: '第一次回答' })
      .mockResolvedValueOnce({ answer: '第二次回答' });
    renderPage();
    const input = screen.getByLabelText('问题');
    await userEvent.type(input, '第一问');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('第一次回答')).toBeVisible();

    await userEvent.clear(input);
    await userEvent.type(input, '第二问');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('第二次回答')).toBeVisible();
    expect(screen.queryByText('第一次回答')).not.toBeInTheDocument();
  });

  it('shows a sanitized error and preserves the current input after failure', async () => {
    vi.mocked(sendArkClawMessage).mockRejectedValue(new ApiError(
      503, 'INTERNAL_ERROR', 'ArkClaw 服务尚未配置', {}, 'req-1'
    ));
    renderPage();
    const input = screen.getByLabelText('问题');
    await userEvent.type(input, '保留这个问题');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ArkClaw 服务尚未配置');
    expect(input).toHaveValue('保留这个问题');
  });

  it('returns to the works library', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: '返回作品库' }));
    expect(await screen.findByText('作品库页面')).toBeVisible();
  });
});
```

- [x] **Step 2: 运行测试并确认页面不存在**

Run: `pnpm --filter @storyforge/web exec vitest run src/arkclaw/arkclaw-page.test.tsx`

Expected: FAIL，提示无法解析 `./arkclaw-page`。

- [x] **Step 3: 写页面和响应式样式**

创建 `apps/web/src/arkclaw/arkclaw-page.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { sendArkClawMessage } from './arkclaw-client';
import './arkclaw-page.css';

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.status === 403 ? '请求校验失败，请刷新页面后重试' : cause.message;
  }
  return 'ArkClaw 连接失败，请稍后手动重试';
}

export function ArkClawPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = message.trim();
    if (pending || !normalized) return;
    if (normalized.length > 4000) {
      setError('问题不能超过 4000 字');
      return;
    }

    setPending(true);
    setAnswer('');
    setError('');
    try {
      setAnswer((await sendArkClawMessage(normalized)).answer);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return <main className="arkclaw-page">
    <button type="button" className="arkclaw-back" onClick={() => navigate('/works')}>返回作品库</button>
    <h1>ArkClaw 对话验证</h1>
    <p className="arkclaw-boundary">单轮问答，不保存历史；每次提问都是独立会话。</p>
    <form className="arkclaw-form" onSubmit={submit}>
      <label htmlFor="arkclaw-message">问题</label>
      <textarea
        id="arkclaw-message"
        required
        maxLength={4000}
        disabled={pending}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="请输入一个问题"
      />
      <span className="arkclaw-count">{message.length}/4000</span>
      <button type="submit" disabled={pending || !message.trim()}>{pending ? '发送中…' : '发送'}</button>
    </form>
    {error && <p role="alert" className="arkclaw-error">{error}</p>}
    <section aria-labelledby="arkclaw-answer-title" className="arkclaw-answer-section">
      <h2 id="arkclaw-answer-title">回答</h2>
      {pending && <p role="status">正在等待 ArkClaw 完整回答，最长 120 秒</p>}
      {!pending && answer && <p className="arkclaw-answer">{answer}</p>}
      {!pending && !answer && <p className="arkclaw-empty">尚未获得回答</p>}
    </section>
  </main>;
}
```

创建 `apps/web/src/arkclaw/arkclaw-page.css`：

```css
.arkclaw-page {
  width: calc(100% - var(--sp-4) - var(--sp-4));
  max-width: 960px;
  margin: 0 auto;
  padding: var(--sp-4) 0;
  color: var(--text-primary);
}
.arkclaw-page h1 { margin: var(--sp-3) 0 var(--sp-2); font-size: var(--fs-h2); }
.arkclaw-boundary, .arkclaw-empty, .arkclaw-count { color: var(--text-secondary); }
.arkclaw-back, .arkclaw-form button {
  min-height: 36px;
  padding: var(--sp-1) var(--sp-3);
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font: inherit;
}
.arkclaw-form { display: flex; flex-direction: column; align-items: stretch; gap: var(--sp-2); }
.arkclaw-form textarea {
  width: 100%;
  min-height: 160px;
  box-sizing: border-box;
  resize: vertical;
  padding: var(--sp-2);
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font: inherit;
}
.arkclaw-form button { align-self: flex-start; }
.arkclaw-form button:disabled { opacity: 0.5; cursor: not-allowed; }
.arkclaw-count { align-self: flex-end; font-size: var(--fs-small); }
.arkclaw-error { color: var(--danger-600, #b91c1c); }
.arkclaw-answer-section { margin-top: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
.arkclaw-answer-section h2 { font-size: var(--fs-h3); }
.arkclaw-answer { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
@media (max-width: 480px) {
  .arkclaw-page { width: calc(100% - var(--sp-3) - var(--sp-3)); padding-top: var(--sp-3); }
  .arkclaw-form textarea { min-height: 144px; }
}
```

- [x] **Step 4: 运行页面与客户端测试及类型检查**

Run: `pnpm --filter @storyforge/web exec vitest run src/arkclaw`
Then: 测试通过后运行 `pnpm --filter @storyforge/web typecheck`

Expected: 页面 5 个测试与客户端 2 个测试全部 PASS，类型检查成功；代码中没有 `dangerouslySetInnerHTML`。

- [ ] **Step 5: 仅在用户要求时提交**

Run: `pnpm run ci`，通过后再执行：

```bash
git add apps/web/src/arkclaw
git commit -m "feat: add ArkClaw single-turn chat page"
```

### Task 6: 接入懒加载路由与作品库入口

**Files:**
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `apps/web/src/works/works-page.tsx`
- Modify: `apps/web/src/works/works-page.test.tsx`

- [x] **Step 1: 先增加路由和入口失败测试**

在 `apps/web/src/app.test.tsx` 的 mock 区追加：

```tsx
vi.mock('./arkclaw/arkclaw-page', () => ({ ArkClawPage: () => <p>ArkClaw 验证页面</p> }));
```

将现有 `vi.mock('./auth/auth-client', ...)` 替换为：

```tsx
vi.mock('./auth/auth-client', () => ({ getSession: vi.fn(), login: vi.fn(), logout: vi.fn() }));
```

在测试文件中增加：

```tsx
beforeEach(() => {
  window.history.pushState({}, '', '/works');
  vi.mocked(getSession).mockReset();
});

it('loads the lazy ArkClaw route for an authenticated author', async () => {
  window.history.pushState({}, '', '/arkclaw');
  vi.mocked(getSession).mockResolvedValue(session);
  render(<App />);

  expect(await screen.findByText('ArkClaw 验证页面')).toBeInTheDocument();
});
```

在 `apps/web/src/works/works-page.test.tsx` 的 `renderPage()` 路由中追加：

```tsx
    <Route path="/arkclaw" element={<div>ArkClaw 验证页面</div>} />
```

在 `describe('WorksPage')` 中追加：

```tsx
  it('opens the ArkClaw verification page from the works library', async () => {
    renderPage();
    expect(await screen.findByText('既有作品')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'ArkClaw 验证' }));
    expect(await screen.findByText('ArkClaw 验证页面')).toBeVisible();
  });
```

- [x] **Step 2: 运行测试并确认新路由和入口失败**

Run: `pnpm --filter @storyforge/web exec vitest run src/app.test.tsx src/works/works-page.test.tsx`

Expected: 新增 2 个测试 FAIL，分别找不到 ArkClaw 页面与入口按钮；已有测试保持通过。

- [x] **Step 3: 注册路由和入口**

在 `apps/web/src/app.tsx` 的懒加载声明后追加：

```tsx
const ArkClawPage = lazy(() => import('./arkclaw/arkclaw-page').then((mod) => ({ default: mod.ArkClawPage })));
```

在 `/works` 路由后追加：

```tsx
      <Route path="/arkclaw" element={<Suspense fallback={<p role="status">正在加载 ArkClaw 验证页</p>}><ArkClawPage /></Suspense>} />
```

在 `apps/web/src/works/works-page.tsx` 的“新建作品”按钮后追加：

```tsx
      <button type="button" onClick={() => navigate('/arkclaw')}>ArkClaw 验证</button>
```

- [x] **Step 4: 运行路由、入口和 ArkClaw 页面回归**

Run: `pnpm --filter @storyforge/web exec vitest run src/app.test.tsx src/works/works-page.test.tsx src/arkclaw`
Then: 测试通过后运行 `pnpm --filter @storyforge/web typecheck`

Expected: 所有指定测试 PASS，类型检查成功。

- [ ] **Step 5: 仅在用户要求时提交**

Run: `pnpm run ci`，通过后再执行：

```bash
git add apps/web/src/app.tsx apps/web/src/app.test.tsx apps/web/src/works/works-page.tsx apps/web/src/works/works-page.test.tsx
git commit -m "feat: link ArkClaw verification page from works"
```

### Task 7: 登记配置并完成全量与真实实例验收

**Files:**
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-11-21-arkclaw-single-turn-design.md`（仅在全部验收通过后更新状态与评审记录）

- [x] **Step 1: 登记不含凭据的配置示例**

在 `.env.example` 末尾追加：

```dotenv
# 可选：ArkClaw A2A Webhook 完整 Endpoint，仅配置在服务端；未配置时问答接口返回 503。
# ARKCLAW_A2A_ENDPOINT=
```

确认 `.env` 已被 `.gitignore` 排除，真实值只由部署者写入服务端 `.env`，不在终端命令、聊天或文档中展开。

- [ ] **Step 2: 运行完整 CI 门禁**（暂停，等待无关改动方修复）

Run: `pnpm run ci` → 失败（exit 2），lint 阶段即失败：

```
apps/web lint: src/agent/agent-panel.tsx(8,7): error TS2741: Property 'flowise' is missing in type '{ mock: string; coze: string; }' but required in type 'Record<"mock" | "coze" | "flowise", string>'.
```

判定：该失败**非 ArkClaw 引入**。`packages/contracts/src/agent-config.ts` 于 2026-11-21 14:41 被无关改动（F11/Agent 多平台开发）将 `agentPlatformSchema` 扩为 `['mock','coze','flowise']`，而 `apps/web/src/agent/agent-panel.tsx`（2026-11-20 未改动）的 `PLATFORM_LABEL` 仍只有 mock/coze。ArkClaw 计划禁止修改 Agent/F11 代码，故按规则暂停验收、不掩盖。ArkClaw 自身已单独验证：API 18/18、Web 7/7 测试及类型检查全绿。待无关改动方修复 `agent-panel.tsx` 后恢复本步骤。

Expected: contracts 构建、全部 lint、typecheck、Node/Vitest 测试和生产构建全部 PASS；ArkClaw 自动化测试无真实网络访问。若出现失败，只修复本次功能引入的问题；已有失败须记录原始输出并暂停验收，不得通过修改无关业务来掩盖。

- [ ] **Step 3: 检查变更边界与敏感信息**

Run: `git status --short` 与 `git diff --check`

Expected: 无空白错误；本功能只出现计划内文件，已有无关改动保持原状。人工检查本次 diff，不得包含真实 Endpoint、API Key、`clawId` 值、`.env` 或真实问答内容；前端只出现同源 `/api/v1/arkclaw/chat`。

- [ ] **Step 4: 启动本地新版工作区**

部署者先在服务端 `.env` 私密配置真实 `ARKCLAW_A2A_ENDPOINT`，再分别在两个终端运行：

```bash
pnpm --filter @storyforge/api start:dev
```

```bash
pnpm --filter @storyforge/web dev
```

Expected: API 监听 `127.0.0.1:3001`，Web 监听 `127.0.0.1:5173`；启动日志不输出 Endpoint。

- [ ] **Step 5: 执行真实页面问答验收**

1. 登录作者账号，从作品库点击“ArkClaw 验证”。
2. 输入“请用一句话介绍你自己”并发送。
3. 确认发送中输入和按钮禁用，120 秒内显示一段非空完整回答。
4. 再输入一个不同问题并发送，确认只显示第二次回答，第一次回答被替换；结合 Task 2 的请求体测试确认每次调用均不发送 `contextId`，不得为验收增加请求内容日志。
5. 打开浏览器开发者工具网络面板，确认页面只请求 `/api/v1/arkclaw/chat`，没有浏览器到 ArkClaw 域名的请求，请求和响应中均无 Endpoint、`apikey` 或 `clawId`。
6. 分别在 375、768、1024、1440 像素视口检查输入、发送、回答和返回操作，无阻断性横向溢出；仅用键盘完成一次提问与返回。
7. 检查服务端日志，不记录 Endpoint、问题或回答。

Expected: 以上每项均通过；若真实上游失败，记录脱敏 HTTP 状态和页面固定提示，不复制凭据或上游敏感响应。

- [ ] **Step 6: 全部通过后同步现有设计文档**

仅在 CI 与真实验收均通过后，将设计文档头部状态改为“已验收”，并在评审记录追加一行：

```md
| 2026-11-21 | 实施验收 | Mock 自动化测试、完整 CI 与真实 ArkClaw 单轮页面问答均通过；未记录或提交真实凭据 |
```

若任一验收项未通过，保持“已批准”状态并记录待修复项，不得写成已验收。

- [ ] **Step 7: 仅在用户要求时进行最终提交**

文档状态变化后重新运行 `pnpm run ci`，通过后再执行：

```bash
git add .env.example docs/superpowers/specs/2026-11-21-arkclaw-single-turn-design.md docs/superpowers/plans/2026-11-21-arkclaw-single-turn.md
git commit -m "docs: record ArkClaw chat verification"
```

若此前任务尚未提交且用户本次要求一次性提交，应先核对完整 diff，仅暂存本计划全部文件，运行 `pnpm run ci` 后再按功能拆分提交；不得使用 `git add .` 或 `git add -A`。
