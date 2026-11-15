# M0 工程基座实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可重复启动、测试和部署的 React/NestJS Monorepo，交付 PostgreSQL、共享契约、作者会话鉴权、请求错误规范与 CI，为 M1 提供稳定基座。

**Architecture:** 根仓库保留现有 Flask 代码，新增 `apps/web`、`apps/api` 与 `packages/*`，此阶段不切换旧系统写入方。NestJS 使用 TypeORM 管理显式迁移；会话使用数据库保存的令牌摘要，React 仅通过同源 `/api/v1` 访问后端。

**Tech Stack:** Node.js 22.16.0、pnpm 10.12.4、TypeScript 5.8、React 19、Vite 6、NestJS 11、PostgreSQL 16、TypeORM 0.3、Zod 3、Argon2、Vitest、Playwright。

---

## 一、执行约束与文件地图

### 1.1 前置约束

- 在独立工作树和新分支执行，禁止直接在 `main` 上实施。
- 当前机器已发现 Node 与 pnpm 运行时版本不一致；Task 1 未通过前不得安装业务依赖。
- 每个提交步骤前必须运行该任务列出的测试，以及 `python scripts/run_checks.py --path .`；失败时不得提交。pnpm 10 保留了内置 `ci` 子命令，仓内门禁一律写成 `pnpm run ci`，CI 工作流同理。
- 不删除或改写现有 Flask、JSON 数据和旧 UI，不在 M0 开放双写。
- `.env`、数据库数据、Cookie 密钥和作者密码不得进入 Git。

### 1.2 文件职责

| 路径 | 职责 |
| --- | --- |
| `package.json`、`pnpm-workspace.yaml` | 工作区、统一脚本和工具链版本 |
| `packages/contracts/` | 前后端共享 Zod 输入输出契约 |
| `apps/api/src/config/` | 环境变量读取和校验 |
| `apps/api/src/common/` | 请求 ID、错误响应、会话与 CSRF 防护 |
| `apps/api/src/database/` | TypeORM 数据源、实体和迁移 |
| `apps/api/src/auth/` | 密码、会话、登录、退出和当前作者 |
| `apps/web/src/auth/` | 会话 API 和路由守卫 |
| `infra/docker-compose.yml` | 本地 PostgreSQL 16 |
| `.github/workflows/ci.yml` | 新旧系统检查与构建 |

## 二、实施任务

### Task 1: 固定工具链并建立工作区

**Files:**
- Create: `.nvmrc`
- Create: `.npmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tests/node/workspace.test.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: 写工作区失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync('package.json', 'utf8'));

test('workspace pins Node and pnpm', () => {
  assert.equal(root.engines.node, '22.16.0');
  assert.equal(root.packageManager, 'pnpm@10.12.4');
  assert.match(readFileSync('pnpm-workspace.yaml', 'utf8'), /apps\/\*/);
  assert.match(readFileSync('pnpm-workspace.yaml', 'utf8'), /packages\/\*/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/node/workspace.test.mjs`
Expected: FAIL，提示找不到 `package.json`。

- [ ] **Step 3: 写入工具链配置**

`.nvmrc`：

```text
22.16.0
```

`.npmrc`：

```text
engine-strict=true
strict-peer-dependencies=false
```

`package.json`：

```json
{
  "name": "storyforge-ai",
  "private": true,
  "engines": { "node": "22.16.0" },
  "packageManager": "pnpm@10.12.4",
  "scripts": {
    "build": "pnpm -r build",
    "test": "node --test tests/node/*.test.mjs && pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "ci": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "vitest": "^3.2.0"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

在 `.gitignore` 末尾加入：

```text
node_modules/
dist/
coverage/
.playwright/
playwright-report/
test-results/
.env
.env.*
!.env.example
```

- [ ] **Step 4: 对齐工具链并验证**

Run: `nvm use 22.16.0`
Run: `corepack enable`
Run: `corepack prepare pnpm@10.12.4 --activate`
Run: `node --version && pnpm --version`
Expected: 分别输出 `v22.16.0` 与 `10.12.4`，不得再出现 Node 18 的 pnpm 错误。

Run: `pnpm install && node --test tests/node/workspace.test.mjs`
Expected: PASS，生成 `pnpm-lock.yaml`。

- [ ] **Step 5: 提交前执行相关 CI 检查并限定提交边界**

Run: `pnpm run ci`
Expected: 当前已建立的工作区 Lint、类型检查、工作区测试和构建均 PASS。
Run: `python scripts/run_checks.py --path .`
Expected: 输出 `[run_checks] 总计违规 0 条`，退出码为 0。

```bash
git add .nvmrc .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tests/node/workspace.test.mjs .gitignore
git commit -m "build: pin Node workspace toolchain"
```

### Task 2: 建立共享 API 契约

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/api.ts`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.test.ts`
- Create: `vitest.workspace.ts`
- Modify: `package.json`

- [ ] **Step 1: 写契约失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { apiSuccessSchema, loginRequestSchema } from './index';

describe('shared contracts', () => {
  it('rejects invalid login input', () => {
    expect(loginRequestSchema.safeParse({ email: 'bad', password: '' }).success).toBe(false);
  });

  it('validates a success envelope', () => {
    const schema = apiSuccessSchema(loginRequestSchema);
    expect(schema.parse({ data: { email: 'a@example.com', password: '12345678' }, request_id: crypto.randomUUID() }).data.email).toBe('a@example.com');
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run packages/contracts/src/contracts.test.ts`
Expected: FAIL，提示契约模块不存在。

- [ ] **Step 3: 创建契约包**

`packages/contracts/package.json`：

```json
{
  "name": "@storyforge/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "commonjs",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "require": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.25.0" },
  "devDependencies": { "typescript": "^5.8.3", "vitest": "^3.2.0" }
}
```

`packages/contracts/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/contracts/src/api.ts`：

```ts
import { z } from 'zod';

export const requestIdSchema = z.string().uuid();
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR', 'RATE_LIMITED', 'INTERNAL_ERROR', 'UPSTREAM_ERROR']),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional()
  }),
  request_id: requestIdSchema
});

export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, request_id: requestIdSchema });
}

export type ApiError = z.infer<typeof apiErrorSchema>;
```

`packages/contracts/src/auth.ts`：

```ts
import { z } from 'zod';

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128)
});
export const authorSchema = z.object({ id: z.string().uuid(), email: z.string().email(), display_name: z.string().min(1).max(80) });
export const sessionResponseSchema = z.object({ author: authorSchema, csrf_token: z.string().min(32) });
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type Author = z.infer<typeof authorSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
```

`packages/contracts/src/index.ts`：

```ts
export * from './api';
export * from './auth';
```

`vitest.workspace.ts`：

```ts
import { defineWorkspace } from 'vitest/config';
export default defineWorkspace(['packages/*', 'apps/*']);
```

将根 `package.json` 整体替换为以下版本；测试与 CI 均先构建契约产物，保证 API 的 CommonJS 运行时解析、类型声明与 Web 构建使用同一入口：

```json
{
  "name": "storyforge-ai",
  "private": true,
  "engines": { "node": "22.16.0" },
  "packageManager": "pnpm@10.12.4",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm --filter @storyforge/contracts build && node --test tests/node/*.test.mjs && pnpm vitest run",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "ci": "pnpm --filter @storyforge/contracts build && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: 验证契约**

Run: `pnpm install && pnpm vitest run packages/contracts/src/contracts.test.ts && pnpm --filter @storyforge/contracts build`
Expected: 2 个测试通过，TypeScript 无错误，并生成 `packages/contracts/dist/index.js` 与 `packages/contracts/dist/index.d.ts`。

- [ ] **Step 5: 提交前执行相关 CI 检查并限定提交边界**

Run: `pnpm run ci`
Expected: 工作区 Lint、类型检查、契约测试、Node 工具链测试和构建均 PASS。
Run: `python scripts/run_checks.py --path .`
Expected: 输出 `[run_checks] 总计违规 0 条`，退出码为 0。

```bash
git add package.json pnpm-lock.yaml vitest.workspace.ts packages/contracts
git commit -m "feat: add shared API contracts"
```

### Task 3: 建立 NestJS 启动壳和统一 HTTP 契约

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.setup.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/config/env.ts`
- Create: `apps/api/src/common/http.ts`
- Create: `apps/api/src/common/request-id.middleware.ts`
- Create: `apps/api/src/common/http-exception.filter.ts`
- Create: `apps/api/src/health.controller.ts`
- Create: `apps/api/test/http.e2e-spec.ts`

- [ ] **Step 1: 写 HTTP 行为失败测试**

写入 `apps/api/test/http.e2e-spec.ts`：

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { requestIdSchema } from '@storyforge/contracts';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { AppModule } from '../src/app.module';

describe('HTTP envelope', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses one UUID for success, errors and the response header', async () => {
    const missing = await request(app.getHttpServer()).get('/api/v1/missing').expect(404);
    expect(requestIdSchema.parse(missing.body.request_id)).toBe(missing.headers['x-request-id']);
    expect(missing.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Cannot GET /api/v1/missing' },
      request_id: missing.headers['x-request-id']
    });

    const health = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(health.body).toEqual({
      data: { status: 'ok' },
      request_id: health.headers['x-request-id']
    });
    expect(requestIdSchema.safeParse(health.body.request_id).success).toBe(true);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm vitest run apps/api/test/http.e2e-spec.ts`
Expected: FAIL，模块解析错误指出 `../src/app.setup` 或 `../src/app.module` 不存在；此时不得跳过该测试。

- [ ] **Step 3: 写入完整 API 启动壳**

`apps/api/package.json`：

```json
{
  "name": "@storyforge/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "tsx src/main.ts",
    "start:dev": "tsx watch src/main.ts",
    "start:prod": "node dist/main.js"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@storyforge/contracts": "workspace:*",
    "dotenv": "^16.5.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.1",
    "@types/node": "^22.15.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.1.0",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

`apps/api/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`apps/api/tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "test"]
}
```

`apps/api/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
});
```

`apps/api/src/config/env.ts`：

```ts
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';

config({ path: resolve(__dirname, '../../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  WEB_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  DATABASE_URL: z.string().url().startsWith('postgresql://').default('postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().max(2_592_000).default(604_800)
});

export const env = envSchema.parse(process.env);
```

`src/config` 与编译后的 `dist/config` 均通过四级相对路径定位仓库根 `.env`；`dotenv` 默认不覆盖已存在的环境变量，因此 CI 注入值优先。

`apps/api/src/common/http.ts` 固定导出供 M1 复用的请求类型与成功响应 helper：

```ts
import type { Author } from '@storyforge/contracts';
import type { Request } from 'express';

export interface RequestWithId extends Request {
  requestId: string;
}

export interface AuthenticatedRequest extends RequestWithId {
  author: Author;
}

export interface SuccessEnvelope<T> {
  data: T;
  request_id: string;
}

export function ok<T>(request: RequestWithId, data: T): SuccessEnvelope<T> {
  return { data, request_id: request.requestId };
}
```

`apps/api/src/common/request-id.middleware.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { RequestWithId } from './http';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: RequestWithId, response: Response, next: NextFunction): void {
    request.requestId = randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}
```

`apps/api/src/common/http-exception.filter.ts`：

```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@storyforge/contracts';
import type { RequestWithId } from './http';

type ErrorCode = ApiError['error']['code'];

function errorCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'UPSTREAM_ERROR';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'BAD_REQUEST';
}

@Catch()
export class HttpEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<RequestWithId>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : undefined;
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const message = typeof body === 'string'
      ? body
      : typeof record.message === 'string'
        ? record.message
        : exception instanceof HttpException ? exception.message : 'Internal server error';
    const details = record.details && typeof record.details === 'object'
      ? record.details as Record<string, unknown>
      : undefined;

    response.status(status).json({
      error: {
        code: errorCode(status),
        message,
        ...(details ? { details } : {})
      },
      request_id: request.requestId
    });
  }
}
```

`apps/api/src/health.controller.ts`：

```ts
import { Controller, Get, Req } from '@nestjs/common';
import { ok, type RequestWithId, type SuccessEnvelope } from './common/http';

@Controller('health')
export class HealthController {
  @Get()
  health(@Req() request: RequestWithId): SuccessEnvelope<{ status: 'ok' }> {
    return ok(request, { status: 'ok' });
  }
}
```

`apps/api/src/app.setup.ts` 同时供生产入口与 e2e 使用，避免测试漏装全局前缀或过滤器：

```ts
import type { INestApplication } from '@nestjs/common';
import { env } from './config/env';
import { HttpEnvelopeFilter } from './common/http-exception.filter';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new HttpEnvelopeFilter());
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
}
```

`apps/api/src/app.module.ts`：

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

`apps/api/src/main.ts`：

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(env.PORT, '127.0.0.1');
}

if (require.main === module) {
  void bootstrap().catch(() => {
    console.error('API failed to start');
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: 验证 API 的 RED → GREEN**

Run: `pnpm install && pnpm --filter @storyforge/contracts build && pnpm --filter @storyforge/api test -- http.e2e-spec.ts`
Expected: 1 个测试文件、1 个用例 PASS；404 和 health 的 `request_id` 均为 UUID 且与 `x-request-id` 完全一致。

Run: `pnpm --filter @storyforge/api build && node -e "const fs=require('fs'); if(!fs.existsSync('apps/api/dist/main.js')) process.exit(1)"`
Expected: TypeScript 无错误，命令退出码为 0，生成 `apps/api/dist/main.js`。

- [ ] **Step 5: 提交前执行相关 CI 检查并限定提交边界**

Run: `pnpm run ci`
Expected: 工作区 Lint、类型检查、全部测试和构建均 PASS。
Run: `python scripts/run_checks.py --path .`
Expected: 输出 `[run_checks] 总计违规 0 条`，退出码为 0。

```bash
git add apps/api pnpm-lock.yaml
git diff --cached --stat
git commit -m "feat(api): 建立 NestJS 启动壳与统一响应"
```

### Task 4: 接入 PostgreSQL、完整实体与显式迁移

**Files:**
- Create: `infra/docker-compose.yml`
- Create: `.env.example`
- Create: `apps/api/src/database/data-source.ts`
- Create: `apps/api/src/database/author.entity.ts`
- Create: `apps/api/src/database/session.entity.ts`
- Create: `apps/api/src/database/migrations/1736899200000-auth-base.ts`
- Create: `apps/api/test/test-database.ts`
- Create: `apps/api/test/database.e2e-spec.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: 写基础设施和数据库失败测试**

`infra/docker-compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: storyforge
      POSTGRES_PASSWORD: storyforge
      POSTGRES_DB: storyforge
    ports:
      - "5432:5432"
    volumes:
      - storyforge_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U storyforge -d storyforge"]
      interval: 2s
      timeout: 2s
      retries: 20
volumes:
  storyforge_pg:
```

`.env.example` 只保存非秘密示例值；本地复制为已被 Git 忽略的 `.env` 后再填写真实秘密：

```dotenv
DATABASE_URL=postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge
TEST_DATABASE_URL=postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test
PORT=3001
WEB_ORIGIN=http://127.0.0.1:5173
SESSION_TTL_SECONDS=604800
AUTHOR_EMAIL=author@example.com
AUTHOR_DISPLAY_NAME=Author
```

`apps/api/test/database.e2e-spec.ts`：

```ts
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { AuthorEntity } from '../src/database/author.entity';
import { SessionEntity } from '../src/database/session.entity';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

describe('database migrations', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await resetTestDatabase(dataSource);
  });

  afterEach(async () => {
    await clearAuthTables(dataSource);
  });

  afterAll(async () => {
    await destroyTestDatabase(dataSource);
  });

  it('creates both tables, stays explicit and enforces unique token hashes', async () => {
    const result: Array<{ table_name: string }> = await dataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('authors','sessions') ORDER BY table_name"
    );
    expect(result.map((row) => row.table_name)).toEqual(['authors', 'sessions']);
    expect(dataSource.options.synchronize).toBe(false);
    expect(await dataSource.showMigrations()).toBe(false);

    const author = await dataSource.getRepository(AuthorEntity).save({
      email: 'schema@example.com', display_name: 'Schema', password_hash: 'test-only-hash'
    });
    const sessions = dataSource.getRepository(SessionEntity);
    await sessions.save({
      author_id: author.id, token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60_000)
    });
    await expect(sessions.save({
      author_id: author.id, token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60_000)
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 启动 PostgreSQL 16 并确认测试失败**

Run: `docker compose -f infra/docker-compose.yml up -d postgres --wait`
Expected: `postgres` 容器为 `healthy`，镜像主版本为 16。
Run: `docker compose -f infra/docker-compose.yml exec -T postgres psql -U storyforge -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='storyforge_test'"`
Expected: 输出 `1` 时跳过下一条；无输出时执行下一条创建测试库。
Run: `docker compose -f infra/docker-compose.yml exec -T postgres psql -U storyforge -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE storyforge_test"`
Expected: 首次执行输出 `CREATE DATABASE`；该库只供自动化测试清表，严禁把 `DATABASE_URL` 指向它运行日常开发。
Run: `pnpm vitest run apps/api/test/database.e2e-spec.ts`
Expected: FAIL，模块解析错误指出 `data-source` 或 `test-database` 不存在。

- [ ] **Step 3: 写入完整实体、数据源、迁移、测试清理和模块注册**

`apps/api/src/database/author.entity.ts`：

```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('authors')
export class AuthorEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'citext', unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 80 })
  display_name!: string;

  @Column({ type: 'text' })
  password_hash!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
```

`apps/api/src/database/session.entity.ts`：

```ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AuthorEntity } from './author.entity';

@Entity('sessions')
export class SessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  author_id!: string;

  @ManyToOne(() => AuthorEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'author_id' })
  author!: AuthorEntity;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64 })
  token_hash!: string;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  revoked_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
```

`apps/api/src/database/migrations/1736899200000-auth-base.ts`：

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthBase1736899200000 implements MigrationInterface {
  name = 'AuthBase1736899200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS citext');
    await queryRunner.query(`
      CREATE TABLE authors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email citext NOT NULL,
        display_name varchar(80) NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_authors_email UNIQUE (email)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_sessions_token_hash UNIQUE (token_hash)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_sessions_author ON sessions(author_id)');
    await queryRunner.query('CREATE INDEX idx_sessions_expiry ON sessions(expires_at) WHERE revoked_at IS NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS sessions');
    await queryRunner.query('DROP TABLE IF EXISTS authors');
  }
}
```

`apps/api/src/database/data-source.ts`：

```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { AuthorEntity } from './author.entity';
import { SessionEntity } from './session.entity';
import { AuthBase1736899200000 } from './migrations/1736899200000-auth-base';

export function createDataSource(databaseUrl: string = env.DATABASE_URL): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [AuthorEntity, SessionEntity],
    migrations: [AuthBase1736899200000],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
}

export const AppDataSource = createDataSource();
```

`apps/api/test/test-database.ts` 从仓库根读取测试环境，强制数据库名以 `_test` 结尾，清理函数不会触碰开发库：

```ts
import { resolve } from 'node:path';
import { config } from 'dotenv';
import type { DataSource } from 'typeorm';

config({ path: resolve(__dirname, '../../../.env') });

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';

export function assertTestDatabaseUrl(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, '');
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !database.endsWith('_test')) {
    throw new Error('Test database URL must use PostgreSQL and a database name ending in _test');
  }
}

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  assertTestDatabaseUrl(value);
  return value;
}

async function dropAuthTables(dataSource: DataSource): Promise<void> {
  assertTestDatabaseUrl(String(dataSource.options.url));
  await dataSource.query('DROP TABLE IF EXISTS sessions CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS authors CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS migrations CASCADE');
}

export async function resetTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) await dataSource.initialize();
  await dropAuthTables(dataSource);
  await dataSource.runMigrations();
}

export async function clearAuthTables(dataSource: DataSource): Promise<void> {
  assertTestDatabaseUrl(String(dataSource.options.url));
  await dataSource.query('TRUNCATE TABLE sessions, authors RESTART IDENTITY CASCADE');
}

export async function destroyTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) return;
  await dropAuthTables(dataSource);
  await dataSource.destroy();
}
```

将 `apps/api/package.json` 整体替换为：

```json
{
  "name": "@storyforge/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "tsx src/main.ts",
    "start:dev": "tsx watch src/main.ts",
    "start:prod": "node dist/main.js",
    "migration:run": "tsx ./node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/typeorm": "^11.0.0",
    "@storyforge/contracts": "workspace:*",
    "dotenv": "^16.5.0",
    "pg": "^8.16.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "typeorm": "^0.3.24",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.1",
    "@types/node": "^22.15.0",
    "@types/pg": "^8.15.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.1.0",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

`apps/api/src/app.module.ts`：

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppDataSource } from './database/data-source';
import { HealthController } from './health.controller';

@Module({
  imports: [TypeOrmModule.forRoot({ ...AppDataSource.options })],
  controllers: [HealthController]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

- [ ] **Step 4: 验证迁移可重复、约束生效且测试完成清理**

Run: `pnpm install && pnpm --filter @storyforge/contracts build && pnpm --filter @storyforge/api migration:run`
Expected: 首次执行 `AuthBase1736899200000`，输出迁移成功。
Run: `pnpm --filter @storyforge/api migration:run`
Expected: 输出 `No migrations are pending`，退出码为 0；应用启动没有隐式执行迁移。
Run: `pnpm --filter @storyforge/api test -- database.e2e-spec.ts`
Expected: 1 个用例 PASS；重复摘要触发唯一约束；`afterAll` 删除测试库的 `sessions`、`authors`、`migrations` 并关闭连接。
Run: `pnpm --filter @storyforge/api build`
Expected: TypeScript 无错误，实体与迁移被编译到 `apps/api/dist/database/`。

- [ ] **Step 5: 提交前执行相关 CI 检查并限定提交边界**

Run: `pnpm run ci`
Expected: 工作区 Lint、类型检查、全部测试和构建均 PASS，数据库用例使用 `storyforge_test`。
Run: `python scripts/run_checks.py --path .`
Expected: 输出 `[run_checks] 总计违规 0 条`，退出码为 0。

```bash
git add .env.example infra apps/api pnpm-lock.yaml
git diff --cached --stat
git commit -m "feat(database): 增加 PostgreSQL 鉴权模式与显式迁移"
```

### Task 5: 完成作者引导脚本与 Argon2 密码安全

**Files:**
- Create: `apps/api/src/auth/password.service.ts`
- Create: `apps/api/src/auth/password.service.test.ts`
- Create: `apps/api/src/auth/bootstrap-author.ts`
- Create: `apps/api/src/auth/auth.module.ts`
- Modify: `.env.example`
- Modify: `apps/api/package.json`

- [ ] **Step 1: 写密码服务失败测试**

`apps/api/src/auth/password.service.test.ts`：

```ts
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  it('uses Argon2id and never stores plaintext', async () => {
    const service = new PasswordService();
    const password = 'correct horse battery';
    const hash = await service.hash(password);

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(password);
    await expect(service.verify(hash, password)).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong password')).resolves.toBe(false);
    await expect(service.hash(password)).resolves.not.toBe(hash);
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm vitest run apps/api/src/auth/password.service.test.ts`
Expected: FAIL，模块解析错误指出 `./password.service` 不存在。

- [ ] **Step 3: 写入完整密码服务、作者 UPSERT 引导与运行脚本**

`apps/api/src/auth/password.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
```

`apps/api/src/auth/bootstrap-author.ts`：

```ts
import '../config/env';
import { z } from 'zod';
import { createDataSource } from '../database/data-source';
import { AuthorEntity } from '../database/author.entity';
import { PasswordService } from './password.service';

const bootstrapEnvSchema = z.object({
  AUTHOR_EMAIL: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
  AUTHOR_DISPLAY_NAME: z.string().trim().min(1).max(80),
  AUTHOR_PASSWORD: z.string().min(8).max(128)
});

export async function bootstrapAuthor(): Promise<void> {
  const input = bootstrapEnvSchema.parse(process.env);
  const dataSource = createDataSource();

  try {
    await dataSource.initialize();
    const passwordHash = await new PasswordService().hash(input.AUTHOR_PASSWORD);
    await dataSource.getRepository(AuthorEntity).createQueryBuilder()
      .insert()
      .values({
        email: input.AUTHOR_EMAIL,
        display_name: input.AUTHOR_DISPLAY_NAME,
        password_hash: passwordHash
      })
      .orUpdate(['display_name', 'password_hash'], ['email'])
      .execute();
    console.info(`bootstrap complete: ${input.AUTHOR_EMAIL}`);
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  void bootstrapAuthor().catch(() => {
    console.error('bootstrap failed; check DATABASE_URL and AUTHOR_* environment variables');
    process.exitCode = 1;
  });
}
```

`apps/api/src/auth/auth.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthorEntity } from '../database/author.entity';
import { SessionEntity } from '../database/session.entity';
import { PasswordService } from './password.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuthorEntity, SessionEntity])],
  providers: [PasswordService],
  exports: [PasswordService]
})
export class AuthModule {}
```

`.env.example` 完整内容如下；`AUTHOR_PASSWORD` 故意为空，真实值只写入本地 `.env` 或 CI secret：

```dotenv
DATABASE_URL=postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge
TEST_DATABASE_URL=postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test
PORT=3001
WEB_ORIGIN=http://127.0.0.1:5173
SESSION_TTL_SECONDS=604800
AUTHOR_EMAIL=author@example.com
AUTHOR_DISPLAY_NAME=Author
# 必填且长度为 8-128；不要提交真实密码。
AUTHOR_PASSWORD=
```

将 `apps/api/package.json` 整体替换为：

```json
{
  "name": "@storyforge/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "tsx src/main.ts",
    "start:dev": "tsx watch src/main.ts",
    "start:prod": "node dist/main.js",
    "migration:run": "tsx ./node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts",
    "bootstrap:author": "tsx src/auth/bootstrap-author.ts"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/typeorm": "^11.0.0",
    "@storyforge/contracts": "workspace:*",
    "argon2": "^0.43.0",
    "dotenv": "^16.5.0",
    "pg": "^8.16.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "typeorm": "^0.3.24",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.1",
    "@types/node": "^22.15.0",
    "@types/pg": "^8.15.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.1.0",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: 验证密码测试、重复引导和数据库摘要**

Run: `pnpm install && pnpm --filter @storyforge/contracts build && pnpm --filter @storyforge/api test -- password.service.test.ts`
Expected: 1 个用例 PASS，两次摘要因随机盐不同，错误密码返回 `false`。
Run: `pnpm --filter @storyforge/api migration:run`
Expected: 开发库迁移已执行或显示 `No migrations are pending`。
Run: `pnpm --filter @storyforge/api bootstrap:author`
Expected: 当本地 `AUTHOR_EMAIL=author@example.com` 时只输出 `bootstrap complete: author@example.com`，不输出密码或摘要；密码为空或不足 8 位时命令非零退出。
Run: `pnpm --filter @storyforge/api bootstrap:author`
Expected: 再次成功且执行 UPSERT，不新增重复邮箱。
Run: `docker compose -f infra/docker-compose.yml exec -T postgres psql -U storyforge -d storyforge -tAc "SELECT email, position('argon2id' in password_hash) > 0 AS is_argon2id FROM authors"`
Expected: 每个引导邮箱仅一行，`is_argon2id` 为 `t`；查询结果不包含明文密码。

- [ ] **Step 5: 提交前执行相关 CI 检查并限定提交边界**

Run: `pnpm run ci`
Expected: 工作区 Lint、类型检查、全部测试和构建均 PASS。
Run: `python scripts/run_checks.py --path .`
Expected: 输出 `[run_checks] 总计违规 0 条`，退出码为 0；`git diff --cached` 不含 `.env` 或真实 `AUTHOR_PASSWORD`。

```bash
git add .env.example apps/api pnpm-lock.yaml
git diff --cached --stat
git commit -m "feat(auth): 增加 Argon2 作者引导命令"
```

### Task 6: 完成数据库会话、鉴权接口与 CSRF 防护

**Files:**
- Create: `apps/api/src/auth/auth.constants.ts`
- Create: `apps/api/src/auth/auth.service.ts`
- Create: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/session.guard.ts`
- Create: `apps/api/src/auth/csrf.guard.ts`
- Create: `apps/api/src/auth/auth.service.test.ts`
- Create: `apps/api/test/auth.e2e-spec.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/app.setup.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: 写令牌摘要、幂等退出与完整鉴权 e2e 失败测试**

`apps/api/src/auth/auth.service.test.ts`：

```ts
import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('creates 256-bit tokens and stores only their SHA-256 hash', () => {
    const service = new AuthService({} as never, {} as never, {} as never);
    const raw = service.createRawToken();

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(service.createRawToken()).not.toBe(raw);
    expect(service.hashToken(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(service.hashToken(raw)).not.toBe(raw);
  });

  it('keeps repeated logout calls successful without exposing the raw token', async () => {
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const service = new AuthService({} as never, { update } as never, {} as never);
    const raw = service.createRawToken();

    await expect(service.logout(raw)).resolves.toBeUndefined();
    await expect(service.logout(raw)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(
      { token_hash: service.hashToken(raw) },
      expect.objectContaining({ revoked_at: expect.any(Date) })
    );
  });
});
```

`apps/api/test/auth.e2e-spec.ts` 也在实现前写入；动态导入应用模块是为了先设置测试库环境变量：

```ts
import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { requestIdSchema } from '@storyforge/contracts';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie'] as string[] | string | undefined;
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function requiredCookie(cookies: string[], name: string): string {
  const value = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  expect(value).toBeDefined();
  return value!;
}

describe('author session flow', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;

  beforeAll(async () => {
    const [{ AppModule }, { configureApp }, { createDataSource }] = await Promise.all([
      import('../src/app.module'),
      import('../src/app.setup'),
      import('../src/database/data-source')
    ]);
    migrationDataSource = createDataSource(databaseUrl);
    await resetTestDatabase(migrationDataSource);

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = module.get(DataSource);
  });

  beforeEach(async () => {
    await clearAuthTables(dataSource);
    const [{ AuthorEntity }, { PasswordService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    await dataSource.getRepository(AuthorEntity).save({
      email: 'author@example.com', display_name: 'M0 Author', password_hash: passwordHash
    });
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  it('rejects invalid input and credentials before creating a session', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'bad', password: 'short' })
      .expect(422);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(invalid.body.error.details.fields.email).toBeDefined();
    expect(requestIdSchema.safeParse(invalid.body.request_id).success).toBe(true);

    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'author@example.com', password: 'wrong password' })
      .expect(401);
    expect(wrong.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    expect(setCookies(wrong)).toEqual([]);

    const anonymous = await request(app.getHttpServer()).get('/api/v1/auth/session').expect(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');
  });

  it('logs in, restores, enforces CSRF, revokes and never stores the raw token', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'author@example.com', password: 'correct horse' })
      .expect(200);
    const cookies = setCookies(login);
    const sessionSetCookie = requiredCookie(cookies, 'storyforge_session');
    const csrfSetCookie = requiredCookie(cookies, 'storyforge_csrf');
    const sessionCookie = sessionSetCookie.split(';')[0]!;
    const csrfCookie = csrfSetCookie.split(';')[0]!;
    const rawToken = decodeURIComponent(sessionCookie.split('=')[1]!);
    const csrfToken = login.body.data.csrf_token as string;

    expect(login.body.data.author).toEqual({
      id: expect.any(String), email: 'author@example.com', display_name: 'M0 Author'
    });
    expect(JSON.stringify(login.body)).not.toContain(rawToken);
    expect(sessionSetCookie).toContain('HttpOnly');
    expect(sessionSetCookie).toContain('SameSite=Lax');
    expect(sessionSetCookie).toContain('Path=/');
    expect(csrfSetCookie).not.toContain('HttpOnly');
    expect(csrfSetCookie).toContain('SameSite=Lax');

    const { SessionEntity } = await import('../src/database/session.entity');
    const sessions = dataSource.getRepository(SessionEntity);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const stored = await sessions.findOneByOrFail({ token_hash: tokenHash });
    expect(stored.token_hash).not.toBe(rawToken);
    expect(stored.revoked_at).toBeNull();

    const restored = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', [sessionCookie, csrfCookie])
      .expect(200);
    expect(restored.body.data).toEqual({ author: login.body.data.author, csrf_token: csrfToken });

    const forbidden = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', [sessionCookie, csrfCookie])
      .expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const logout = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', [sessionCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(logout.body.data).toEqual({ logged_out: true });
    expect(requiredCookie(setCookies(logout), 'storyforge_session')).toContain('Expires=Thu, 01 Jan 1970');
    expect(requiredCookie(setCookies(logout), 'storyforge_csrf')).toContain('Expires=Thu, 01 Jan 1970');

    const revoked = await sessions.findOneByOrFail({ token_hash: tokenHash });
    expect(revoked.revoked_at).toBeInstanceOf(Date);
    const { AuthService } = await import('../src/auth/auth.service');
    await expect(app.get(AuthService).logout(rawToken)).resolves.toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', [sessionCookie, csrfCookie])
      .expect(401);
  });
});
```

- [ ] **Step 2: 运行单元与 e2e 测试并确认失败**

Run: `pnpm vitest run apps/api/src/auth/auth.service.test.ts apps/api/test/auth.e2e-spec.ts`
Expected: FAIL；单元测试提示 `./auth.service` 不存在，e2e 的登录/会话请求得到 404 或因 `AuthService` 不存在而失败，不得删除断言或先写实现。

- [ ] **Step 3: 写入完整会话服务、控制器、守卫与模块**

`apps/api/src/auth/auth.constants.ts`：

```ts
export const SESSION_COOKIE = 'storyforge_session';
export const CSRF_COOKIE = 'storyforge_csrf';
```

`apps/api/src/auth/auth.service.ts`：

```ts
import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Author } from '@storyforge/contracts';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { env } from '../config/env';
import { AuthorEntity } from '../database/author.entity';
import { SessionEntity } from '../database/session.entity';
import { PasswordService } from './password.service';

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  author: Author;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(AuthorEntity) private readonly authors: Repository<AuthorEntity>,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
    private readonly passwords: PasswordService
  ) {}

  createRawToken(): string {
    return randomBytes(32).toString('hex');
  }

  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const author = await this.authors.findOne({ where: { email: email.trim().toLowerCase() } });
    if (!author || !await this.passwords.verify(author.password_hash, password)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionToken = this.createRawToken();
    const csrfToken = this.createRawToken();
    await this.sessions.save(this.sessions.create({
      author_id: author.id,
      token_hash: this.hashToken(sessionToken),
      expires_at: new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000),
      revoked_at: null
    }));
    return { sessionToken, csrfToken, author: this.toAuthor(author) };
  }

  async validate(raw: string | undefined): Promise<Author | null> {
    if (!raw) return null;
    const session = await this.sessions.findOne({
      where: {
        token_hash: this.hashToken(raw),
        revoked_at: IsNull(),
        expires_at: MoreThan(new Date())
      },
      relations: { author: true }
    });
    return session ? this.toAuthor(session.author) : null;
  }

  async logout(raw: string | undefined): Promise<void> {
    if (!raw) return;
    await this.sessions.update(
      { token_hash: this.hashToken(raw) },
      { revoked_at: new Date() }
    );
  }

  private toAuthor(author: AuthorEntity): Author {
    return { id: author.id, email: String(author.email), display_name: author.display_name };
  }
}
```

`apps/api/src/auth/session.guard.ts`：

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../common/http';
import { SESSION_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const raw = request.cookies[SESSION_COOKIE] as string | undefined;
    const author = await this.auth.validate(raw);
    if (!author) throw new UnauthorizedException('Authentication required');
    request.author = author;
    return true;
  }
}
```

`apps/api/src/auth/csrf.guard.ts` 使用定长摘要值和 `timingSafeEqual`，长度不同或缺失时直接拒绝：

```ts
import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestWithId } from '../common/http';
import { CSRF_COOKIE } from './auth.constants';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithId>();
    const header = request.get('x-csrf-token');
    const cookie = request.cookies[CSRF_COOKIE] as string | undefined;
    if (!header || !cookie) throw new ForbiddenException('CSRF token mismatch');

    const supplied = Buffer.from(header);
    const expected = Buffer.from(cookie);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ForbiddenException('CSRF token mismatch');
    }
    return true;
  }
}
```

`apps/api/src/auth/auth.controller.ts`：

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { loginRequestSchema, type SessionResponse } from '@storyforge/contracts';
import type { CookieOptions, Response } from 'express';
import { env } from '../config/env';
import { ok, type AuthenticatedRequest, type RequestWithId, type SuccessEnvelope } from '../common/http';
import { CSRF_COOKIE, SESSION_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { SessionGuard } from './session.guard';

function cookieOptions(httpOnly: boolean): CookieOptions {
  return {
    httpOnly,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/'
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: RequestWithId,
    @Res({ passthrough: true }) response: Response
  ): Promise<SuccessEnvelope<SessionResponse>> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: 'Invalid login input',
        details: { fields: parsed.error.flatten().fieldErrors }
      });
    }

    const result = await this.auth.login(parsed.data.email, parsed.data.password);
    const maxAge = env.SESSION_TTL_SECONDS * 1000;
    response.cookie(SESSION_COOKIE, result.sessionToken, { ...cookieOptions(true), maxAge });
    response.cookie(CSRF_COOKIE, result.csrfToken, { ...cookieOptions(false), maxAge });
    return ok(request, { author: result.author, csrf_token: result.csrfToken });
  }

  @Get('session')
  @UseGuards(SessionGuard)
  session(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): SuccessEnvelope<SessionResponse> {
    let csrfToken = request.cookies[CSRF_COOKIE] as string | undefined;
    if (!csrfToken) {
      csrfToken = this.auth.createRawToken();
      response.cookie(CSRF_COOKIE, csrfToken, {
        ...cookieOptions(false),
        maxAge: env.SESSION_TTL_SECONDS * 1000
      });
    }
    return ok(request, { author: request.author, csrf_token: csrfToken });
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): Promise<SuccessEnvelope<{ logged_out: true }>> {
    await this.auth.logout(request.cookies[SESSION_COOKIE] as string);
    response.clearCookie(SESSION_COOKIE, cookieOptions(true));
    response.clearCookie(CSRF_COOKIE, cookieOptions(false));
    return ok(request, { logged_out: true });
  }
}
```

`apps/api/src/auth/auth.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthorEntity } from '../database/author.entity';
import { SessionEntity } from '../database/session.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { PasswordService } from './password.service';
import { SessionGuard } from './session.guard';

@Module({
  imports: [TypeOrmModule.forFeature([AuthorEntity, SessionEntity])],
  controllers: [AuthController],
  providers: [AuthService, CsrfGuard, PasswordService, SessionGuard],
  exports: [AuthService, CsrfGuard, PasswordService, SessionGuard]
})
export class AuthModule {}
```

`apps/api/src/app.module.ts`：

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppDataSource } from './database/data-source';
import { HealthController } from './health.controller';

@Module({
  imports: [TypeOrmModule.forRoot({ ...AppDataSource.options }), AuthModule],
  controllers: [HealthController]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

`apps/api/src/app.setup.ts`：

```ts
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { HttpEnvelopeFilter } from './common/http-exception.filter';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalFilters(new HttpEnvelopeFilter());
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
}
```

将 `apps/api/package.json` 整体替换为：

```json
{
  "name": "@storyforge/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "tsx src/main.ts",
    "start:dev": "tsx watch src/main.ts",
    "start:prod": "node dist/main.js",
    "migration:run": "tsx ./node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts",
    "bootstrap:author": "tsx src/auth/bootstrap-author.ts"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/typeorm": "^11.0.0",
    "@storyforge/contracts": "workspace:*",
    "argon2": "^0.43.0",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.5.0",
    "pg": "^8.16.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "typeorm": "^0.3.24",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.8",
    "@types/express": "^5.0.1",
    "@types/node": "^22.15.0",
    "@types/pg": "^8.15.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.1.0",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

M1 的统一导入路径固定为 `apps/api/src/common/http.ts` 中的 `AuthenticatedRequest`、`RequestWithId`、`ok`；守卫路径固定为 `apps/api/src/auth/session.guard.ts` 与 `apps/api/src/auth/csrf.guard.ts`。`request.author` 的结构严格为 `{ id, email, display_name }`，`request.requestId` 只由 Task 3 中间件写入 UUID。

- [ ] **Step 4: 运行完整鉴权测试并确认 RED → GREEN**

Run: `pnpm install && pnpm --filter @storyforge/contracts build && pnpm --filter @storyforge/api test -- auth.service.test.ts auth.e2e-spec.ts`
Expected: 单元 2 个、e2e 2 个用例全部 PASS；覆盖 422、401、双 Cookie、会话恢复、403、退出 200、摘要存储与撤销。
Run: `pnpm --filter @storyforge/api build`
Expected: TypeScript 无错误，`AuthenticatedRequest`、`ok`、两个守卫均包含在编译产物中。

- [ ] **Step 5: 提交前执行相关 CI 检查并限定提交边界**

Run: `pnpm run ci`
Expected: 工作区 Lint、类型检查、全部测试和构建均 PASS，测试库在结束后无鉴权表。
Run: `python scripts/run_checks.py --path .`
Expected: 输出 `[run_checks] 总计违规 0 条`，退出码为 0，日志和暂存差异不含原始会话令牌或密码。

```bash
git add apps/api pnpm-lock.yaml
git diff --cached --stat
git commit -m "feat(auth): 完成数据库会话与 CSRF 防护"
```

### Task 7: 完成 Vite/React 登录壳、认证客户端与会话恢复

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/app.test.tsx`
- Create: `apps/web/src/auth/auth-client.ts`
- Create: `apps/web/src/auth/auth-client.test.ts`
- Create: `apps/web/src/auth/auth-page.tsx`
- Create: `apps/web/src/auth/auth-page.test.tsx`
- Create: `apps/web/src/test/setup.ts`

- [ ] **Step 1: 写认证客户端、登录组件和会话恢复失败测试**

`apps/web/src/auth/auth-page.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthPage } from './auth-page';

it('submits credentials and exposes server errors', async () => {
  const user = userEvent.setup();
  const login = vi.fn().mockRejectedValue(new Error('Invalid credentials'));
  render(<AuthPage login={login} onSuccess={vi.fn()} />);

  await user.type(screen.getByLabelText('邮箱'), 'author@example.com');
  await user.type(screen.getByLabelText('密码'), 'correct horse');
  await user.click(screen.getByRole('button', { name: '登录' }));

  expect(login).toHaveBeenCalledWith({ email: 'author@example.com', password: 'correct horse' });
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
  expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
});
```

`apps/web/src/app.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import type { SessionResponse } from '@storyforge/contracts';
import { App, type AuthClient } from './app';
import { ApiError } from './auth/auth-client';

const session: SessionResponse = {
  author: {
    id: '0f7b70de-24f0-4f0f-a568-96bb1a95bd62',
    email: 'author@example.com',
    display_name: 'M0 Author'
  },
  csrf_token: 'a'.repeat(64)
};

function client(overrides: Partial<AuthClient>): AuthClient {
  return {
    login: vi.fn(),
    getSession: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Authentication required', '0f7b70de-24f0-4f0f-a568-96bb1a95bd62')),
    logout: vi.fn(),
    ...overrides
  };
}

it('restores an authenticated session from the API', async () => {
  const getSession = vi.fn().mockResolvedValue(session);
  render(<App client={client({ getSession })} />);

  expect(await screen.findByText('工程基座已就绪')).toBeInTheDocument();
  expect(screen.getByText('M0 Author')).toBeInTheDocument();
  expect(getSession).toHaveBeenCalledTimes(1);
});

it('shows the login form when session recovery returns 401', async () => {
  render(<App client={client({})} />);
  expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
  expect(screen.queryByText('工程基座已就绪')).not.toBeInTheDocument();
});
```

`apps/web/src/auth/auth-client.test.ts`：

```ts
import { ApiError, login } from './auth-client';

const session = {
  author: {
    id: '0f7b70de-24f0-4f0f-a568-96bb1a95bd62',
    email: 'author@example.com',
    display_name: 'M0 Author'
  },
  csrf_token: 'a'.repeat(64)
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it('uses same-origin credentials and validates the success envelope', async () => {
  const requestId = crypto.randomUUID();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: session, request_id: requestId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(login({ email: 'author@example.com', password: 'correct horse' })).resolves.toEqual(session);
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ email: 'author@example.com', password: 'correct horse' })
  }));
});

it('preserves structured API errors', async () => {
  const requestId = crypto.randomUUID();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' }, request_id: requestId
  }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

  const promise = login({ email: 'author@example.com', password: 'wrong password' });
  await expect(promise).rejects.toMatchObject({
    name: 'ApiError', status: 401, code: 'UNAUTHORIZED', requestId
  });
  await expect(promise).rejects.toBeInstanceOf(ApiError);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm vitest run apps/web/src/auth/auth-client.test.ts apps/web/src/auth/auth-page.test.tsx apps/web/src/app.test.tsx`
Expected: FAIL，模块解析错误指出 `auth-client`、`auth-page` 或 `app` 不存在；不得先降低断言。

- [ ] **Step 3: 写入完整 Web 配置、客户端和组件**

`apps/web/package.json`：

```json
{
  "name": "@storyforge/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@storyforge/contracts": "workspace:*",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.15.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.4.1",
    "jsdom": "^26.1.0",
    "typescript": "^5.8.3",
    "vite": "^6.3.5",
    "vitest": "^3.2.0"
  }
}
```

`apps/web/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "noEmit": true,
    "esModuleInterop": true,
    "types": ["node", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/vite.config.ts`：

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true }
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true
  }
});
```

`apps/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>StoryForgeAI</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/test/setup.ts`：

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
```

`apps/web/src/auth/auth-client.ts`：

```ts
import {
  apiErrorSchema,
  apiSuccessSchema,
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse
} from '@storyforge/contracts';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiRequest<T extends z.ZodType>(
  path: string,
  init: RequestInit,
  dataSchema: T
): Promise<z.infer<T>> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  const json: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorSchema.parse(json);
    throw new ApiError(response.status, error.error.code, error.error.message, error.request_id);
  }
  return apiSuccessSchema(dataSchema).parse(json).data;
}

export function login(input: LoginRequest): Promise<SessionResponse> {
  const body = loginRequestSchema.parse(input);
  return apiRequest('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, sessionResponseSchema);
}

export function getSession(): Promise<SessionResponse> {
  return apiRequest('/api/v1/auth/session', { method: 'GET' }, sessionResponseSchema);
}

export function logout(csrfToken: string): Promise<{ logged_out: true }> {
  return apiRequest('/api/v1/auth/logout', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken }
  }, z.object({ logged_out: z.literal(true) }));
}

export const authClient = { login, getSession, logout };
```

`apps/web/src/auth/auth-page.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import type { LoginRequest, SessionResponse } from '@storyforge/contracts';

export interface AuthPageProps {
  login: (input: LoginRequest) => Promise<SessionResponse>;
  onSuccess: (session: SessionResponse) => void;
}

export function AuthPage({ login, onSuccess }: AuthPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      onSuccess(await login({ email, password }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '登录失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <h1>StoryForgeAI 作者登录</h1>
      <form onSubmit={submit}>
        <div>
          <label htmlFor="author-email">邮箱</label>
          <input
            id="author-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={320}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="author-password">密码</label>
          <input
            id="author-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={pending}>{pending ? '登录中…' : '登录'}</button>
      </form>
    </main>
  );
}
```

`apps/web/src/app.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { LoginRequest, SessionResponse } from '@storyforge/contracts';
import { ApiError, authClient } from './auth/auth-client';
import { AuthPage } from './auth/auth-page';

export interface AuthClient {
  login: (input: LoginRequest) => Promise<SessionResponse>;
  getSession: () => Promise<SessionResponse>;
  logout: (csrfToken: string) => Promise<{ logged_out: true }>;
}

type Status = 'loading' | 'anonymous' | 'authenticated' | 'error';

export function App({ client = authClient }: { client?: AuthClient }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  const restore = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError('');
    try {
      const restored = await client.getSession();
      setSession(restored);
      setStatus('authenticated');
    } catch (cause: unknown) {
      setSession(null);
      if (cause instanceof ApiError && cause.status === 401) {
        setStatus('anonymous');
      } else {
        setError(cause instanceof Error ? cause.message : '会话恢复失败');
        setStatus('error');
      }
    }
  }, [client]);

  useEffect(() => {
    void restore();
  }, [restore]);

  function authenticated(next: SessionResponse): void {
    setSession(next);
    setStatus('authenticated');
  }

  async function logout(): Promise<void> {
    if (!session || loggingOut) return;
    setLoggingOut(true);
    setError('');
    try {
      await client.logout(session.csrf_token);
      setSession(null);
      setStatus('anonymous');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : '退出失败');
    } finally {
      setLoggingOut(false);
    }
  }

  if (status === 'loading') return <main><p>正在恢复会话…</p></main>;
  if (status === 'error') {
    return <main><p role="alert">{error}</p><button type="button" onClick={() => void restore()}>重试</button></main>;
  }
  if (status === 'anonymous' || !session) {
    return <AuthPage login={client.login} onSuccess={authenticated} />;
  }

  return (
    <main>
      <h1>工程基座已就绪</h1>
      <p>{session.author.display_name}</p>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={loggingOut} onClick={() => void logout()}>
        {loggingOut ? '退出中…' : '退出登录'}
      </button>
    </main>
  );
}
```

`apps/web/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 4: 验证组件、认证客户端、构建和真实启动**

Run: `pnpm install && pnpm --filter @storyforge/contracts build && pnpm --filter @storyforge/web test`
Expected: 认证客户端 2 个、登录组件 1 个、会话恢复 2 个用例全部 PASS。
Run: `pnpm --filter @storyforge/web build && pnpm --filter @storyforge/api build`
Expected: TypeScript 与 Vite 构建无错误，生成 `apps/web/dist/index.html`。
Run: `pnpm --filter @storyforge/api start`
Expected: 在独立终端监听 `127.0.0.1:3001`，`curl http://127.0.0.1:3001/api/v1/health` 返回带 UUID 的成功信封。
Run: `pnpm --filter @storyforge/web dev`
Expected: 在另一独立终端监听 `http://127.0.0.1:5173`；通过同源 `/api` 代理登录，刷新后仍显示“工程基座已就绪”，`document.cookie` 不包含 `storyforge_session`。

- [ ] **Step 5: 提交前执行相关 CI 检查并限定提交边界**

Run: `pnpm run ci`
Expected: 工作区 Lint、类型检查、全部测试和构建均 PASS。
Run: `python scripts/run_checks.py --path .`
Expected: 输出 `[run_checks] 总计违规 0 条`，退出码为 0。

```bash
git add apps/web pnpm-lock.yaml
git diff --cached --stat
git commit -m "feat(web): 增加 React 登录壳与会话恢复"
```

### Task 8: 建立浏览器验收、CI 和 M0 验收证据

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `playwright.config.ts`
- Create: `tests/e2e/e2e-env.ts`
- Create: `tests/e2e/global-setup.ts`
- Create: `tests/e2e/m0-auth.spec.ts`
- Create: `apps/api/test/prepare-e2e.ts`
- Create: `scripts/verify-m0.mjs`
- Create: `docs/05-测试与验收报告/M0工程基座验收报告.md`
- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/02-技术与架构/技术栈.md`
- Modify: `docs/02-技术与架构/目录结构.md`

- [ ] **Step 1: 写完整浏览器失败测试**

写入 `tests/e2e/m0-auth.spec.ts`。测试只从环境读取作者凭据，并同时验证登录、HttpOnly Cookie、刷新恢复、退出和截图证据：

```ts
import { expect, test } from '@playwright/test';
import { e2eEnvironment } from './e2e-env';

test('author can log in, restore a session and log out', async ({ page }, testInfo) => {
  const { authorDisplayName, authorEmail, authorPassword } = e2eEnvironment();

  await page.goto('/');
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  await page.getByLabel('邮箱').fill(authorEmail);
  await page.getByLabel('密码').fill(authorPassword);
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page.getByRole('heading', { name: '工程基座已就绪' })).toBeVisible();
  await expect(page.getByText(authorDisplayName)).toBeVisible();
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'storyforge_session');
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  const visibleCookies = await page.evaluate(() => document.cookie);
  expect(visibleCookies).not.toContain('storyforge_session=');
  expect(visibleCookies).toContain('storyforge_csrf=');

  await page.reload();
  await expect(page.getByRole('heading', { name: '工程基座已就绪' })).toBeVisible();
  const screenshot = testInfo.outputPath('m0-authenticated.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('m0-authenticated', { path: screenshot, contentType: 'image/png' });

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'storyforge_session')).toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
});
```

- [ ] **Step 2: 运行浏览器测试并确认失败**

Run: `pnpm exec playwright test tests/e2e/m0-auth.spec.ts`
Expected: FAIL，提示 `@playwright/test`、Playwright 配置或 `./e2e-env` 不存在；不得通过硬编码作者密码、跳过启动或删除 Cookie 断言使测试变绿。

- [ ] **Step 3: 写入测试环境、数据初始化、双服务启动、CI 和验收脚本**

`tests/e2e/e2e-env.ts` 负责读取本地 `.env` 或 CI 环境。错误信息只包含变量名，绝不回显密码；数据库名强制以 `_test` 结尾：

```ts
import 'dotenv/config';

const DEFAULT_TEST_DATABASE_URL = 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';

function required(name: 'AUTHOR_EMAIL' | 'AUTHOR_DISPLAY_NAME' | 'AUTHOR_PASSWORD'): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required E2E environment variable: ${name}`);
  return value;
}

export function e2eEnvironment() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must use a database name ending in _test');
  }

  const authorEmail = required('AUTHOR_EMAIL').trim().toLowerCase();
  const authorDisplayName = required('AUTHOR_DISPLAY_NAME').trim();
  const authorPassword = required('AUTHOR_PASSWORD');
  if (!authorEmail || !authorDisplayName) throw new Error('E2E author email and display name must not be blank');
  if (authorPassword.length < 8 || authorPassword.length > 128) {
    throw new Error('AUTHOR_PASSWORD must contain 8-128 characters');
  }

  return { databaseUrl, authorDisplayName, authorEmail, authorPassword };
}
```

`apps/api/test/prepare-e2e.ts` 每次先删除测试库的鉴权表、执行显式迁移，再以 Argon2id 创建一个确定作者；它由 API 包已有的 `tsx` 执行，避免 Playwright 直接转译 Nest/TypeORM 装饰器：

```ts
import { createDataSource } from '../src/database/data-source';
import { AuthorEntity } from '../src/database/author.entity';
import { PasswordService } from '../src/auth/password.service';
import { resetTestDatabase } from './test-database';
import { e2eEnvironment } from '../../../tests/e2e/e2e-env';

export async function prepareE2eDatabase(): Promise<void> {
  const config = e2eEnvironment();
  const dataSource = createDataSource(config.databaseUrl);

  try {
    await resetTestDatabase(dataSource);
    const passwordHash = await new PasswordService().hash(config.authorPassword);
    await dataSource.getRepository(AuthorEntity).save({
      email: config.authorEmail,
      display_name: config.authorDisplayName,
      password_hash: passwordHash
    });
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  void prepareE2eDatabase().catch(() => {
    console.error('E2E database preparation failed; check TEST_DATABASE_URL and AUTHOR_* environment variables');
    process.exitCode = 1;
  });
}
```

`tests/e2e/global-setup.ts` 只调用上述准备脚本并继承环境，不打印凭据：

```ts
import { spawnSync } from 'node:child_process';

export default function globalSetup(): void {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpm, ['--filter', '@storyforge/api', 'test:prepare'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error('E2E database preparation failed');
}
```

将 `apps/api/package.json` 整体替换为以下版本，仅在 Task 6 基础上增加 `test:prepare`：

```json
{
  "name": "@storyforge/api",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "tsx src/main.ts",
    "start:dev": "tsx watch src/main.ts",
    "start:prod": "node dist/main.js",
    "migration:run": "tsx ./node_modules/typeorm/cli.js migration:run -d src/database/data-source.ts",
    "bootstrap:author": "tsx src/auth/bootstrap-author.ts",
    "test:prepare": "tsx test/prepare-e2e.ts"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/typeorm": "^11.0.0",
    "@storyforge/contracts": "workspace:*",
    "argon2": "^0.43.0",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.5.0",
    "pg": "^8.16.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "typeorm": "^0.3.24",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.8",
    "@types/express": "^5.0.1",
    "@types/node": "^22.15.0",
    "@types/pg": "^8.15.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.1.0",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vitest": "^3.2.0"
  }
}
```

`playwright.config.ts` 使用两个专用 `webServer`。禁止复用现有服务，防止把浏览器测试指向开发库；`globalSetup` 在任何浏览器用例前完成建表和作者初始化，health 不查询鉴权表：

```ts
import { defineConfig } from '@playwright/test';
import { e2eEnvironment } from './tests/e2e/e2e-env';

const e2e = e2eEnvironment();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/playwright',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'pnpm --filter @storyforge/api start',
      url: 'http://127.0.0.1:3001/api/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: e2e.databaseUrl,
        PORT: '3001',
        WEB_ORIGIN: 'http://127.0.0.1:5173',
        SESSION_TTL_SECONDS: '604800'
      }
    },
    {
      command: 'pnpm --filter @storyforge/web dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
```

将根 `package.json` 整体替换为：

```json
{
  "name": "storyforge-ai",
  "private": true,
  "engines": { "node": "22.16.0" },
  "packageManager": "pnpm@10.12.4",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm --filter @storyforge/contracts build && node --test tests/node/*.test.mjs && pnpm vitest run",
    "test:e2e": "pnpm --filter @storyforge/contracts build && playwright test",
    "verify:m0": "node scripts/verify-m0.mjs",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "ci": "pnpm --filter @storyforge/contracts build && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@playwright/test": "^1.51.1",
    "dotenv": "^16.5.0",
    "vitest": "^3.2.0"
  }
}
```

将 `.github/workflows/ci.yml` 整体替换为以下配置。它保留旧 Python 测试、合规检查与语法编译，新增固定工具链、PostgreSQL 16、工作区验收和 Chromium；作者凭据只能来自仓库 secrets：

```yaml
name: CI

on:
  push:
    branches: [main, master, develop]
  pull_request:
    branches: [main, master, develop]

jobs:
  m0:
    name: M0 新旧系统验收
    runs-on: ubuntu-22.04
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: storyforge
          POSTGRES_PASSWORD: storyforge
          POSTGRES_DB: storyforge
        ports:
          - 5432:5432
        options: >-
          --health-cmd="pg_isready -U storyforge -d storyforge"
          --health-interval=5s
          --health-timeout=5s
          --health-retries=20
    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test
      TEST_DATABASE_URL: postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test
      PORT: 3001
      WEB_ORIGIN: http://127.0.0.1:5173
      SESSION_TTL_SECONDS: 604800
      AUTHOR_EMAIL: ${{ secrets.M0_AUTHOR_EMAIL }}
      AUTHOR_DISPLAY_NAME: M0 CI Author
      AUTHOR_PASSWORD: ${{ secrets.M0_AUTHOR_PASSWORD }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js 22.16.0
        uses: actions/setup-node@v4
        with:
          node-version: 22.16.0

      - name: Enable pnpm 10.12.4
        run: |
          corepack enable
          corepack prepare pnpm@10.12.4 --activate
          node --version
          pnpm --version

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.9"
          cache: pip

      - name: Install Python dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
          pip install pytest

      - name: Install PostgreSQL client
        run: |
          sudo apt-get update
          sudo apt-get install --yes postgresql-client

      - name: Create isolated test database
        env:
          PGPASSWORD: storyforge
        run: createdb --host=127.0.0.1 --username=storyforge --no-password storyforge_test

      - name: Install workspace dependencies
        run: pnpm install --frozen-lockfile

      - name: Install Chromium
        run: pnpm exec playwright install --with-deps chromium

      - name: Check required author secrets without printing them
        run: node -e "for (const key of ['AUTHOR_EMAIL','AUTHOR_PASSWORD']) { if (!process.env[key]) throw new Error(key + ' repository secret is required'); }"

      - name: Workspace lint, typecheck, tests and build
        run: pnpm run ci

      - name: Legacy compliance checks
        run: python scripts/run_checks.py --path .

      - name: Legacy Python tests
        run: python -m pytest -q

      - name: Legacy Python syntax compilation
        run: python -m compileall -q .

      - name: Browser login, recovery and logout
        run: pnpm test:e2e

      - name: Upload browser evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: m0-playwright-evidence
          path: |
            test-results/
            playwright-report/
          retention-days: 14
```

`scripts/verify-m0.mjs` 是本地完整验收入口。它逐项执行提交前命令，任一失败即非零退出；报告只写入版本、退出码和非秘密测试摘要，详细控制台输出保存在已被 Git 忽略的 `test-results/m0-evidence/`：

```js
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = join(root, 'test-results', 'm0-evidence');
const reportPath = join(root, 'docs', '05-测试与验收报告', 'M0工程基座验收报告.md');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });

function execute(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
}

function requiredOutput(command, args) {
  const result = execute(command, args);
  if (result.status !== 0) throw new Error(`Unable to collect ${args.join(' ')}`);
  return result.stdout.trim();
}

const checks = [
  { id: 'workspace-ci', label: '工作区 CI', command: pnpm, args: ['run', 'ci'] },
  { id: 'compliance', label: '四类合规检查', command: 'python', args: ['scripts/run_checks.py', '--path', '.'] },
  { id: 'legacy-pytest', label: '旧 Python 测试', command: 'python', args: ['-m', 'pytest', '-q'] },
  { id: 'legacy-compile', label: '旧 Python 语法编译', command: 'python', args: ['-m', 'compileall', '-q', '.'] },
  { id: 'migration-first', label: '开发库迁移第一次执行', command: pnpm, args: ['--filter', '@storyforge/api', 'migration:run'] },
  { id: 'migration-second', label: '开发库迁移第二次执行', command: pnpm, args: ['--filter', '@storyforge/api', 'migration:run'] },
  { id: 'browser', label: 'Chromium 登录恢复退出', command: pnpm, args: ['test:e2e'] }
];

const revision = requiredOutput('git', ['rev-parse', 'HEAD']);
const pnpmVersion = requiredOutput(pnpm, ['--version']);
const toolchainPassed = process.version === 'v22.16.0' && pnpmVersion === '10.12.4';
const results = [];

for (const check of checks) {
  const completed = execute(check.command, check.args);
  const output = [completed.stdout, completed.stderr].filter(Boolean).join('\n');
  const exitCode = completed.status ?? 1;
  writeFileSync(
    join(evidenceDirectory, `${check.id}.log`),
    `$ ${check.command} ${check.args.join(' ')}\nexit_code=${exitCode}\n${output}`,
    'utf8'
  );
  if (output) process.stdout.write(`${output}\n`);
  results.push({ ...check, exitCode, output });
  if (exitCode !== 0) break;
}

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';
let postgresVersion = '查询失败';
let databasePassed = false;
const apiRequire = createRequire(join(root, 'apps/api', 'package.json'));
const { Client } = apiRequire('pg');
const client = new Client({ connectionString: databaseUrl });
try {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) throw new Error('Unsafe test database name');
  await client.connect();
  const version = await client.query('SHOW server_version');
  postgresVersion = String(version.rows[0].server_version);
  databasePassed = postgresVersion.startsWith('16.');
} catch {
  databasePassed = false;
} finally {
  try { await client.end(); } catch { /* 未建立连接时无需关闭。 */ }
}

const secondMigration = results.find((result) => result.id === 'migration-second');
const repeatedMigrationPassed = secondMigration?.exitCode === 0
  && secondMigration.output.includes('No migrations are pending');
const pythonResult = results.find((result) => result.id === 'legacy-pytest');
const pythonSummary = pythonResult?.output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '未执行到测试汇总';
const allPassed = results.length === checks.length
  && results.every((result) => result.exitCode === 0)
  && toolchainPassed
  && repeatedMigrationPassed
  && databasePassed;

const report = [
  '# M0 工程基座验收报告',
  '',
  `> 状态：${allPassed ? '通过' : '未通过'}`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
  '## 环境与基线',
  '',
  '| 项目 | 实测值 |',
  '| --- | --- |',
  `| Git 验收基线（Task 8 提交前 HEAD） | \`${revision}\` |`,
  `| Node.js | \`${process.version}\` |`,
  `| pnpm | \`${pnpmVersion}\` |`,
  `| PostgreSQL | \`${postgresVersion}\` |`,
  `| 旧 Python 测试汇总 | ${pythonSummary.replace(/\|/g, '\\|')} |`,
  `| 第二次显式迁移 | ${repeatedMigrationPassed ? 'No migrations are pending' : '未确认'} |`,
  '',
  '## 命令结果',
  '',
  '| 验收项 | 命令 | 退出码 | 本地证据 |',
  '| --- | --- | ---: | --- |',
  ...results.map((result) => `| ${result.label} | \`${result.command} ${result.args.join(' ')}\` | ${result.exitCode} | \`test-results/m0-evidence/${result.id}.log\` |`),
  '',
  '## 验收结论',
  '',
  `- 工作区 Lint、类型检查、单元/e2e 测试和构建：${results.find((result) => result.id === 'workspace-ci')?.exitCode === 0 ? '通过' : '未通过'}。`,
  `- 四类合规检查：${results.find((result) => result.id === 'compliance')?.exitCode === 0 ? '0 条违规' : '未通过'}。`,
  `- 浏览器截图与 HTML 报告：${results.find((result) => result.id === 'browser')?.exitCode === 0 ? '已生成于 test-results/playwright/ 与 playwright-report/，失败时另保留 trace' : '未通过，trace 已保留用于定位'}。`,
  '- 数据库 e2e 已断言 `synchronize=false`、显式迁移、摘要唯一约束与测试库清理。',
  '- 旧 Flask 未修改，仍是既有小说业务数据的唯一写入方；NestJS 仅写 M0 的 authors/sessions。',
  ''
].join('\n');
writeFileSync(reportPath, report, 'utf8');
console.info(`M0 verification report: ${reportPath}`);

if (!allPassed) process.exitCode = 1;
```

在 `docs/02-技术与架构/技术栈.md` 末尾追加以下完整章节，明确前文描述的是当前 Flask 系统，而新增工作区是 M0 已落地的目标架构：

```markdown
## 八、M0 目标架构落地状态（2026-11-15）

前文第一至第七章描述当前 Flask/原生 JavaScript 系统。M0 新增以下隔离工作区，不替换既有小说业务链路：

| 工作区 | 固定技术 | M0 职责 |
| --- | --- | --- |
| `apps/api` | NestJS 11、TypeScript 5.8、TypeORM 0.3 | 请求 ID、统一响应、作者会话与 CSRF |
| `apps/web` | React 19、Vite 6、Vitest | 登录、会话恢复与退出壳 |
| `packages/contracts` | Zod 3、CommonJS 编译产物 | 前后端共享请求/响应契约 |
| `infra` | PostgreSQL 16 | 仅保存 M0 的 authors/sessions，显式迁移且 `synchronize=false` |
| 工具链 | Node.js 22.16.0、pnpm 10.12.4、Playwright | 可重复安装、测试、构建和浏览器验收 |

旧 Flask 仍是既有小说业务数据的唯一写入方。NestJS 仅写 M0 鉴权表，不读取或修改 Flask 的 JSON 业务数据，不开放双写；业务工作台切换不属于 M0。
```

在 `docs/02-技术与架构/目录结构.md` 末尾追加以下完整章节：

````markdown
## 六、M0 新增目标架构目录

以下目录与第二至第五章描述的 Flask 目录并存，M0 不重排旧业务文件：

```text
StoryForgeAI/
├── apps/
│   ├── api/
│   │   ├── src/auth/                 # Argon2id、作者引导、会话、登录/退出、双守卫
│   │   ├── src/common/               # UUID 请求上下文、统一成功/错误响应
│   │   ├── src/config/               # Zod 环境读取
│   │   ├── src/database/             # 实体、数据源和显式迁移
│   │   └── test/                     # 测试库安全清理与 HTTP e2e
│   └── web/
│       └── src/auth/                 # 同源认证客户端与登录页
├── packages/contracts/               # 共享 Zod 契约及 CommonJS dist 产物
├── infra/docker-compose.yml          # 本地 PostgreSQL 16
├── tests/e2e/                        # 独立测试库初始化与 Chromium 验收
└── scripts/verify-m0.mjs             # 新旧系统验收及报告生成
```

`apps/api` 只操作 M0 鉴权表；`apps/web` 只经同源 `/api/v1` 调用新 API。旧 Flask 的 `data/`、`modules/` 和写入路径保持不变。
````

- [ ] **Step 4: 安装依赖并确认浏览器测试 RED → GREEN**

Run: `pnpm install && pnpm exec playwright install chromium`
Expected: 更新 `pnpm-lock.yaml`，Chromium 安装成功；Node 与 pnpm 仍分别为 `v22.16.0` 和 `10.12.4`。
Run: `pnpm test:e2e`
Expected: 1 个浏览器用例 PASS；两个 `webServer` 均正常启动并在测试后关闭，测试库由 `globalSetup` 显式迁移和初始化，`test-results/playwright/` 中存在已登录截图。

- [ ] **Step 5: 提交前执行完整新旧系统验收并限定提交边界**

Run: `pnpm verify:m0`
Expected: 脚本依次执行 `pnpm run ci`、`python scripts/run_checks.py --path .`、`python -m pytest -q`、`python -m compileall -q .`、两次 `pnpm --filter @storyforge/api migration:run` 和 `pnpm test:e2e`；所有退出码均为 0，合规输出为 `[run_checks] 总计违规 0 条`，第二次迁移包含 `No migrations are pending`，PostgreSQL 实测主版本为 16。脚本生成 `docs/05-测试与验收报告/M0工程基座验收报告.md`，状态必须为“通过”；任一检查失败都不得提交。

```bash
git add .github/workflows/ci.yml playwright.config.ts tests/e2e apps/api/test/prepare-e2e.ts apps/api/package.json scripts/verify-m0.mjs package.json pnpm-lock.yaml docs/05-测试与验收报告/M0工程基座验收报告.md docs/02-技术与架构/技术栈.md docs/02-技术与架构/目录结构.md
git diff --cached --stat
git diff --cached -- .env .env.local
git commit -m "test: verify M0 engineering foundation"
```

`git diff --cached -- .env .env.local` 必须无输出；真实 `AUTHOR_PASSWORD`、原始会话令牌、数据库数据和 Playwright 临时产物均不得进入提交。

## 三、M0 完成定义

- 新工作区可用固定 Node `22.16.0`、pnpm `10.12.4` 安装、测试和构建，共享契约同时支持 Vitest、Vite 与 NestJS CommonJS 运行时。
- PostgreSQL 16 迁移可重复执行，`synchronize=false`、`migrationsRun=false`，自动化清理只作用于 `_test` 数据库。
- 作者可登录、恢复会话和退出；密码只保存 Argon2id 摘要，数据库不保存原始会话令牌。
- 登录是唯一匿名写入口；登录后的所有受保护写请求同时具备 `SessionGuard` 与 `CsrfGuard`，成功和错误响应都含同一个 UUID 请求 ID。
- React/NestJS/共享契约测试、旧 Python 测试、四类合规检查和 Chromium 浏览器测试全部通过，并保留截图与命令退出码证据。
- 旧 Flask 仍是既有小说业务数据的唯一写入方；NestJS 仅写 M0 鉴权表，没有旧业务数据迁移或双写行为。
- M1 可以直接复用 `@storyforge/contracts`、`apps/api/src/common/http.ts` 导出的 `AuthenticatedRequest`/`ok(request, data)`、`SessionGuard`、`CsrfGuard`、TypeORM 数据源和 React 会话壳。
