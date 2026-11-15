# M1 写作基座实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M0 鉴权与工程基座上交付作品库、卷章节树、三栏写作工作台、ProseMirror/Markdown 双模式、IndexedDB WAL、幂等云端保存、崩溃恢复、409 冲突处理与单章节多标签写入保护。

**Architecture:** ProseMirror JSON 是唯一正文格式，Markdown 只经共享 `editor-schema` 与正文互转。浏览器先把 Step 日志写入 IndexedDB，再逐条调用 NestJS；服务端在一个 PostgreSQL 事务内锁定章节、按 `change_id` 去重、校验 `base_version`、应用 Step、更新正文与插入变更记录。M1 不实现修订评审、评论、AI、剧情树或旧数据迁移，也不开放 Flask 与 NestJS 双写。

**Tech Stack:** React 19、TypeScript 5.8、ProseMirror、markdown-it、IndexedDB/idb、NestJS 11、TypeORM 0.3、PostgreSQL 16、Zod 3、Vitest、fake-indexeddb、Playwright、axe-core。

---

## 一、执行约束、接口与文件地图

### 1.1 前置条件与提交纪律

- 先完成并验收 `2026-11-15-m0-engineering-foundation.md`。本计划只复用 M0 的 `SessionGuard`、`CsrfGuard`、`AuthenticatedRequest`、`ok(request, data)`、TypeORM 数据源和 React 会话壳，不在 M1 另造鉴权或响应体系。
- M0 对 M1 暴露的既有签名固定为：`AuthenticatedRequest.author.id: string`、`AuthenticatedRequest.requestId: string`、`ok<T>(request: { requestId: string }, data: T): { data: T; request_id: string }`。开始 Task 1 前运行 `pnpm run ci`；若上述符号在 M0 实际代码中缺失或签名不同，先回到 M0 补齐并验收，不在本计划内临时定义兼容层。
- 在独立工作树和功能分支按 Task 1 → Task 14 执行；不得跳步，不得在 `main` 直接实施。
- 每个提交步骤必须先运行该任务测试、完整 `pnpm run ci` 和 `python scripts/run_checks.py --path .`；Task 14 还必须运行完整 E2E 与故障脚本。失败不得提交，不得跳过 Git hooks。pnpm 10 保留了内置 `ci` 子命令，仓内门禁一律写成 `pnpm run ci`。
- 新接口均为 `/api/v1`，成功响应为 `{ data, request_id }`。错误为 `{ error: { code, message, details? }, request_id }`；参数错误 422、未认证 401、越权资源统一 404、版本冲突 409。
- 所有写接口同时使用 `SessionGuard` 与 `CsrfGuard`；所有作品查询附带 `request.author.id`，不得仅凭 UUID 读取他人作品。
- 数据库只执行显式迁移，`synchronize=false`；不修改旧 Flask 表、JSON 数据或写入路径。
- 本地状态必须来自真实 IndexedDB/网络结果；禁止用定时器假装保存成功。异步按钮必须有 pending、成功、失败和防重复提交状态。
- 金额、AI、修订、评论等 M2+ 概念不得混入 M1 表、接口或 UI。

### 1.2 M1 API 冻结表

| 方法与路径 | 请求 | 成功数据 |
| --- | --- | --- |
| `GET /works?q=` | query 可选搜索 | `Work[]` |
| `POST /works` | `{ title, description }` | `{ work, first_chapter_id }` |
| `PATCH /works/:workId` | 标题、描述或 `active/archived` | `Work` |
| `GET /works/:workId/tree` | 无 | `{ work, volumes, chapters }` |
| `POST /works/:workId/volumes` | `{ title }` | `Volume` |
| `PATCH /works/:workId/volumes/:volumeId` | `{ title }` | `Volume` |
| `PUT /works/:workId/volumes/order` | `{ ordered_ids }` | `Volume[]` |
| `POST /works/:workId/volumes/:volumeId/chapters` | `{ title }` | `Chapter` |
| `PATCH /works/:workId/chapters/:chapterId` | `{ title }` | `ChapterSummary` |
| `PUT /works/:workId/volumes/:volumeId/chapters/order` | `{ ordered_ids }` | `ChapterSummary[]` |
| `GET /works/:workId/chapters/:chapterId` | 无 | `Chapter` |
| `POST /works/:workId/chapters/:chapterId/changes` | `SaveChangeRequest` | `SaveChangeResponse` |

### 1.3 文件职责

| 路径 | 职责 |
| --- | --- |
| `packages/contracts/src/writing.ts` | 作品、结构、正文保存与冲突契约 |
| `packages/editor-schema/` | 唯一 Schema、安全校验、Step 应用、Markdown 双向转换 |
| `packages/design-tokens/` | 墨韵科技风双主题令牌与主题控制 |
| `apps/api/src/writing/` | 作品、卷章节、原子正文保存 |
| `apps/api/src/database/` | M1 实体和显式迁移 |
| `apps/api/test/writing-fixture.ts` | 真实 PostgreSQL 作者与作品测试夹具 |
| `apps/web/src/api/` | 统一 API、CSRF、结构化错误 |
| `apps/web/src/works/` | 作品库与作品 API |
| `apps/web/src/editor/` | 双模式编辑器与保存控制器 |
| `apps/web/src/persistence/` | IndexedDB WAL、快照、冲突备份、写入租约 |
| `apps/web/src/workbench/` | 三栏壳、章节树、深链、保存状态和冲突 UI |
| `tests/e2e/m1-*.spec.ts` | 浏览器主流程和真实故障注入 |
| `scripts/verify-m1-db-failure.mjs` | 数据库暂停期间的事务完整性验收 |

## 二、实施任务

### Task 1: 冻结作品与正文保存契约

**Files:**
- Create: `packages/contracts/src/writing.ts`
- Create: `packages/contracts/src/writing.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: 写契约失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  createWorkRequestSchema,
  proseMirrorDocumentSchema,
  reorderRequestSchema,
  saveChangeRequestSchema,
  versionConflictDetailsSchema
} from './writing';

const change = {
  change_id: crypto.randomUUID(),
  client_id: crypto.randomUUID(),
  sequence: 1,
  base_version: 0,
  operations: [{ stepType: 'replace', from: 1, to: 1 }]
};

describe('writing contracts', () => {
  it('rejects blank titles, duplicate reorder ids and invalid WAL sequences', () => {
    expect(createWorkRequestSchema.safeParse({ title: ' ', description: '' }).success).toBe(false);
    expect(saveChangeRequestSchema.safeParse({ ...change, sequence: 0 }).success).toBe(false);
    const id = crypto.randomUUID();
    expect(reorderRequestSchema.safeParse({ ordered_ids: [id, id] }).success).toBe(false);
  });

  it('accepts a versioned ProseMirror change and typed conflict details', () => {
    expect(saveChangeRequestSchema.parse(change).base_version).toBe(0);
    const document = proseMirrorDocumentSchema.parse({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(versionConflictDetailsSchema.parse({
      server_version: 1,
      server_document: document,
      server_content_hash: 'a'.repeat(64)
    }).server_document.type).toBe('doc');
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run packages/contracts/src/writing.test.ts`
Expected: FAIL，提示 `./writing` 不存在。

- [ ] **Step 3: 写入 `packages/contracts/src/writing.ts`**

```ts
import { z } from 'zod';

const id = z.string().uuid();
const timestamp = z.string().datetime();
const contentHash = z.string().regex(/^[0-9a-f]{64}$/);

export interface ProseMirrorNode {
  type: string;
  text?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> | undefined }> | undefined;
  content?: ProseMirrorNode[] | undefined;
}

export const proseMirrorNodeSchema: z.ZodType<ProseMirrorNode> = z.lazy(() => z.object({
  type: z.string().min(1),
  text: z.string().optional(),
  attrs: z.record(z.unknown()).optional(),
  marks: z.array(z.object({
    type: z.string(),
    attrs: z.record(z.unknown()).optional()
  })).optional(),
  content: z.array(proseMirrorNodeSchema).optional()
}).strict());

export const proseMirrorDocumentSchema = proseMirrorNodeSchema.refine((node) => node.type === 'doc', {
  message: 'Root node must be doc'
});

export const workSchema = z.object({
  id,
  author_id: id,
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  status: z.enum(['active', 'archived']),
  created_at: timestamp,
  updated_at: timestamp
});
export const volumeSchema = z.object({
  id,
  work_id: id,
  title: z.string().min(1).max(120),
  position: z.number().int().nonnegative()
});
export const chapterSummarySchema = z.object({
  id,
  work_id: id,
  volume_id: id,
  title: z.string().min(1).max(200),
  position: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  content_hash: contentHash
});
export const chapterSchema = chapterSummarySchema.extend({ document: proseMirrorDocumentSchema });
export const createWorkRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000)
});
export const createWorkResponseSchema = z.object({ work: workSchema, first_chapter_id: id });
export const updateWorkRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(['active', 'archived']).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const treeResponseSchema = z.object({
  work: workSchema,
  volumes: z.array(volumeSchema),
  chapters: z.array(chapterSummarySchema)
});
export const volumeInputSchema = z.object({ title: z.string().trim().min(1).max(120) });
export const chapterInputSchema = z.object({ title: z.string().trim().min(1).max(200) });
export const reorderRequestSchema = z.object({
  ordered_ids: z.array(id).min(1).max(5000)
}).refine((value) => new Set(value.ordered_ids).size === value.ordered_ids.length, 'IDs must be unique');
export const saveChangeRequestSchema = z.object({
  change_id: id,
  client_id: id,
  sequence: z.number().int().positive(),
  base_version: z.number().int().nonnegative(),
  operations: z.array(z.record(z.unknown())).min(1).max(100)
});
export const saveChangeResponseSchema = z.object({
  change_id: id,
  server_version: z.number().int().positive(),
  content_hash: contentHash
});
export const versionConflictDetailsSchema = z.object({
  server_version: z.number().int().nonnegative(),
  server_document: proseMirrorDocumentSchema,
  server_content_hash: contentHash
});

export type Work = z.infer<typeof workSchema>;
export type Volume = z.infer<typeof volumeSchema>;
export type ChapterSummary = z.infer<typeof chapterSummarySchema>;
export type Chapter = z.infer<typeof chapterSchema>;
export type TreeResponse = z.infer<typeof treeResponseSchema>;
export type CreateWorkRequest = z.infer<typeof createWorkRequestSchema>;
export type CreateWorkResponse = z.infer<typeof createWorkResponseSchema>;
export type UpdateWorkRequest = z.infer<typeof updateWorkRequestSchema>;
export type SaveChangeRequest = z.infer<typeof saveChangeRequestSchema>;
export type SaveChangeResponse = z.infer<typeof saveChangeResponseSchema>;
export type VersionConflictDetails = z.infer<typeof versionConflictDetailsSchema>;
```

将 `packages/contracts/src/index.ts` 完整写成：

```ts
export * from './api';
export * from './auth';
export * from './writing';
```

- [ ] **Step 4: 验证契约与现有包**

Run: `pnpm vitest run packages/contracts/src && pnpm --filter @storyforge/contracts typecheck`
Expected: 新旧契约测试全部 PASS，TypeScript 无错误。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add packages/contracts
git commit -m "feat: define writing persistence contracts"
```

### Task 2: 建立唯一 ProseMirror Schema 与 Step 应用链

**Files:**
- Create: `packages/editor-schema/package.json`
- Create: `packages/editor-schema/tsconfig.json`
- Create: `packages/editor-schema/src/schema.ts`
- Create: `packages/editor-schema/src/document.ts`
- Create: `packages/editor-schema/src/index.ts`
- Create: `packages/editor-schema/src/document.test.ts`

- [ ] **Step 1: 写 Step、安全校验与全文替换失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import {
  applyOperations,
  canonicalizeDocument,
  createEmptyDocument,
  parseDocument,
  replaceDocumentOperations,
  schema
} from './index';

const insert = new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text('你')), 0, 0)).toJSON();

describe('editor schema', () => {
  it('applies serializable steps and canonicalizes key order', () => {
    const next = applyOperations(createEmptyDocument(), [insert]);
    expect(next.textContent).toBe('你');
    expect(canonicalizeDocument(next)).toBe(canonicalizeDocument(JSON.parse(JSON.stringify(next))));
  });

  it('rejects unsafe links and invalid positions', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('bad', [schema.marks.link.create({ href: 'javascript:alert(1)' })])
      ])
    ]);
    expect(() => parseDocument(doc.toJSON())).toThrow('Unsafe link');
    expect(() => applyOperations(createEmptyDocument(), [{ stepType: 'replace', from: 999, to: 1000 }])).toThrow();
  });

  it('creates a valid whole-document replacement', () => {
    const target = markdownLikeDocument('新正文');
    const operations = replaceDocumentOperations(createEmptyDocument(), target);
    expect(applyOperations(createEmptyDocument(), operations).toJSON()).toEqual(target);
  });
});

function markdownLikeDocument(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run packages/editor-schema/src/document.test.ts`
Expected: FAIL，包与实现不存在。

- [ ] **Step 3: 创建包和完整实现**

`packages/editor-schema/package.json`：

```json
{
  "name": "@storyforge/editor-schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@storyforge/contracts": "workspace:*",
    "prosemirror-model": "^1.25.1",
    "prosemirror-schema-basic": "^1.2.4",
    "prosemirror-transform": "^1.10.4",
    "zod": "^3.25.0"
  },
  "devDependencies": { "typescript": "^5.8.3", "vitest": "^3.2.0" }
}
```

`packages/editor-schema/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "types": ["node"] },
  "include": ["src"]
}
```

`packages/editor-schema/src/schema.ts`：

```ts
import { Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';

export const schema = new Schema({
  nodes: basicSchema.spec.nodes.remove('image'),
  marks: basicSchema.spec.marks
});
```

`packages/editor-schema/src/document.ts`：

```ts
import { proseMirrorDocumentSchema, type ProseMirrorNode } from '@storyforge/contracts';
import { Fragment, Node, Slice } from 'prosemirror-model';
import { ReplaceStep, Step } from 'prosemirror-transform';
import { schema } from './schema';

export function createEmptyDocument(): ProseMirrorNode {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function assertSafeDocument(doc: Node): void {
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'link') {
        const href = String(mark.attrs.href ?? '');
        if (!/^(https?:|mailto:)/i.test(href)) throw new Error('Unsafe link protocol');
      }
    }
    return true;
  });
}

export function parseDocument(value: unknown): Node {
  const json = proseMirrorDocumentSchema.parse(value);
  const doc = Node.fromJSON(schema, json);
  assertSafeDocument(doc);
  doc.check();
  return doc;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)])
    );
  }
  return value;
}

export function canonicalizeDocument(value: unknown): string {
  const json = value instanceof Node ? value.toJSON() : value;
  return JSON.stringify(stable(parseDocument(json).toJSON()));
}

export function applyOperations(document: unknown, operations: Array<Record<string, unknown>>): Node {
  let doc = parseDocument(document);
  for (const operation of operations) {
    const result = Step.fromJSON(schema, operation).apply(doc);
    if (!result.doc || result.failed) {
      throw new Error(`Invalid ProseMirror step: ${result.failed ?? 'unknown failure'}`);
    }
    doc = result.doc;
    assertSafeDocument(doc);
  }
  doc.check();
  return doc;
}

export function replaceDocumentOperations(document: unknown, replacement: unknown): Array<Record<string, unknown>> {
  const current = parseDocument(document);
  const next = parseDocument(replacement);
  const operation = new ReplaceStep(0, current.content.size, new Slice(Fragment.from(next.content), 0, 0)).toJSON();
  const applied = applyOperations(current.toJSON(), [operation]);
  if (canonicalizeDocument(applied) !== canonicalizeDocument(next)) {
    throw new Error('Whole-document replacement did not produce the requested document');
  }
  return [operation];
}
```

`packages/editor-schema/src/index.ts`：

```ts
export * from './schema';
export * from './document';
```

- [ ] **Step 4: 验证 Schema 与 Step**

Run: `pnpm install && pnpm vitest run packages/editor-schema/src && pnpm --filter @storyforge/editor-schema typecheck`
Expected: 3 个测试 PASS，非法链接与越界 Step 被拒绝，TypeScript 无错误。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add packages/editor-schema pnpm-lock.yaml
git commit -m "feat: add shared ProseMirror document schema"
```

### Task 3: 建立作品、卷章节与变更表

**Files:**
- Create: `apps/api/src/database/work.entity.ts`
- Create: `apps/api/src/database/volume.entity.ts`
- Create: `apps/api/src/database/chapter.entity.ts`
- Create: `apps/api/src/database/chapter-change.entity.ts`
- Create: `apps/api/src/database/migrations/1736985600000-writing-base.ts`
- Create: `apps/api/test/writing-database.e2e-spec.ts`
- Modify: `apps/api/src/database/data-source.ts`

- [ ] **Step 1: 写迁移失败测试**

```ts
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataSource } from '../src/database/data-source';
import { destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

let testDataSource: DataSource;

describe('writing schema', () => {
  beforeAll(async () => {
    testDataSource = createDataSource(testDatabaseUrl());
    await resetTestDatabase(testDataSource);
  });
  afterAll(async () => {
    await destroyTestDatabase(testDataSource);
  });

  it('creates all writing tables, checks and idempotency indexes', async () => {
    const rows = await testDataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('works','volumes','chapters','chapter_changes') ORDER BY table_name"
    );
    expect(rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'chapter_changes', 'chapters', 'volumes', 'works'
    ]);
    const indexes = await testDataSource.query(
      "SELECT indexname FROM pg_indexes WHERE tablename='chapter_changes' AND indexname IN ('uq_chapter_client_sequence','uq_chapter_change_id') ORDER BY indexname"
    );
    expect(indexes.map((row: { indexname: string }) => row.indexname)).toEqual([
      'uq_chapter_change_id', 'uq_chapter_client_sequence'
    ]);
    expect(testDataSource.options.synchronize).toBe(false);
    expect(testDatabaseUrl()).toMatch(/\/[^/]+_test(?:\?|$)/);
  });
});
```

- [ ] **Step 2: 启动数据库并确认失败**

Run: `docker compose -f infra/docker-compose.yml up -d postgres && pnpm --filter @storyforge/api test -- writing-database.e2e-spec.ts`
Expected: FAIL，四张表和索引不存在。

- [ ] **Step 3: 写四个完整实体、显式迁移和数据源**

`apps/api/src/database/work.entity.ts`：

```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('works')
export class WorkEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) author_id!: string;
  @Column({ type: 'varchar', length: 120 }) title!: string;
  @Column({ type: 'text', default: '' }) description!: string;
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: 'active' | 'archived';
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
```

`apps/api/src/database/volume.entity.ts`：

```ts
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('volumes')
export class VolumeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 120 }) title!: string;
  @Column({ type: 'integer' }) position!: number;
}
```

`apps/api/src/database/chapter.entity.ts`：

```ts
import type { ProseMirrorNode } from '@storyforge/contracts';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('chapters')
export class ChapterEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) volume_id!: string;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'integer' }) position!: number;
  @Column({ type: 'jsonb' }) document!: ProseMirrorNode;
  @Column({ type: 'integer', default: 0 }) version!: number;
  @Column({ type: 'char', length: 64 }) content_hash!: string;
}
```

`apps/api/src/database/chapter-change.entity.ts`：

```ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('chapter_changes')
export class ChapterChangeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) chapter_id!: string;
  @Column({ type: 'uuid' }) author_id!: string;
  @Column({ type: 'uuid', unique: true }) change_id!: string;
  @Column({ type: 'uuid' }) client_id!: string;
  @Column({ type: 'integer' }) sequence!: number;
  @Column({ type: 'integer' }) base_version!: number;
  @Column({ type: 'integer' }) server_version!: number;
  @Column({ type: 'jsonb' }) operations!: Array<Record<string, unknown>>;
  @Column({ type: 'char', length: 64 }) content_hash!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
```

`apps/api/src/database/migrations/1736985600000-writing-base.ts`：

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class WritingBase1736985600000 implements MigrationInterface {
  name = 'WritingBase1736985600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE works (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        title varchar(120) NOT NULL,
        description text NOT NULL DEFAULT '',
        status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_works_author_status ON works(author_id, status)');
    await queryRunner.query(`
      CREATE TABLE volumes (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title varchar(120) NOT NULL,
        position integer NOT NULL CHECK (position >= 0)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_volumes_work_position ON volumes(work_id, position)');
    await queryRunner.query(`
      CREATE TABLE chapters (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        volume_id uuid NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        title varchar(200) NOT NULL,
        position integer NOT NULL CHECK (position >= 0),
        document jsonb NOT NULL,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        content_hash char(64) NOT NULL
      )
    `);
    await queryRunner.query('CREATE INDEX idx_chapters_volume_position ON chapters(volume_id, position)');
    await queryRunner.query('CREATE INDEX idx_chapters_work ON chapters(work_id)');
    await queryRunner.query(`
      CREATE TABLE chapter_changes (
        id uuid PRIMARY KEY,
        chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        change_id uuid NOT NULL,
        client_id uuid NOT NULL,
        sequence integer NOT NULL CHECK (sequence > 0),
        base_version integer NOT NULL CHECK (base_version >= 0),
        server_version integer NOT NULL CHECK (server_version > 0),
        operations jsonb NOT NULL,
        content_hash char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_chapter_change_id UNIQUE (change_id),
        CONSTRAINT uq_chapter_client_sequence UNIQUE (chapter_id, client_id, sequence)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS chapter_changes');
    await queryRunner.query('DROP TABLE IF EXISTS chapters');
    await queryRunner.query('DROP TABLE IF EXISTS volumes');
    await queryRunner.query('DROP TABLE IF EXISTS works');
  }
}
```

将 `apps/api/src/database/data-source.ts` 完整写成以下结构，保留 M0 的 URL 与其他连接选项，不在 M1 打开同步建表：

```ts
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { AuthorEntity } from './author.entity';
import { SessionEntity } from './session.entity';
import { WorkEntity } from './work.entity';
import { VolumeEntity } from './volume.entity';
import { ChapterEntity } from './chapter.entity';
import { ChapterChangeEntity } from './chapter-change.entity';
import { AuthBase1736899200000 } from './migrations/1736899200000-auth-base';
import { WritingBase1736985600000 } from './migrations/1736985600000-writing-base';

export function createDataSource(databaseUrl: string = env.DATABASE_URL): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [AuthorEntity, SessionEntity, WorkEntity, VolumeEntity, ChapterEntity, ChapterChangeEntity],
    migrations: [AuthBase1736899200000, WritingBase1736985600000],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
}

export const AppDataSource = createDataSource();
```

- [ ] **Step 4: 验证迁移、实体元数据与索引**

Run: `pnpm --filter @storyforge/api migration:run && pnpm --filter @storyforge/api migration:run && pnpm --filter @storyforge/api test -- writing-database.e2e-spec.ts`
Expected: 第二次迁移无待执行项，测试 PASS，四个实体均由数据源加载，`synchronize` 为 `false`。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/api/src/database apps/api/test/writing-database.e2e-spec.ts
git commit -m "feat: add writing persistence schema"
```

### Task 4: 实现作品库与默认首章 API

**Files:**
- Create: `apps/api/src/common/zod-validation.pipe.ts`
- Create: `apps/api/src/writing/writing.module.ts`
- Create: `apps/api/src/writing/work.service.ts`
- Create: `apps/api/src/writing/work.controller.ts`
- Create: `apps/api/src/writing/work.service.test.ts`
- Create: `apps/api/test/writing-fixture.ts`
- Modify: `apps/api/test/test-database.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/common/http-exception.filter.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: 写真实数据库作品服务失败测试**

`apps/api/src/writing/work.service.test.ts`：

```ts
import { createHash } from 'node:crypto';
import { canonicalizeDocument, createEmptyDocument } from '@storyforge/editor-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChapterEntity } from '../database/chapter.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { WorkService } from './work.service';

let fixture: WritingFixture;
let service: WorkService;

beforeAll(async () => {
  fixture = await createWritingFixture();
  service = new WorkService(fixture.dataSource);
});
afterAll(() => destroyWritingFixture(fixture));

describe('WorkService', () => {
  it('creates a work, default volume and empty first chapter atomically', async () => {
    const result = await service.create(fixture.authorId, { title: '新书', description: '' });
    expect(result.work.title).toBe('新书');
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({
      id: result.first_chapter_id
    });
    expect(chapter.version).toBe(0);
    expect(chapter.content_hash).toBe(
      createHash('sha256').update(canonicalizeDocument(createEmptyDocument())).digest('hex')
    );
  });

  it('lists only the current author and applies a parameterized title search', async () => {
    expect((await service.list(fixture.authorId, '夹具')).some((work) => work.id === fixture.workId)).toBe(true);
    expect((await service.list(fixture.authorId, '%')).some((work) => work.id === fixture.workId)).toBe(true);
    expect(await service.list(fixture.otherAuthorId, '夹具')).toEqual([]);
  });

  it('returns 404 when updating another author\'s work', async () => {
    await expect(service.update(fixture.otherAuthorId, fixture.workId, { title: '越权' }))
      .rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `docker compose -f infra/docker-compose.yml up -d postgres && pnpm --filter @storyforge/api test -- work.service.test.ts`
Expected: FAIL，`WorkService` 与测试夹具不存在。

- [ ] **Step 3: 实现校验管道、完整服务、控制器和测试夹具**

`apps/api/src/common/zod-validation.pipe.ts`：

```ts
import { PipeTransform, UnprocessableEntityException } from '@nestjs/common';
import type { ZodType } from 'zod';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new UnprocessableEntityException({
        message: 'Validation failed',
        details: { field_errors: result.error.flatten().fieldErrors }
      });
    }
    return result.data;
  }
}
```

`apps/api/src/writing/work.service.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { canonicalizeDocument, createEmptyDocument } from '@storyforge/editor-schema';
import type { CreateWorkRequest, CreateWorkResponse, UpdateWorkRequest, Work } from '@storyforge/contracts';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';

export function toWork(work: WorkEntity): Work {
  return {
    id: work.id,
    author_id: work.author_id,
    title: work.title,
    description: work.description,
    status: work.status,
    created_at: work.created_at.toISOString(),
    updated_at: work.updated_at.toISOString()
  };
}

@Injectable()
export class WorkService {
  constructor(private readonly dataSource: DataSource) {}

  async create(authorId: string, input: CreateWorkRequest): Promise<CreateWorkResponse> {
    return this.dataSource.transaction(async (manager) => {
      const work = await manager.getRepository(WorkEntity).save(manager.getRepository(WorkEntity).create({
        id: randomUUID(),
        author_id: authorId,
        title: input.title,
        description: input.description,
        status: 'active'
      }));
      const volume = await manager.getRepository(VolumeEntity).save(manager.getRepository(VolumeEntity).create({
        id: randomUUID(), work_id: work.id, title: '第一卷', position: 0
      }));
      const document = createEmptyDocument();
      const contentHash = createHash('sha256').update(canonicalizeDocument(document)).digest('hex');
      const chapter = await manager.getRepository(ChapterEntity).save(manager.getRepository(ChapterEntity).create({
        id: randomUUID(),
        work_id: work.id,
        volume_id: volume.id,
        title: '第一章',
        position: 0,
        document,
        version: 0,
        content_hash: contentHash
      }));
      return { work: toWork(work), first_chapter_id: chapter.id };
    });
  }

  async list(authorId: string, query = ''): Promise<Work[]> {
    const builder = this.dataSource.getRepository(WorkEntity).createQueryBuilder('work')
      .where('work.author_id = :authorId', { authorId });
    if (query.trim()) builder.andWhere('work.title ILIKE :query', { query: `%${query.trim()}%` });
    const works = await builder.orderBy('work.updated_at', 'DESC').getMany();
    return works.map(toWork);
  }

  async update(authorId: string, workId: string, input: UpdateWorkRequest): Promise<Work> {
    const repository = this.dataSource.getRepository(WorkEntity);
    const work = await repository.findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('Work not found');
    if (input.title !== undefined) work.title = input.title;
    if (input.description !== undefined) work.description = input.description;
    if (input.status !== undefined) work.status = input.status;
    return toWork(await repository.save(work));
  }
}
```

`apps/api/src/writing/work.controller.ts`：

```ts
import type { CreateWorkRequest, UpdateWorkRequest } from '@storyforge/contracts';
import { createWorkRequestSchema, updateWorkRequestSchema } from '@storyforge/contracts';
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { WorkService } from './work.service';

@Controller('works')
@UseGuards(SessionGuard)
export class WorkController {
  constructor(private readonly service: WorkService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query('q') query = '') {
    return ok(request, await this.service.list(request.author.id, query));
  }

  @Post()
  @UseGuards(CsrfGuard)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createWorkRequestSchema)) input: CreateWorkRequest
  ) {
    return ok(request, await this.service.create(request.author.id, input));
  }

  @Patch(':workId')
  @UseGuards(CsrfGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(updateWorkRequestSchema)) input: UpdateWorkRequest
  ) {
    return ok(request, await this.service.update(request.author.id, workId, input));
  }
}
```

将 `apps/api/test/test-database.ts` 完整替换为以下版本。重置和销毁必须同时清除 M1 表，否则第二次 E2E 会在已有 works/chapters 上重复执行迁移；所有入口仍强制使用 `_test` 数据库：

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

async function dropWritingAndAuthTables(dataSource: DataSource): Promise<void> {
  assertTestDatabaseUrl(String(dataSource.options.url));
  await dataSource.query('DROP TABLE IF EXISTS chapter_changes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS chapters CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS volumes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS works CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS sessions CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS authors CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS migrations CASCADE');
}

export async function resetTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) await dataSource.initialize();
  await dropWritingAndAuthTables(dataSource);
  await dataSource.runMigrations();
}

export async function clearAuthTables(dataSource: DataSource): Promise<void> {
  assertTestDatabaseUrl(String(dataSource.options.url));
  await dataSource.query('TRUNCATE TABLE chapter_changes, chapters, volumes, works, sessions, authors RESTART IDENTITY CASCADE');
}

export async function destroyTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) return;
  await dropWritingAndAuthTables(dataSource);
  await dataSource.destroy();
}
```

`apps/api/test/writing-fixture.ts` 供 Task 4、5、6 共同使用；每个夹具创建独立 `testDataSource`，连接 `TEST_DATABASE_URL` 指向的真实 PostgreSQL，不读取开发库，也不用 mock 替代事务：

```ts
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { AuthorEntity } from '../src/database/author.entity';
import { ChapterEntity } from '../src/database/chapter.entity';
import { WorkService } from '../src/writing/work.service';
import { testDatabaseUrl } from './test-database';

export interface WritingFixture {
  dataSource: DataSource;
  authorId: string;
  otherAuthorId: string;
  workId: string;
  volumeId: string;
  chapterId: string;
  clientId: string;
}

export async function createWritingFixture(): Promise<WritingFixture> {
  const testDataSource = createDataSource(testDatabaseUrl());
  await testDataSource.initialize();
  await testDataSource.runMigrations();
  const authors = testDataSource.getRepository(AuthorEntity);
  const author = await authors.save(authors.create({
    id: randomUUID(),
    email: `m1-${randomUUID()}@example.com`,
    display_name: 'M1 Author',
    password_hash: 'not-used-by-writing-tests'
  }));
  const other = await authors.save(authors.create({
    id: randomUUID(),
    email: `m1-${randomUUID()}@example.com`,
    display_name: 'Other Author',
    password_hash: 'not-used-by-writing-tests'
  }));
  const created = await new WorkService(testDataSource).create(author.id, {
    title: '夹具作品', description: '真实数据库测试'
  });
  const dataSource = testDataSource;
  const workId = created.work.id;
  const chapterId = created.first_chapter_id;
  const chapter = await dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: chapterId });
  return {
    dataSource,
    authorId: author.id,
    otherAuthorId: other.id,
    workId,
    volumeId: chapter.volume_id,
    chapterId,
    clientId: randomUUID()
  };
}

export async function destroyWritingFixture(fixture: WritingFixture): Promise<void> {
  await fixture.dataSource.getRepository(AuthorEntity).delete({
    id: fixture.authorId
  });
  await fixture.dataSource.getRepository(AuthorEntity).delete({
    id: fixture.otherAuthorId
  });
  if (fixture.dataSource.isInitialized) await fixture.dataSource.destroy();
}
```

`apps/api/src/writing/writing.module.ts` 本任务只注册作品服务，不提前注册 Task 5/6：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { WorkController } from './work.controller';
import { WorkService } from './work.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkEntity, VolumeEntity, ChapterEntity, ChapterChangeEntity]),
    AuthModule
  ],
  providers: [WorkService],
  controllers: [WorkController],
  exports: [WorkService]
})
export class WritingModule {}
```

`apps/api/src/common/http-exception.filter.ts` 保留 M0 错误码映射，并原样带出结构化 `details`：

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

`apps/api/src/app.module.ts` 完整接入 M0 模块和当前 WritingModule：

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppDataSource } from './database/data-source';
import { HealthController } from './health.controller';
import { WritingModule } from './writing/writing.module';

@Module({
  imports: [TypeOrmModule.forRoot({ ...AppDataSource.options }), AuthModule, WritingModule],
  controllers: [HealthController]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

运行以下命令补齐依赖；已在 M0 安装的包会由 pnpm 保持原版本，不重复手写 lockfile：

```bash
pnpm --filter @storyforge/api add @storyforge/editor-schema@workspace:* @nestjs/typeorm@^11 typeorm@^0.3 pg@^8
pnpm --filter @storyforge/api add -D @types/pg@^8
```

- [ ] **Step 4: 验证原子创建、参数校验与权限**

Run: `pnpm install && pnpm --filter @storyforge/api test -- work.service.test.ts && pnpm --filter @storyforge/api typecheck`
Expected: 创建、列表、搜索、跨作者 404 测试 PASS；默认首章摘要匹配；TypeScript 无错误。`createWorkRequestSchema` 的空标题拒绝由 Task 1 已验证，控制器的 Zod 管道将其映射为 422。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat: add owned work library API"
```

### Task 5: 实现卷章节树、重命名与排序 API

**Files:**
- Create: `apps/api/src/writing/structure.service.ts`
- Create: `apps/api/src/writing/structure.controller.ts`
- Create: `apps/api/src/writing/structure-input.types.ts`
- Create: `apps/api/src/writing/structure.service.test.ts`
- Modify: `apps/api/src/writing/writing.module.ts`

- [ ] **Step 1: 写完整结构服务失败测试**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { StructureService } from './structure.service';

let fixture: WritingFixture;
let service: StructureService;
let chapterBId: string;
let otherVolumeId: string;
let otherVolumeChapterId: string;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new StructureService(fixture.dataSource);
  chapterBId = (await service.createChapter(fixture.authorId, fixture.workId, fixture.volumeId, { title: '第二章' })).id;
  otherVolumeId = (await service.createVolume(fixture.authorId, fixture.workId, { title: '第二卷' })).id;
  otherVolumeChapterId = (await service.createChapter(fixture.authorId, fixture.workId, otherVolumeId, { title: '另一卷章节' })).id;
});
afterEach(() => destroyWritingFixture(fixture));

describe('StructureService', () => {
  it('rejects partial and cross-volume reorder lists', async () => {
    await expect(service.reorderChapters(fixture.authorId, fixture.workId, fixture.volumeId, [fixture.chapterId]))
      .rejects.toMatchObject({ status: 422 });
    await expect(service.reorderChapters(
      fixture.authorId,
      fixture.workId,
      fixture.volumeId,
      [fixture.chapterId, chapterBId, otherVolumeChapterId]
    )).rejects.toMatchObject({ status: 404 });
  });

  it('returns a tree without document payloads and reorders a complete parent list', async () => {
    const reordered = await service.reorderChapters(
      fixture.authorId, fixture.workId, fixture.volumeId, [chapterBId, fixture.chapterId]
    );
    expect(reordered.map((chapter) => chapter.id)).toEqual([chapterBId, fixture.chapterId]);
    const tree = await service.tree(fixture.authorId, fixture.workId);
    expect(tree.chapters[0]).not.toHaveProperty('document');
    expect(tree.volumes.map((volume) => volume.id)).toContain(otherVolumeId);
  });

  it('renames only owned resources and returns a full chapter only on explicit read', async () => {
    const renamed = await service.renameChapter(fixture.authorId, fixture.workId, fixture.chapterId, { title: '新章名' });
    expect(renamed.title).toBe('新章名');
    const chapter = await service.getChapter(fixture.authorId, fixture.workId, fixture.chapterId);
    expect(chapter.document.type).toBe('doc');
    await expect(service.getChapter(fixture.otherAuthorId, fixture.workId, fixture.chapterId))
      .rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @storyforge/api test -- structure.service.test.ts`
Expected: FAIL，`StructureService` 不存在。

- [ ] **Step 3: 写入完整结构服务与控制器**

`apps/api/src/writing/structure.service.ts`：

```ts
import type { Chapter, ChapterSummary, TreeResponse, Volume } from '@storyforge/contracts';
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { toWork } from './work.service';

function toVolume(volume: VolumeEntity): Volume {
  return { id: volume.id, work_id: volume.work_id, title: volume.title, position: volume.position };
}
function toChapterSummary(chapter: ChapterEntity): ChapterSummary {
  return {
    id: chapter.id,
    work_id: chapter.work_id,
    volume_id: chapter.volume_id,
    title: chapter.title,
    position: chapter.position,
    version: chapter.version,
    content_hash: chapter.content_hash
  };
}
async function assertOwnedWork(manager: EntityManager, workId: string, authorId: string, lock = false): Promise<WorkEntity> {
  const work = await manager.getRepository(WorkEntity).findOne({
    where: { id: workId, author_id: authorId },
    ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {})
  });
  if (!work) throw new NotFoundException('Work not found');
  return work;
}
async function ownedVolume(manager: EntityManager, workId: string, volumeId: string): Promise<VolumeEntity> {
  const volume = await manager.getRepository(VolumeEntity).findOneBy({ id: volumeId, work_id: workId });
  if (!volume) throw new NotFoundException('Volume not found');
  return volume;
}
async function ownedChapter(manager: EntityManager, workId: string, chapterId: string): Promise<ChapterEntity> {
  const chapter = await manager.getRepository(ChapterEntity).findOneBy({ id: chapterId, work_id: workId });
  if (!chapter) throw new NotFoundException('Chapter not found');
  return chapter;
}
function assertCompleteOrder<T extends { id: string }>(current: T[], orderedIds: string[]): void {
  const known = new Set(current.map((item) => item.id));
  if (orderedIds.some((id) => !known.has(id))) throw new NotFoundException('Order contains a foreign resource');
  if (orderedIds.length !== current.length || new Set(orderedIds).size !== current.length) {
    throw new UnprocessableEntityException({ message: 'Order must contain every sibling exactly once' });
  }
}

@Injectable()
export class StructureService {
  constructor(private readonly dataSource: DataSource) {}

  tree(authorId: string, workId: string): Promise<TreeResponse> {
    return this.dataSource.transaction(async (manager) => {
      const work = await assertOwnedWork(manager, workId, authorId);
      const volumes = await manager.getRepository(VolumeEntity).find({
        where: { work_id: workId }, order: { position: 'ASC' }
      });
      const chapters = await manager.getRepository(ChapterEntity).find({
        where: { work_id: workId }, order: { volume_id: 'ASC', position: 'ASC' }
      });
      return { work: toWork(work), volumes: volumes.map(toVolume), chapters: chapters.map(toChapterSummary) };
    });
  }

  createVolume(authorId: string, workId: string, input: { title: string }): Promise<Volume> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      const siblings = await manager.getRepository(VolumeEntity).findBy({ work_id: workId });
      const position = siblings.reduce((maximum, item) => Math.max(maximum, item.position + 1), 0);
      const volume = await manager.getRepository(VolumeEntity).save(manager.getRepository(VolumeEntity).create({
        id: randomUUID(), work_id: workId, title: input.title, position
      }));
      return toVolume(volume);
    });
  }

  renameVolume(authorId: string, workId: string, volumeId: string, input: { title: string }): Promise<Volume> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId);
      const volume = await ownedVolume(manager, workId, volumeId);
      volume.title = input.title;
      return toVolume(await manager.save(volume));
    });
  }

  reorderVolumes(authorId: string, workId: string, orderedIds: string[]): Promise<Volume[]> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      const repository = manager.getRepository(VolumeEntity);
      const volumes = await repository.find({ where: { work_id: workId }, order: { position: 'ASC' } });
      assertCompleteOrder(volumes, orderedIds);
      for (const [position, id] of orderedIds.entries()) await repository.update({ id, work_id: workId }, { position });
      return (await repository.find({ where: { work_id: workId }, order: { position: 'ASC' } })).map(toVolume);
    });
  }

  createChapter(authorId: string, workId: string, volumeId: string, input: { title: string }): Promise<Chapter> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      await ownedVolume(manager, workId, volumeId);
      const siblings = await manager.getRepository(ChapterEntity).findBy({ volume_id: volumeId });
      const position = siblings.reduce((maximum, item) => Math.max(maximum, item.position + 1), 0);
      const { createEmptyDocument, canonicalizeDocument } = await import('@storyforge/editor-schema');
      const { createHash } = await import('node:crypto');
      const document = createEmptyDocument();
      const chapter = await manager.getRepository(ChapterEntity).save(manager.getRepository(ChapterEntity).create({
        id: randomUUID(),
        work_id: workId,
        volume_id: volumeId,
        title: input.title,
        position,
        document,
        version: 0,
        content_hash: createHash('sha256').update(canonicalizeDocument(document)).digest('hex')
      }));
      return { ...toChapterSummary(chapter), document: chapter.document };
    });
  }

  renameChapter(authorId: string, workId: string, chapterId: string, input: { title: string }): Promise<ChapterSummary> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId);
      const chapter = await ownedChapter(manager, workId, chapterId);
      chapter.title = input.title;
      return toChapterSummary(await manager.save(chapter));
    });
  }

  reorderChapters(authorId: string, workId: string, volumeId: string, orderedIds: string[]): Promise<ChapterSummary[]> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId, true);
      await ownedVolume(manager, workId, volumeId);
      const repository = manager.getRepository(ChapterEntity);
      const chapters = await repository.find({ where: { volume_id: volumeId, work_id: workId }, order: { position: 'ASC' } });
      assertCompleteOrder(chapters, orderedIds);
      for (const [position, id] of orderedIds.entries()) {
        await repository.update({ id, work_id: workId, volume_id: volumeId }, { position });
      }
      return (await repository.find({ where: { volume_id: volumeId, work_id: workId }, order: { position: 'ASC' } }))
        .map(toChapterSummary);
    });
  }

  getChapter(authorId: string, workId: string, chapterId: string): Promise<Chapter> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedWork(manager, workId, authorId);
      const chapter = await ownedChapter(manager, workId, chapterId);
      return { ...toChapterSummary(chapter), document: chapter.document };
    });
  }
}
```

`apps/api/src/writing/structure.controller.ts`：

```ts
import type { ChapterInput, VolumeInput } from './structure-input.types';
import { chapterInputSchema, reorderRequestSchema, volumeInputSchema } from '@storyforge/contracts';
import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StructureService } from './structure.service';

@Controller('works/:workId')
@UseGuards(SessionGuard)
export class StructureController {
  constructor(private readonly service: StructureService) {}

  @Get('tree')
  async tree(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.service.tree(request.author.id, workId));
  }

  @Post('volumes')
  @UseGuards(CsrfGuard)
  async createVolume(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Body(new ZodValidationPipe(volumeInputSchema)) input: VolumeInput) {
    return ok(request, await this.service.createVolume(request.author.id, workId, input));
  }

  @Patch('volumes/:volumeId')
  @UseGuards(CsrfGuard)
  async renameVolume(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('volumeId') volumeId: string, @Body(new ZodValidationPipe(volumeInputSchema)) input: VolumeInput) {
    return ok(request, await this.service.renameVolume(request.author.id, workId, volumeId, input));
  }

  @Put('volumes/order')
  @UseGuards(CsrfGuard)
  async reorderVolumes(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Body(new ZodValidationPipe(reorderRequestSchema)) input: { ordered_ids: string[] }) {
    return ok(request, await this.service.reorderVolumes(request.author.id, workId, input.ordered_ids));
  }

  @Post('volumes/:volumeId/chapters')
  @UseGuards(CsrfGuard)
  async createChapter(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('volumeId') volumeId: string, @Body(new ZodValidationPipe(chapterInputSchema)) input: ChapterInput) {
    return ok(request, await this.service.createChapter(request.author.id, workId, volumeId, input));
  }

  @Patch('chapters/:chapterId')
  @UseGuards(CsrfGuard)
  async renameChapter(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('chapterId') chapterId: string, @Body(new ZodValidationPipe(chapterInputSchema)) input: ChapterInput) {
    return ok(request, await this.service.renameChapter(request.author.id, workId, chapterId, input));
  }

  @Put('volumes/:volumeId/chapters/order')
  @UseGuards(CsrfGuard)
  async reorderChapters(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('volumeId') volumeId: string, @Body(new ZodValidationPipe(reorderRequestSchema)) input: { ordered_ids: string[] }) {
    return ok(request, await this.service.reorderChapters(request.author.id, workId, volumeId, input.ordered_ids));
  }

  @Get('chapters/:chapterId')
  async getChapter(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('chapterId') chapterId: string) {
    return ok(request, await this.service.getChapter(request.author.id, workId, chapterId));
  }
}
```

`apps/api/src/writing/structure-input.types.ts`：

```ts
export interface VolumeInput { title: string }
export interface ChapterInput { title: string }
```

将 `apps/api/src/writing/writing.module.ts` 完整替换为以下版本；此时仍不注册 Task 6 保存服务：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { WorkController } from './work.controller';
import { WorkService } from './work.service';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorkEntity, VolumeEntity, ChapterEntity, ChapterChangeEntity]), AuthModule],
  providers: [WorkService, StructureService],
  controllers: [WorkController, StructureController],
  exports: [WorkService]
})
export class WritingModule {}
```

- [ ] **Step 4: 验证树、排序和隔离**

Run: `pnpm --filter @storyforge/api test -- structure.service.test.ts && pnpm --filter @storyforge/api typecheck`
Expected: 创建、重命名、完整排序、缺 ID 422、跨卷 404、跨作者 404、树不含正文与单章含正文全部 PASS。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/api/src/writing
git commit -m "feat: add volume and chapter tree API"
```

### Task 6: 实现原子、幂等且可冲突检测的正文保存

**Files:**
- Create: `apps/api/src/writing/chapter-save.service.ts`
- Create: `apps/api/src/writing/chapter-save.controller.ts`
- Create: `apps/api/src/writing/chapter-save.service.test.ts`
- Modify: `apps/api/src/writing/writing.module.ts`

- [ ] **Step 1: 写幂等、并发与冲突失败测试**

```ts
import { randomUUID } from 'node:crypto';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { schema } from '@storyforge/editor-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { ChapterSaveService } from './chapter-save.service';

let fixture: WritingFixture;
let service: ChapterSaveService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new ChapterSaveService(fixture.dataSource);
});
afterEach(() => destroyWritingFixture(fixture));

function input(text: string, baseVersion = 0) {
  return {
    change_id: randomUUID(),
    client_id: fixture.clientId,
    sequence: 1,
    base_version: baseVersion,
    operations: [new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text(text)), 0, 0)).toJSON()]
  };
}

describe('ChapterSaveService', () => {
  it('acknowledges a duplicate change once and preserves version', async () => {
    const request = input('你');
    const first = await service.save(fixture.authorId, fixture.workId, fixture.chapterId, request);
    const second = await service.save(fixture.authorId, fixture.workId, fixture.chapterId, request);
    expect(second).toEqual(first);
    expect(await fixture.dataSource.getRepository(ChapterEntity).countBy({ id: fixture.chapterId, version: 1 })).toBe(1);
    expect(await fixture.dataSource.getRepository(ChapterChangeEntity).countBy({ change_id: request.change_id })).toBe(1);
  });

  it('serializes concurrent duplicate requests into one record', async () => {
    const request = input('并发');
    const responses = await Promise.all([
      service.save(fixture.authorId, fixture.workId, fixture.chapterId, request),
      service.save(fixture.authorId, fixture.workId, fixture.chapterId, request)
    ]);
    expect(responses[0]).toEqual(responses[1]);
    expect(await fixture.dataSource.getRepository(ChapterChangeEntity).countBy({ change_id: request.change_id })).toBe(1);
  });

  it('returns 409 with the current server document', async () => {
    await service.save(fixture.authorId, fixture.workId, fixture.chapterId, input('服务端'));
    await expect(service.save(fixture.authorId, fixture.workId, fixture.chapterId, input('本地')))
      .rejects.toMatchObject({ status: 409, response: { details: { server_version: 1 } } });
  });

  it('rolls back an invalid step without a document, version or change record', async () => {
    const request = { ...input('无效'), operations: [{ stepType: 'replace', from: 999, to: 1000 }] };
    await expect(service.save(fixture.authorId, fixture.workId, fixture.chapterId, request))
      .rejects.toMatchObject({ status: 422 });
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: fixture.chapterId });
    expect(chapter.version).toBe(0);
    expect(chapter.document).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(await fixture.dataSource.getRepository(ChapterChangeEntity).countBy({ chapter_id: fixture.chapterId })).toBe(0);
  });

  it('rejects idempotency-key reuse with different content and cross-author access', async () => {
    const request = input('第一次');
    await service.save(fixture.authorId, fixture.workId, fixture.chapterId, request);
    await expect(service.save(fixture.authorId, fixture.workId, fixture.chapterId, {
      ...request, operations: input('不同').operations
    })).rejects.toMatchObject({ status: 409 });
    await expect(service.save(fixture.otherAuthorId, fixture.workId, fixture.chapterId, input('越权')))
      .rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @storyforge/api test -- chapter-save.service.test.ts`
Expected: FAIL，保存服务不存在。

- [ ] **Step 3: 实现锁内去重、版本校验和原子写入**

`apps/api/src/writing/chapter-save.service.ts`：

```ts
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyOperations, canonicalizeDocument } from '@storyforge/editor-schema';
import type { SaveChangeRequest, SaveChangeResponse } from '@storyforge/contracts';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';

@Injectable()
export class ChapterSaveService {
  constructor(private readonly dataSource: DataSource) {}

  save(authorId: string, workId: string, chapterId: string, input: SaveChangeRequest): Promise<SaveChangeResponse> {
    return this.dataSource.transaction(async (manager) => {
      const chapter = await manager.getRepository(ChapterEntity).createQueryBuilder('chapter')
        .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
        .where('chapter.id = :chapterId', { chapterId })
        .andWhere('chapter.work_id = :workId', { workId })
        .andWhere('work.author_id = :authorId', { authorId })
        .setLock('pessimistic_write')
        .getOne();
      if (!chapter) throw new NotFoundException('Chapter not found');

      const changes = manager.getRepository(ChapterChangeEntity);
      const existing = await changes.findOneBy({ change_id: input.change_id });
      if (existing) {
        const same = existing.chapter_id === chapterId
          && existing.author_id === authorId
          && existing.client_id === input.client_id
          && existing.sequence === input.sequence
          && existing.base_version === input.base_version
          && isDeepStrictEqual(existing.operations, input.operations);
        if (!same) throw new ConflictException({ message: 'Idempotency key reused with different content' });
        return {
          change_id: existing.change_id,
          server_version: existing.server_version,
          content_hash: existing.content_hash
        };
      }
      if (chapter.version !== input.base_version) {
        throw new ConflictException({
          message: 'Chapter version conflict',
          details: {
            server_version: chapter.version,
            server_document: chapter.document,
            server_content_hash: chapter.content_hash
          }
        });
      }

      let document;
      try {
        document = applyOperations(chapter.document, input.operations);
      } catch (error) {
        throw new UnprocessableEntityException({
          message: 'Invalid document change',
          details: { reason: error instanceof Error ? error.message : 'Invalid step' }
        });
      }
      const contentHash = createHash('sha256').update(canonicalizeDocument(document.toJSON())).digest('hex');
      const serverVersion = chapter.version + 1;
      const updated = await manager.update(ChapterEntity, { id: chapter.id, version: chapter.version }, {
        document: document.toJSON(), version: serverVersion, content_hash: contentHash
      });
      if (updated.affected !== 1) throw new ConflictException({ message: 'Chapter version conflict' });
      await changes.insert({
        id: randomUUID(),
        chapter_id: chapterId,
        author_id: authorId,
        change_id: input.change_id,
        client_id: input.client_id,
        sequence: input.sequence,
        base_version: input.base_version,
        server_version: serverVersion,
        operations: input.operations,
        content_hash: contentHash
      });
      return { change_id: input.change_id, server_version: serverVersion, content_hash: contentHash };
    });
  }
}
```

`apps/api/src/writing/chapter-save.controller.ts`：

```ts
import { saveChangeRequestSchema, type SaveChangeRequest } from '@storyforge/contracts';
import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ChapterSaveService } from './chapter-save.service';

@Controller('works/:workId/chapters/:chapterId')
@UseGuards(SessionGuard)
export class ChapterSaveController {
  constructor(private readonly service: ChapterSaveService) {}

  @Post('changes')
  @UseGuards(CsrfGuard)
  async save(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Body(new ZodValidationPipe(saveChangeRequestSchema)) input: SaveChangeRequest
  ) {
    return ok(request, await this.service.save(request.author.id, workId, chapterId, input));
  }
}
```

将 `apps/api/src/writing/writing.module.ts` 完整替换为 M1 服务端最终版本：

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { WorkController } from './work.controller';
import { WorkService } from './work.service';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { ChapterSaveController } from './chapter-save.controller';
import { ChapterSaveService } from './chapter-save.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorkEntity, VolumeEntity, ChapterEntity, ChapterChangeEntity]), AuthModule],
  providers: [WorkService, StructureService, ChapterSaveService],
  controllers: [WorkController, StructureController, ChapterSaveController],
  exports: [WorkService]
})
export class WritingModule {}
```

- [ ] **Step 4: 验证原子保存**

Run: `pnpm --filter @storyforge/api test -- chapter-save.service.test.ts && pnpm --filter @storyforge/api typecheck`
Expected: 首次保存、顺序重复、并发重复、409 服务端正文、非法 Step 回滚、幂等键滥用与跨作者 404 全部 PASS。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/api/src/writing
git commit -m "feat: save chapter changes atomically"
```

### Task 7: 迁移设计令牌并交付作品库页面

**Files:**
- Create: `packages/design-tokens/package.json`
- Create: `packages/design-tokens/tsconfig.json`
- Create: `packages/design-tokens/src/tokens.css`
- Create: `packages/design-tokens/src/theme.ts`
- Create: `packages/design-tokens/src/index.ts`
- Create: `packages/design-tokens/src/tokens.test.ts`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/works/writing-client.ts`
- Create: `apps/web/src/works/works-page.tsx`
- Create: `apps/web/src/works/works-page.test.tsx`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/auth/auth-client.ts`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: 写令牌和作品库失败测试**

`packages/design-tokens/src/tokens.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('design tokens', () => {
  it('defines both themes and required brand values', () => {
    const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
    expect(css).toContain('--brand-500: #4F46E5');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('--brand-500: #6366F1');
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('--sp-4: 16px');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
```

`apps/web/src/works/works-page.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Work } from '@storyforge/contracts';
import { createWork, listWorks, updateWork } from './writing-client';
import { WorksPage } from './works-page';

vi.mock('./writing-client', () => ({
  listWorks: vi.fn(), createWork: vi.fn(), updateWork: vi.fn()
}));

const work: Work = {
  id: crypto.randomUUID(), author_id: crypto.randomUUID(), title: '既有作品', description: '',
  status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
};

function renderPage() {
  return render(<MemoryRouter initialEntries={['/works']}><Routes>
    <Route path="/works" element={<WorksPage />} />
    <Route path="/works/:workId/write/:chapterId" element={<div>工作台深链</div>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(listWorks).mockReset().mockResolvedValue([work]);
  vi.mocked(createWork).mockReset();
  vi.mocked(updateWork).mockReset();
});

describe('WorksPage', () => {
  it('creates once while pending and opens the returned first chapter', async () => {
    let finish!: (value: { work: Work; first_chapter_id: string }) => void;
    vi.mocked(createWork).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPage();
    expect(await screen.findByText('既有作品')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '新建作品' }));
    await userEvent.type(screen.getByLabelText('作品名称'), '星河');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('button', { name: '创建中' })).toBeDisabled();
    const chapterId = crypto.randomUUID();
    finish({ work: { ...work, title: '星河' }, first_chapter_id: chapterId });
    expect(await screen.findByText('工作台深链')).toBeVisible();
    expect(createWork).toHaveBeenCalledTimes(1);
    expect(createWork).toHaveBeenCalledWith({ title: '星河', description: '' });
  });

  it('archives only after native confirmation', async () => {
    vi.mocked(updateWork).mockResolvedValue({ ...work, status: 'archived' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '归档既有作品' }));
    expect(confirm).toHaveBeenCalled();
    expect(updateWork).toHaveBeenCalledWith(work.id, { status: 'archived' });
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run packages/design-tokens/src/tokens.test.ts apps/web/src/works/works-page.test.tsx`
Expected: FAIL，令牌包和作品库不存在。

- [ ] **Step 3: 实现完整令牌、API 客户端与作品库**

`packages/design-tokens/package.json`：

```json
{
  "name": "@storyforge/design-tokens",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./tokens.css": "./src/tokens.css" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "devDependencies": { "typescript": "^5.8.3", "vitest": "^3.2.0", "@types/node": "^22" }
}
```

`packages/design-tokens/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "types": ["node"] },
  "include": ["src"]
}
```

`packages/design-tokens/src/tokens.css`：

```css
:root {
  color-scheme: light;
  --brand-50: #F5F7FF; --brand-100: #EEF2FF; --brand-400: #818CF8;
  --brand-500: #4F46E5; --brand-600: #4338CA; --brand-700: #3730A3;
  --violet-500: #7C3AED; --magenta-500: #DB2777; --cyan-500: #0891B2; --emerald-500: #059669;
  --success-500: #22C55E; --success-100: #F0FDF4; --warning-500: #F59E0B; --warning-100: #FEF3C7;
  --danger-500: #EF4444; --danger-100: #FEF2F2; --info-500: #0891B2; --info-100: #ECFEFF;
  --text-primary: #1A1A2E; --text-secondary: #475569; --text-tertiary: #94A3B8;
  --bg-primary: #F0F2F5; --bg-secondary: #FFFFFF; --bg-tertiary: #F8F9FA; --bg-hover: #EEF2F7;
  --border-color: #E2E8F0; --border-light: #F1F5F9;
  --font-sans: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', Consolas, monospace;
  --fs-display: 32px; --fs-h1: 24px; --fs-h2: 20px; --fs-h3: 16px;
  --fs-body: 14px; --fs-body-lg: 16px; --fs-small: 12px; --fs-caption: 12px; --fs-mono: 13px;
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px; --sp-8: 64px;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --shadow-sm: 0 1px 2px rgb(15 23 42 / 8%); --shadow-md: 0 8px 24px rgb(15 23 42 / 12%);
}
[data-theme="dark"] {
  color-scheme: dark;
  --brand-50: #17143B; --brand-100: #1E1B4B; --brand-400: #A5B4FC;
  --brand-500: #6366F1; --brand-600: #4F46E5; --brand-700: #4338CA;
  --success-500: #4ADE80; --success-100: #14532D; --warning-500: #FBBF24; --warning-100: #451A03;
  --danger-500: #F87171; --danger-100: #450A0A; --info-500: #22D3EE; --info-100: #164E63;
  --text-primary: #F1F5F9; --text-secondary: #94A3B8; --text-tertiary: #64748B;
  --bg-primary: #0F172A; --bg-secondary: #1E293B; --bg-tertiary: #263449; --bg-hover: #334155;
  --border-color: #334155; --border-light: #1E293B;
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 24%); --shadow-md: 0 8px 24px rgb(0 0 0 / 32%);
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font-sans); background: var(--bg-primary); color: var(--text-primary); }
button, input, textarea { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 2px solid var(--brand-500); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
```

`packages/design-tokens/src/theme.ts`：

```ts
export type Theme = 'light' | 'dark';

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('storyforge-theme', theme);
}

export function initialTheme(): Theme {
  const stored = localStorage.getItem('storyforge-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
```

`packages/design-tokens/src/index.ts`：

```ts
export * from './theme';
```

`apps/web/src/api/client.ts`：

```ts
import type { ZodType } from 'zod';

export class ApiError<T = unknown> extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: T,
    public readonly requestId: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function csrfToken(): string {
  const cookie = document.cookie.split('; ').find((item) => item.startsWith('storyforge_csrf='));
  return decodeURIComponent(cookie?.slice('storyforge_csrf='.length) ?? '');
}

export async function apiRequest<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'x-csrf-token': csrfToken() } : {}),
      ...init.headers
    }
  });
  const json = await response.json() as {
    data?: unknown;
    request_id?: string;
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      json.error?.code ?? 'UNKNOWN',
      json.error?.message ?? 'Request failed',
      json.error?.details,
      json.request_id ?? ''
    );
  }
  return schema.parse(json.data);
}
```

`apps/web/src/works/writing-client.ts` 覆盖冻结表全部端点，后续任务直接复用这些精确签名：

```ts
import { z } from 'zod';
import {
  chapterInputSchema,
  chapterSchema,
  chapterSummarySchema,
  createWorkRequestSchema,
  createWorkResponseSchema,
  reorderRequestSchema,
  saveChangeRequestSchema,
  saveChangeResponseSchema,
  treeResponseSchema,
  updateWorkRequestSchema,
  volumeInputSchema,
  volumeSchema,
  workSchema,
  type Chapter,
  type ChapterSummary,
  type CreateWorkRequest,
  type CreateWorkResponse,
  type SaveChangeRequest,
  type SaveChangeResponse,
  type TreeResponse,
  type UpdateWorkRequest,
  type Volume,
  type Work
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1/works';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export function listWorks(query = ''): Promise<Work[]> {
  return apiRequest(`${root}?q=${encodeURIComponent(query)}`, z.array(workSchema));
}
export function createWork(input: CreateWorkRequest): Promise<CreateWorkResponse> {
  return apiRequest(root, createWorkResponseSchema, json('POST', createWorkRequestSchema.parse(input)));
}
export function updateWork(workId: string, input: UpdateWorkRequest): Promise<Work> {
  return apiRequest(`${root}/${part(workId)}`, workSchema, json('PATCH', updateWorkRequestSchema.parse(input)));
}
export function getTree(workId: string): Promise<TreeResponse> {
  return apiRequest(`${root}/${part(workId)}/tree`, treeResponseSchema);
}
export function createVolume(workId: string, input: { title: string }): Promise<Volume> {
  return apiRequest(`${root}/${part(workId)}/volumes`, volumeSchema, json('POST', volumeInputSchema.parse(input)));
}
export function renameVolume(workId: string, volumeId: string, input: { title: string }): Promise<Volume> {
  return apiRequest(`${root}/${part(workId)}/volumes/${part(volumeId)}`, volumeSchema, json('PATCH', volumeInputSchema.parse(input)));
}
export function reorderVolumes(workId: string, orderedIds: string[]): Promise<Volume[]> {
  return apiRequest(`${root}/${part(workId)}/volumes/order`, z.array(volumeSchema),
    json('PUT', reorderRequestSchema.parse({ ordered_ids: orderedIds })));
}
export function createChapter(workId: string, volumeId: string, input: { title: string }): Promise<Chapter> {
  return apiRequest(`${root}/${part(workId)}/volumes/${part(volumeId)}/chapters`, chapterSchema,
    json('POST', chapterInputSchema.parse(input)));
}
export function renameChapter(workId: string, chapterId: string, input: { title: string }): Promise<ChapterSummary> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}`, chapterSummarySchema,
    json('PATCH', chapterInputSchema.parse(input)));
}
export function reorderChapters(workId: string, volumeId: string, orderedIds: string[]): Promise<ChapterSummary[]> {
  return apiRequest(`${root}/${part(workId)}/volumes/${part(volumeId)}/chapters/order`, z.array(chapterSummarySchema),
    json('PUT', reorderRequestSchema.parse({ ordered_ids: orderedIds })));
}
export function getChapter(workId: string, chapterId: string): Promise<Chapter> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}`, chapterSchema);
}
export function saveChange(workId: string, chapterId: string, input: SaveChangeRequest): Promise<SaveChangeResponse> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/changes`, saveChangeResponseSchema,
    json('POST', saveChangeRequestSchema.parse(input)));
}
```

`apps/web/src/works/works-page.tsx`：

```tsx
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Work } from '@storyforge/contracts';
import { createWork, listWorks, updateWork } from './writing-client';

export function WorksPage() {
  const navigate = useNavigate();
  const [works, setWorks] = useState<Work[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [archivingId, setArchivingId] = useState<string>();
  const [error, setError] = useState('');

  const load = useCallback(async (search = '') => {
    try { setWorks(await listWorks(search)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '作品加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    await load(query);
  }
  async function submitWork(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    setCreating(true); setError('');
    try {
      const created = await createWork({ title, description });
      navigate(`/works/${created.work.id}/write/${created.first_chapter_id}?tab=manuscript&panel=chapter`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
      setCreating(false);
    }
  }
  async function archive(work: Work) {
    if (!window.confirm(`确认归档《${work.title}》？`) || archivingId) return;
    setArchivingId(work.id); setError('');
    try { await updateWork(work.id, { status: 'archived' }); await load(query); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '归档失败'); }
    finally { setArchivingId(undefined); }
  }

  return <main className="works-page">
    <h1>作品库</h1>
    <form onSubmit={submitSearch}>
      <label htmlFor="work-search">搜索作品</label>
      <input id="work-search" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="submit">搜索</button>
      <button type="button" onClick={() => setShowForm((value) => !value)}>新建作品</button>
    </form>
    {showForm && <form onSubmit={submitWork}>
      <label htmlFor="work-title">作品名称</label>
      <input id="work-title" required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
      <label htmlFor="work-description">作品简介</label>
      <textarea id="work-description" maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} />
      <button type="submit" disabled={creating}>{creating ? '创建中' : '创建'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    <ul aria-label="作品列表">
      {works.map((work) => <li key={work.id}>
        <h2>{work.title}</h2><p>{work.description}</p><span>{work.status === 'active' ? '进行中' : '已归档'}</span>
        <button type="button" disabled={archivingId === work.id} onClick={() => void archive(work)}>
          {archivingId === work.id ? '归档中' : `归档${work.title}`}
        </button>
      </li>)}
    </ul>
  </main>;
}
```

`apps/web/package.json` 保留 M0 脚本并固定为以下完整配置：

```json
{
  "name": "@storyforge/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@storyforge/contracts": "workspace:*",
    "@storyforge/design-tokens": "workspace:*",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.6.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.8.3",
    "vite": "^6.3.0",
    "vitest": "^3.2.0"
  }
}
```

将 `apps/web/src/auth/auth-client.ts` 完整写成（登录逻辑与 M0 相同，新增会话恢复函数）：

```ts
import { loginRequestSchema, sessionResponseSchema, type LoginRequest, type SessionResponse } from '@storyforge/contracts';
import { apiRequest } from '../api/client';

export async function login(input: LoginRequest): Promise<SessionResponse> {
  const body = loginRequestSchema.parse(input);
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error?.message ?? 'Login failed');
  return sessionResponseSchema.parse(json.data);
}

export function getSession(): Promise<SessionResponse> {
  return apiRequest('/api/v1/auth/session', sessionResponseSchema);
}
```

`apps/web/src/app.tsx` 本任务只开放作品库路由，工作台路由在 Task 13 加入：

```tsx
import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { SessionResponse } from '@storyforge/contracts';
import { AuthPage } from './auth/auth-page';
import { getSession, login } from './auth/auth-client';
import { WorksPage } from './works/works-page';

export function App() {
  const [session, setSession] = useState<SessionResponse>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    getSession().then(setSession).catch(() => setSession(undefined)).finally(() => setLoading(false));
  }, []);
  if (loading) return <p role="status">正在恢复会话</p>;
  if (!session) return <AuthPage login={login} onSuccess={setSession} />;
  return <BrowserRouter><Routes>
    <Route path="/" element={<Navigate to="/works" replace />} />
    <Route path="/works" element={<WorksPage />} />
    <Route path="*" element={<Navigate to="/works" replace />} />
  </Routes></BrowserRouter>;
}
```

`apps/web/src/main.tsx`：

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { applyTheme, initialTheme } from '@storyforge/design-tokens';
import '@storyforge/design-tokens/tokens.css';
import { App } from './app';

applyTheme(initialTheme());
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
```

- [ ] **Step 4: 验证作品库**

Run: `pnpm install && pnpm vitest run packages/design-tokens/src apps/web/src/works && pnpm --filter @storyforge/web build`
Expected: 双主题、创建 pending/防重、首章深链和确认归档测试 PASS，构建成功。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add packages/design-tokens apps/web pnpm-lock.yaml
git commit -m "feat: add themed work library"
```

### Task 8: 实现严格 Markdown 双模式转换

**Files:**
- Create: `packages/editor-schema/src/markdown.ts`
- Create: `packages/editor-schema/src/markdown.test.ts`
- Modify: `packages/editor-schema/package.json`
- Modify: `packages/editor-schema/src/index.ts`

- [ ] **Step 1: 写 JSON 往返和错误定位失败测试**

```ts
import type { ProseMirrorNode } from '@storyforge/contracts';
import { describe, expect, it } from 'vitest';
import { applyOperations, replaceDocumentOperations } from './document';
import { markdownToDocument, documentToMarkdown, MarkdownSyntaxError } from './markdown';

describe('markdown conversion', () => {
  it('round-trips supported marks and blocks using JSON at the boundary', () => {
    const source = '# 标题\n\n第一段 **加粗** 与 *强调*。\n\n- 项目一\n- 项目二';
    const document: ProseMirrorNode = markdownToDocument(source);
    expect(document.type).toBe('doc');
    expect(documentToMarkdown(document)).toBe(source);
  });

  it('rejects tables, images and raw HTML with stable source locations', () => {
    expect(() => markdownToDocument('| A | B |\n| - | - |\n| 1 | 2 |')).toThrow(MarkdownSyntaxError);
    expect(() => markdownToDocument('![替代](https://example.com/a.png)')).toThrow(/Line 1, column 1/);
    expect(() => markdownToDocument('ok\n\n<script>alert(1)</script>')).toThrow(/Line 3, column 1/);
  });

  it('creates a ProseMirror replacement from converted JSON', () => {
    const previous = markdownToDocument('旧正文');
    const next = markdownToDocument('新正文');
    expect(applyOperations(previous, replaceDocumentOperations(previous, next)).toJSON()).toEqual(next);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run packages/editor-schema/src/markdown.test.ts`
Expected: FAIL，Markdown 模块不存在。

- [ ] **Step 3: 实现严格白名单和 JSON 转换**

运行：`pnpm --filter @storyforge/editor-schema add prosemirror-markdown@^1.13.2 markdown-it@^14.1 && pnpm --filter @storyforge/editor-schema add -D @types/markdown-it@^14`

`packages/editor-schema/src/markdown.ts`：

```ts
import type { ProseMirrorNode } from '@storyforge/contracts';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { parseDocument } from './document';

export class MarkdownSyntaxError extends Error {
  constructor(message: string, public readonly line: number, public readonly column: number) {
    super(`Line ${line}, column ${column}: ${message}`);
    this.name = 'MarkdownSyntaxError';
  }
}

const validator = new MarkdownIt({ html: true, linkify: false });
const allowed = new Set([
  'paragraph_open', 'paragraph_close', 'inline', 'text', 'softbreak', 'hardbreak',
  'heading_open', 'heading_close', 'bullet_list_open', 'bullet_list_close',
  'ordered_list_open', 'ordered_list_close', 'list_item_open', 'list_item_close',
  'blockquote_open', 'blockquote_close', 'code_block', 'fence', 'hr',
  'em_open', 'em_close', 'strong_open', 'strong_close', 'code_inline', 'link_open', 'link_close'
]);

function scan(tokens: Token[], sourceLines: string[]): void {
  for (const token of tokens) {
    if (!allowed.has(token.type)) {
      const line = (token.map?.[0] ?? 0) + 1;
      const column = (sourceLines[line - 1]?.search(/\S|$/) ?? 0) + 1;
      throw new MarkdownSyntaxError(`Unsupported Markdown token ${token.type}`, line, column);
    }
    if (token.children) scan(token.children, sourceLines);
  }
}

export function markdownToDocument(source: string): ProseMirrorNode {
  scan(validator.parse(source, {}), source.split('\n'));
  const parsed = defaultMarkdownParser.parse(source);
  if (!parsed) throw new MarkdownSyntaxError('Markdown parser returned no document', 1, 1);
  return parseDocument(parsed.toJSON()).toJSON() as ProseMirrorNode;
}

export function documentToMarkdown(document: unknown): string {
  return defaultMarkdownSerializer.serialize(parseDocument(document)).trimEnd();
}
```

`packages/editor-schema/src/index.ts`：

```ts
export * from './schema';
export * from './document';
export * from './markdown';
```

- [ ] **Step 4: 验证转换和无损失败**

Run: `pnpm install && pnpm vitest run packages/editor-schema/src && pnpm --filter @storyforge/editor-schema typecheck`
Expected: 标题、列表、标记往返一致；返回值为 ProseMirror JSON 而非 Node；表格、图片、原始 HTML 返回准确行列；没有输入被静默丢弃。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add packages/editor-schema pnpm-lock.yaml
git commit -m "feat: add strict Markdown document conversion"
```

### Task 9: 建立 IndexedDB 快照、WAL 与冲突备份

**Files:**
- Create: `apps/web/src/persistence/types.ts`
- Create: `apps/web/src/persistence/database.ts`
- Create: `apps/web/src/persistence/wal.ts`
- Create: `apps/web/src/persistence/wal.test.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: 写 WAL 连续确认、恢复与冲突备份失败测试**

```ts
import 'fake-indexeddb/auto';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { canonicalizeDocument, createEmptyDocument, schema } from '@storyforge/editor-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWritingDB } from './database';
import { WalError, WalStore } from './wal';
import type { Snapshot } from './types';

let ids: { workId: string; chapterId: string; clientId: string };
let store: WalStore;
const emptyHash = 'a'.repeat(64);

beforeEach(async () => {
  ids = { workId: crypto.randomUUID(), chapterId: crypto.randomUUID(), clientId: crypto.randomUUID() };
  store = new WalStore();
  await store.initialize(ids.workId, ids.chapterId, createEmptyDocument(), 0, emptyHash);
});

function insert(text: string, from: number) {
  return new ReplaceStep(from, from, new Slice(Fragment.from(schema.text(text)), 0, 0)).toJSON();
}
async function hash(document: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeDocument(document)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('WalStore', () => {
  it('advances only the acknowledged boundary and retains later pending entries', async () => {
    const first = await store.append({ ...ids, operations: [insert('你', 1)] });
    const second = await store.append({ ...ids, operations: [insert('好', 2)] });
    expect([first.base_version, second.base_version]).toEqual([0, 1]);
    expect((await store.recover(ids.workId, ids.chapterId)).document).toMatchObject({
      content: [{ content: [{ text: '你好' }] }]
    });
    const firstDocument = (await store.recover(ids.workId, ids.chapterId)).baseDocument;
    const acknowledgedDocument = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '你' }] }] };
    await store.acknowledge(first.change_id, 1, await hash(acknowledgedDocument));
    expect(firstDocument.type).toBe('doc');
    const recovered = await store.recover(ids.workId, ids.chapterId);
    expect(recovered.baseVersion).toBe(1);
    expect(recovered.pending.map((entry) => entry.change_id)).toEqual([second.change_id]);
    expect(recovered.document).toMatchObject({ content: [{ content: [{ text: '你好' }] }] });
    await store.acknowledge(first.change_id, 1, await hash(acknowledgedDocument));
    expect((await store.recover(ids.workId, ids.chapterId)).pending).toHaveLength(1);
  });

  it('backs up base, local, server and raw pending data before conflict resolution', async () => {
    await store.append({ ...ids, operations: [insert('本地', 1)] });
    const local = (await store.recover(ids.workId, ids.chapterId)).document;
    const server = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '服务端' }] }] };
    const entry = await store.resolveConflict({
      ...ids,
      baseDocument: createEmptyDocument(), baseVersion: 0, localDocument: local,
      serverDocument: server, serverVersion: 2, serverContentHash: await hash(server), selectedDocument: local
    });
    expect(entry?.base_version).toBe(2);
    const db = await openWritingDB();
    const backups = (await db.getAll('conflicts')).filter((item) => item.chapter_id === ids.chapterId);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ base_version: 0, server_version: 2 });
    expect(backups[0]?.pending).toHaveLength(1);
    expect((await store.recover(ids.workId, ids.chapterId)).pending).toHaveLength(1);
    expect(JSON.parse(await store.exportChapter(ids.workId, ids.chapterId)).changes).toHaveLength(1);
  });

  it('persists Markdown and classifies quota and corruption without deleting data', async () => {
    await store.saveMarkdown(ids.chapterId, '# 草稿');
    expect(await store.readMarkdown(ids.chapterId)).toBe('# 草稿');
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await expect(store.append({ ...ids, operations: [insert('失败', 1)] })).rejects.toMatchObject({ kind: 'quota' });
    const db = await openWritingDB();
    const snapshot = await db.get('snapshots', [ids.workId, ids.chapterId]);
    await db.put('snapshots', { ...snapshot!, document: { type: 'paragraph' } } as Snapshot);
    await expect(store.recover(ids.workId, ids.chapterId)).rejects.toBeInstanceOf(WalError);
    expect(await db.get('snapshots', [ids.workId, ids.chapterId])).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @storyforge/web test -- wal.test.ts`
Expected: FAIL，WAL 模块不存在。

- [ ] **Step 3: 实现数据库、完整 WAL 和备份语义**

运行：`pnpm --filter @storyforge/web add idb@^8 @storyforge/editor-schema@workspace:* && pnpm --filter @storyforge/web add -D fake-indexeddb@^6`

`apps/web/src/persistence/types.ts`：

```ts
import type { ProseMirrorNode } from '@storyforge/contracts';

export interface Snapshot {
  work_id: string;
  chapter_id: string;
  document: ProseMirrorNode;
  server_version: number;
  content_hash: string;
}
export interface WalEntry {
  change_id: string;
  work_id: string;
  chapter_id: string;
  client_id: string;
  sequence: number;
  base_version: number;
  operations: Array<Record<string, unknown>>;
  created_at: string;
  sync_state: 'pending';
}
export interface SequenceRecord { chapter_id: string; client_id: string; sequence: number }
export interface MarkdownRecord { chapter_id: string; source: string; updated_at: string }
export interface ConflictBackup {
  id: string;
  work_id: string;
  chapter_id: string;
  base_document: ProseMirrorNode;
  base_version: number;
  local_document: ProseMirrorNode;
  server_document: ProseMirrorNode;
  server_version: number;
  pending: WalEntry[];
  created_at: string;
}
export interface LeaseRecord {
  chapter_id: string;
  owner_id: string;
  fencing_token: number;
  expires_at: number;
}
export interface Recovery {
  document: ProseMirrorNode;
  baseDocument: ProseMirrorNode;
  baseVersion: number;
  pending: WalEntry[];
}
export interface ConflictResolution {
  workId: string;
  chapterId: string;
  clientId: string;
  baseDocument: ProseMirrorNode;
  baseVersion: number;
  localDocument: ProseMirrorNode;
  serverDocument: ProseMirrorNode;
  serverVersion: number;
  serverContentHash: string;
  selectedDocument: ProseMirrorNode;
}
```

`apps/web/src/persistence/database.ts`：

```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ConflictBackup, LeaseRecord, MarkdownRecord, SequenceRecord, Snapshot, WalEntry } from './types';

export interface WritingDB extends DBSchema {
  snapshots: { key: [string, string]; value: Snapshot };
  changes: { key: string; value: WalEntry; indexes: { 'by-chapter': [string, string] } };
  sequences: { key: [string, string]; value: SequenceRecord };
  markdown: { key: string; value: MarkdownRecord };
  conflicts: { key: string; value: ConflictBackup };
  leases: { key: string; value: LeaseRecord };
}

let database: Promise<IDBPDatabase<WritingDB>> | undefined;
export function openWritingDB(): Promise<IDBPDatabase<WritingDB>> {
  database ??= openDB<WritingDB>('storyforge-writing', 1, {
    upgrade(db) {
      db.createObjectStore('snapshots', { keyPath: ['work_id', 'chapter_id'] });
      const changes = db.createObjectStore('changes', { keyPath: 'change_id' });
      changes.createIndex('by-chapter', ['work_id', 'chapter_id']);
      db.createObjectStore('sequences', { keyPath: ['chapter_id', 'client_id'] });
      db.createObjectStore('markdown', { keyPath: 'chapter_id' });
      db.createObjectStore('conflicts', { keyPath: 'id' });
      db.createObjectStore('leases', { keyPath: 'chapter_id' });
    }
  });
  return database;
}
```

`apps/web/src/persistence/wal.ts`：

```ts
import type { ProseMirrorNode } from '@storyforge/contracts';
import {
  applyOperations,
  canonicalizeDocument,
  parseDocument,
  replaceDocumentOperations
} from '@storyforge/editor-schema';
import { openWritingDB } from './database';
import type { ConflictResolution, Recovery, Snapshot, WalEntry } from './types';

export class WalError extends Error {
  constructor(public readonly kind: 'quota' | 'corrupt' | 'unknown', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WalError';
  }
}
export function toWalError(error: unknown): WalError {
  if (error instanceof WalError) return error;
  if (error instanceof DOMException && ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error.name)) {
    return new WalError('quota', 'IndexedDB storage quota exceeded', { cause: error });
  }
  if (error instanceof Error && /document|ProseMirror|step|snapshot|JSON|Schema|node/i.test(error.message)) {
    return new WalError('corrupt', 'Local writing data is corrupt', { cause: error });
  }
  return new WalError('unknown', 'IndexedDB writing operation failed', { cause: error });
}
function sortPending(entries: WalEntry[]): WalEntry[] {
  return entries.sort((left, right) => left.base_version - right.base_version
    || left.client_id.localeCompare(right.client_id) || left.sequence - right.sequence);
}
async function sha256(document: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeDocument(document)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function run<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw toWalError(error); }
}

export class WalStore {
  initialize(workId: string, chapterId: string, document: unknown, serverVersion: number, contentHash: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      const key: [string, string] = [workId, chapterId];
      const existing = await db.get('snapshots', key);
      if (!existing) {
        await db.put('snapshots', {
          work_id: workId,
          chapter_id: chapterId,
          document: parseDocument(document).toJSON() as ProseMirrorNode,
          server_version: serverVersion,
          content_hash: contentHash
        });
      }
    });
  }

  append(input: { workId: string; chapterId: string; clientId: string; operations: Array<Record<string, unknown>> }): Promise<WalEntry> {
    return run(async () => {
      const db = await openWritingDB();
      const tx = db.transaction(['snapshots', 'changes', 'sequences'], 'readwrite');
      const snapshot = await tx.objectStore('snapshots').get([input.workId, input.chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await tx.objectStore('changes').index('by-chapter').getAll([input.workId, input.chapterId]));
      const previous = await tx.objectStore('sequences').get([input.chapterId, input.clientId]);
      const last = pending.at(-1);
      const entry: WalEntry = {
        change_id: crypto.randomUUID(),
        work_id: input.workId,
        chapter_id: input.chapterId,
        client_id: input.clientId,
        sequence: (previous?.sequence ?? 0) + 1,
        base_version: last ? last.base_version + 1 : snapshot.server_version,
        operations: input.operations,
        created_at: new Date().toISOString(),
        sync_state: 'pending'
      };
      const base = applyOperations(
        snapshot.document,
        pending.flatMap((item) => item.operations)
      ).toJSON();
      applyOperations(base, entry.operations);
      await tx.objectStore('changes').add(entry);
      await tx.objectStore('sequences').put({ chapter_id: input.chapterId, client_id: input.clientId, sequence: entry.sequence });
      await tx.done;
      return entry;
    });
  }

  recover(workId: string, chapterId: string): Promise<Recovery> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [workId, chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]));
      const document = applyOperations(snapshot.document, pending.flatMap((entry) => entry.operations));
      return {
        document: document.toJSON() as ProseMirrorNode,
        baseDocument: parseDocument(snapshot.document).toJSON() as ProseMirrorNode,
        baseVersion: snapshot.server_version,
        pending
      };
    });
  }

  nextPending(workId: string, chapterId: string): Promise<WalEntry | undefined> {
    return run(async () => {
      const db = await openWritingDB();
      return sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]))[0];
    });
  }

  acknowledge(changeId: string, serverVersion: number, contentHash: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      const existing = await db.get('changes', changeId);
      if (!existing) return;
      const existingSnapshot = await db.get('snapshots', [existing.work_id, existing.chapter_id]);
      if (!existingSnapshot) throw new Error('Snapshot not found');
      const existingPending = sortPending(
        await db.getAllFromIndex('changes', 'by-chapter', [existing.work_id, existing.chapter_id])
      );
      if (existingPending[0]?.change_id !== changeId) {
        throw new Error('Cannot acknowledge beyond the contiguous WAL boundary');
      }
      if (serverVersion !== existingSnapshot.server_version + 1 || existing.base_version !== existingSnapshot.server_version) {
        throw new Error('Snapshot version does not match acknowledged change');
      }
      const document = applyOperations(existingSnapshot.document, existing.operations).toJSON();
      if (await sha256(document) !== contentHash) throw new Error('Acknowledged content hash does not match WAL');

      const tx = db.transaction(['snapshots', 'changes'], 'readwrite');
      const current = await tx.objectStore('changes').get(changeId);
      if (!current) { await tx.done; return; }
      const snapshot = await tx.objectStore('snapshots').get([current.work_id, current.chapter_id]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(
        await tx.objectStore('changes').index('by-chapter').getAll([current.work_id, current.chapter_id])
      );
      if (pending[0]?.change_id !== changeId) {
        throw new Error('Cannot acknowledge beyond the contiguous WAL boundary');
      }
      if (serverVersion !== snapshot.server_version + 1 || current.base_version !== snapshot.server_version) {
        throw new Error('Snapshot version does not match acknowledged change');
      }
      const currentDocument = applyOperations(snapshot.document, current.operations).toJSON();
      if (canonicalizeDocument(currentDocument) !== canonicalizeDocument(document)) {
        throw new Error('WAL changed while the acknowledgement hash was computed');
      }
      const nextSnapshot: Snapshot = {
        ...snapshot,
        document: currentDocument as ProseMirrorNode,
        server_version: serverVersion,
        content_hash: contentHash
      };
      await tx.objectStore('snapshots').put(nextSnapshot);
      await tx.objectStore('changes').delete(changeId);
      await tx.done;
    });
  }

  async saveMarkdown(chapterId: string, source: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      await db.put('markdown', { chapter_id: chapterId, source, updated_at: new Date().toISOString() });
    });
  }
  async readMarkdown(chapterId: string): Promise<string | undefined> {
    return run(async () => (await (await openWritingDB()).get('markdown', chapterId))?.source);
  }

  resolveConflict(input: ConflictResolution): Promise<WalEntry | undefined> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [input.workId, input.chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [input.workId, input.chapterId]));
      await db.put('conflicts', {
        id: crypto.randomUUID(), work_id: input.workId, chapter_id: input.chapterId,
        base_document: input.baseDocument, base_version: input.baseVersion,
        local_document: input.localDocument, server_document: input.serverDocument,
        server_version: input.serverVersion, pending, created_at: new Date().toISOString()
      });
      const tx = db.transaction(['snapshots', 'changes', 'sequences'], 'readwrite');
      for (const entry of pending) await tx.objectStore('changes').delete(entry.change_id);
      await tx.objectStore('snapshots').put({
        ...snapshot,
        document: parseDocument(input.serverDocument).toJSON() as ProseMirrorNode,
        server_version: input.serverVersion,
        content_hash: input.serverContentHash
      });
      let entry: WalEntry | undefined;
      if (canonicalizeDocument(input.selectedDocument) !== canonicalizeDocument(input.serverDocument)) {
        const previous = await tx.objectStore('sequences').get([input.chapterId, input.clientId]);
        entry = {
          change_id: crypto.randomUUID(), work_id: input.workId, chapter_id: input.chapterId,
          client_id: input.clientId, sequence: (previous?.sequence ?? 0) + 1,
          base_version: input.serverVersion,
          operations: replaceDocumentOperations(input.serverDocument, input.selectedDocument),
          created_at: new Date().toISOString(), sync_state: 'pending'
        };
        await tx.objectStore('changes').add(entry);
        await tx.objectStore('sequences').put({ chapter_id: input.chapterId, client_id: input.clientId, sequence: entry.sequence });
      }
      await tx.done;
      return entry;
    });
  }

  restoreFromServer(workId: string, chapterId: string, serverDocument: ProseMirrorNode, serverVersion: number, serverContentHash: string): Promise<void> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [workId, chapterId]);
      if (!snapshot) throw new Error('Snapshot not found');
      const pending = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]));
      let local = snapshot.document;
      try { local = applyOperations(snapshot.document, pending.flatMap((entry) => entry.operations)).toJSON() as ProseMirrorNode; }
      catch { local = snapshot.document; }
      await db.put('conflicts', {
        id: crypto.randomUUID(), work_id: workId, chapter_id: chapterId,
        base_document: snapshot.document, base_version: snapshot.server_version,
        local_document: local, server_document: serverDocument, server_version: serverVersion,
        pending, created_at: new Date().toISOString()
      });
      const tx = db.transaction(['snapshots', 'changes'], 'readwrite');
      for (const entry of pending) await tx.objectStore('changes').delete(entry.change_id);
      await tx.objectStore('snapshots').put({ ...snapshot, document: serverDocument, server_version: serverVersion, content_hash: serverContentHash });
      await tx.done;
    });
  }

  exportChapter(workId: string, chapterId: string): Promise<string> {
    return run(async () => {
      const db = await openWritingDB();
      const snapshot = await db.get('snapshots', [workId, chapterId]);
      const changes = sortPending(await db.getAllFromIndex('changes', 'by-chapter', [workId, chapterId]));
      const markdown = await db.get('markdown', chapterId);
      const conflicts = (await db.getAll('conflicts')).filter((item) => item.work_id === workId && item.chapter_id === chapterId);
      return JSON.stringify({ format: 'storyforge-wal-v1', exported_at: new Date().toISOString(), snapshot, changes, markdown, conflicts }, null, 2);
    });
  }
}
```

- [ ] **Step 4: 验证 WAL、确认边界与异常**

Run: `pnpm install && pnpm --filter @storyforge/web test -- wal.test.ts && pnpm --filter @storyforge/web typecheck`
Expected: 两次 append 版本为 0/1；第一次确认后快照为 1、第二条仍 pending 且回放正文不丢；重复确认不重复应用；冲突备份含三方和原始日志；quota/corrupt 不删除数据。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/web/src/persistence apps/web/package.json pnpm-lock.yaml
git commit -m "feat: persist local chapter write ahead logs"
```

### Task 10: 实现单章节多标签写入租约

**Files:**
- Create: `apps/web/src/persistence/write-lease.ts`
- Create: `apps/web/src/persistence/write-lease.test.ts`

- [ ] **Step 1: 写互斥、超时、fencing 与心跳失败测试**

```ts
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteLease } from './write-lease';

const leases: WriteLease[] = [];
afterEach(async () => {
  await Promise.all(leases.map((lease) => lease.stop()));
  leases.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('WriteLease', () => {
  it('allows one writer and permits explicit takeover only after expiry', async () => {
    vi.useFakeTimers();
    const chapterId = crypto.randomUUID();
    const first = new WriteLease(chapterId, crypto.randomUUID());
    const second = new WriteLease(chapterId, crypto.randomUUID());
    leases.push(first, second);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(await second.takeover()).toBe(false);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await second.takeover()).toBe(true);
    expect(second.currentToken).toBeGreaterThan(first.currentToken);
    expect(await first.heartbeat()).toBe(false);
    expect(first.canWrite()).toBe(false);
  });

  it('heartbeats every five seconds and prevents expiry takeover while alive', async () => {
    vi.useFakeTimers();
    const chapterId = crypto.randomUUID();
    const first = new WriteLease(chapterId, crypto.randomUUID());
    const second = new WriteLease(chapterId, crypto.randomUUID());
    leases.push(first, second);
    expect(await first.start(vi.fn())).toBe(true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(first.canWrite()).toBe(true);
    expect(await second.takeover()).toBe(false);
    await first.stop();
    expect(await second.acquire()).toBe(true);
    await second.release();
    expect(second.canWrite()).toBe(false);
  });

  it('stops heartbeats and reports loss immediately', async () => {
    vi.useFakeTimers();
    const first = new WriteLease(crypto.randomUUID(), crypto.randomUUID());
    leases.push(first);
    const lost = vi.fn();
    expect(await first.start(lost)).toBe(true);
    vi.spyOn(first, 'heartbeat').mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(first.canWrite()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @storyforge/web test -- write-lease.test.ts`
Expected: FAIL，租约模块不存在。

- [ ] **Step 3: 实现原子 IndexedDB 租约和 fencing token**

`apps/web/src/persistence/write-lease.ts`：

```ts
import { openWritingDB } from './database';

export class WriteLease {
  readonly ttlMs = 15_000;
  readonly heartbeatMs = 5_000;
  private token = 0;
  private held = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly chapterId: string, private readonly ownerId: string) {}
  get currentToken(): number { return this.token; }
  canWrite(): boolean { return this.held; }
  acquire(): Promise<boolean> { return this.claim(false); }

  private arm(onLost: () => void): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.heartbeat().then((alive) => {
        if (!alive && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
          this.held = false;
          onLost();
        }
      });
    }, this.heartbeatMs);
  }

  private async startClaim(takeover: boolean, onLost: () => void): Promise<boolean> {
    const acquired = await this.claim(takeover);
    if (acquired) this.arm(onLost);
    return acquired;
  }

  private async claim(takeover: boolean): Promise<boolean> {
    const db = await openWritingDB();
    const tx = db.transaction('leases', 'readwrite');
    const current = await tx.store.get(this.chapterId);
    const now = Date.now();
    const otherActive = current && current.owner_id !== this.ownerId && current.expires_at > now;
    const otherExpiredNeedsTakeover = current && current.owner_id !== this.ownerId && current.expires_at <= now && !takeover;
    if (otherActive || otherExpiredNeedsTakeover) {
      this.held = false;
      await tx.done;
      return false;
    }
    this.token = current?.owner_id === this.ownerId ? current.fencing_token : (current?.fencing_token ?? 0) + 1;
    await tx.store.put({
      chapter_id: this.chapterId,
      owner_id: this.ownerId,
      fencing_token: this.token,
      expires_at: now + this.ttlMs
    });
    await tx.done;
    this.held = true;
    return true;
  }

  async heartbeat(): Promise<boolean> {
    const db = await openWritingDB();
    const tx = db.transaction('leases', 'readwrite');
    const current = await tx.store.get(this.chapterId);
    if (!current || current.owner_id !== this.ownerId || current.fencing_token !== this.token || current.expires_at <= Date.now()) {
      this.held = false;
      await tx.done;
      return false;
    }
    await tx.store.put({ ...current, expires_at: Date.now() + this.ttlMs });
    await tx.done;
    this.held = true;
    return true;
  }

  start(onLost: () => void): Promise<boolean> {
    return this.startClaim(false, onLost);
  }

  takeover(onLost: () => void = () => undefined): Promise<boolean> {
    return this.startClaim(true, onLost);
  }

  async release(): Promise<void> {
    const db = await openWritingDB();
    const tx = db.transaction('leases', 'readwrite');
    const current = await tx.store.get(this.chapterId);
    if (current?.owner_id === this.ownerId && current.fencing_token === this.token) await tx.store.delete(this.chapterId);
    await tx.done;
    this.held = false;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.token > 0) await this.release();
  }
}
```

页面隐藏不调用 `stop()`；组件卸载才调用。保存控制器每次 append/flush 都必须同时检查 `lease.canWrite()`，因此旧标签即使从休眠恢复，也不能用旧 fencing token 覆盖新写入页。

- [ ] **Step 4: 验证租约**

Run: `pnpm --filter @storyforge/web test -- write-lease.test.ts && pnpm --filter @storyforge/web typecheck`
Expected: 互斥、未超时接管失败、无心跳时超时接管、fencing token 防旧页心跳、5 秒心跳阻止过期接管、丢失回调只触发一次与释放测试 PASS。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/web/src/persistence/write-lease.ts apps/web/src/persistence/write-lease.test.ts
git commit -m "feat: protect chapters with write leases"
```

### Task 11: 实现 ProseMirror 与 Markdown 双模式编辑器

**Files:**
- Create: `apps/web/src/editor/prosemirror-editor.tsx`
- Create: `apps/web/src/editor/markdown-editor.tsx`
- Create: `apps/web/src/editor/editor-pane.tsx`
- Create: `apps/web/src/editor/editor-pane.test.tsx`
- Modify: `apps/web/package.json`

- [ ] **Step 1: 写编辑与 Markdown 失败保留测试**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createEmptyDocument } from '@storyforge/editor-schema';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorPane } from './editor-pane';

beforeAll(() => {
  Range.prototype.getClientRects = (): DOMRectList => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator]
  }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

describe('EditorPane', () => {
  it('keeps invalid Markdown source and the last valid document', async () => {
    const onDocument = vi.fn();
    render(<EditorPane initialDocument={createEmptyDocument()} readOnly={false}
      onDocument={onDocument} onMarkdownDraft={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    const source = screen.getByLabelText('Markdown 正文');
    await userEvent.type(source, '<script>alert(1)</script>');
    await userEvent.click(screen.getByRole('button', { name: '富文本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Line 1, column 1');
    expect(source).toHaveValue('<script>alert(1)</script>');
    expect(onDocument).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Markdown 正文')).toBeVisible();
  });

  it('uses a non-editable ProseMirror view in read-only mode', async () => {
    const { container } = render(<EditorPane initialDocument={createEmptyDocument()} readOnly
      onDocument={vi.fn()} onMarkdownDraft={vi.fn().mockResolvedValue(undefined)} />);
    expect(container.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @storyforge/web test -- editor-pane.test.tsx`
Expected: FAIL，编辑器组件不存在。

- [ ] **Step 3: 实现完整编辑器组件**

运行：`pnpm --filter @storyforge/web add prosemirror-state prosemirror-view prosemirror-history prosemirror-keymap prosemirror-commands`

`apps/web/src/editor/prosemirror-editor.tsx`：

```tsx
import type { ProseMirrorNode } from '@storyforge/contracts';
import { canonicalizeDocument, parseDocument, schema } from '@storyforge/editor-schema';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useEffect, useRef } from 'react';
import 'prosemirror-view/style/prosemirror.css';

interface Props {
  initialDocument: ProseMirrorNode;
  readOnly: boolean;
  onDocument(operations: Array<Record<string, unknown>>, document: ProseMirrorNode): void;
}

export function ProseMirrorEditor({ initialDocument, readOnly, onDocument }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const callback = useRef(onDocument);
  callback.current = onDocument;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: parseDocument(initialDocument),
      plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }), keymap(baseKeymap)]
    });
    const editor = new EditorView(host.current, {
      state,
      editable: () => !readOnly,
      dispatchTransaction(transaction) {
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        if (transaction.docChanged) {
          callback.current(transaction.steps.map((step) => step.toJSON()), next.doc.toJSON() as ProseMirrorNode);
        }
      }
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
  }, []);

  useEffect(() => { view.current?.setProps({ editable: () => !readOnly }); }, [readOnly]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const next = parseDocument(initialDocument);
    if (canonicalizeDocument(editor.state.doc.toJSON()) === canonicalizeDocument(next.toJSON())) return;
    editor.updateState(EditorState.create({ doc: next, plugins: editor.state.plugins }));
  }, [initialDocument]);
  return <div ref={host} aria-label="富文本正文" />;
}
```

`apps/web/src/editor/markdown-editor.tsx`：

```tsx
interface Props {
  source: string;
  readOnly: boolean;
  error: string;
  onChange(source: string): void;
}
export function MarkdownEditor({ source, readOnly, error, onChange }: Props) {
  return <div>
    <label htmlFor="markdown-source">Markdown 正文</label>
    <textarea id="markdown-source" rows={24} readOnly={readOnly} value={source}
      onChange={(event) => onChange(event.target.value)} aria-describedby={error ? 'markdown-error' : undefined} />
    {error && <p id="markdown-error" role="alert">{error}</p>}
  </div>;
}
```

`apps/web/src/editor/editor-pane.tsx`：

```tsx
import type { ProseMirrorNode } from '@storyforge/contracts';
import {
  canonicalizeDocument,
  documentToMarkdown,
  markdownToDocument,
  replaceDocumentOperations
} from '@storyforge/editor-schema';
import { useCallback, useEffect, useState } from 'react';
import { MarkdownEditor } from './markdown-editor';
import { ProseMirrorEditor } from './prosemirror-editor';

export interface EditorPaneProps {
  initialDocument: ProseMirrorNode;
  readOnly: boolean;
  onDocument(operations: Array<Record<string, unknown>>, document: ProseMirrorNode): void;
  onMarkdownDraft(source: string): Promise<void>;
}

export function EditorPane({ initialDocument, readOnly, onDocument, onMarkdownDraft }: EditorPaneProps) {
  const [document, setDocument] = useState(initialDocument);
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setDocument(initialDocument), [initialDocument]);

  const commit = useCallback((next: ProseMirrorNode) => {
    if (canonicalizeDocument(next) === canonicalizeDocument(document)) { setError(''); return; }
    const operations = replaceDocumentOperations(document, next);
    setDocument(next); setError(''); onDocument(operations, next);
  }, [document, onDocument]);

  useEffect(() => {
    if (mode !== 'markdown' || readOnly) return;
    const timer = setTimeout(() => {
      try { commit(markdownToDocument(source)); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Markdown 解析失败'); }
    }, 500);
    return () => clearTimeout(timer);
  }, [commit, mode, readOnly, source]);

  function showMarkdown() {
    setSource(documentToMarkdown(document)); setError(''); setMode('markdown');
  }
  function showRich() {
    if (mode === 'rich') return;
    try { commit(markdownToDocument(source)); setMode('rich'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Markdown 解析失败'); }
  }
  function changeSource(next: string) {
    setSource(next);
    void onMarkdownDraft(next).catch((cause) => setError(cause instanceof Error ? cause.message : 'Markdown 草稿保存失败'));
  }

  return <section aria-label="正文编辑器">
    <div role="group" aria-label="编辑模式">
      <button type="button" aria-pressed={mode === 'rich'} onClick={showRich}>富文本</button>
      <button type="button" aria-pressed={mode === 'markdown'} onClick={showMarkdown}>Markdown</button>
    </div>
    {mode === 'rich'
      ? <ProseMirrorEditor initialDocument={document} readOnly={readOnly} onDocument={(operations, next) => {
          setDocument(next); onDocument(operations, next);
        }} />
      : <MarkdownEditor source={source} readOnly={readOnly} error={error} onChange={changeSource} />}
  </section>;
}
```

- [ ] **Step 4: 验证编辑行为**

Run: `pnpm install && pnpm --filter @storyforge/web test -- editor-pane.test.tsx && pnpm --filter @storyforge/web build`
Expected: 非法 Markdown 保留源码和旧正文、错误含行列、只读视图不可编辑、构建成功；共享 Schema 与 history/keymap 插件由同一 EditorView 使用，无 `dangerouslySetInnerHTML`。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/web/src/editor apps/web/package.json pnpm-lock.yaml
git commit -m "feat: add dual mode manuscript editor"
```

### Task 12: 串联 WAL 自动保存、恢复和人工冲突解决

**Files:**
- Create: `apps/web/src/editor/use-chapter-writer.ts`
- Create: `apps/web/src/editor/save-status.tsx`
- Create: `apps/web/src/editor/conflict-dialog.tsx`
- Create: `apps/web/src/editor/use-chapter-writer.test.tsx`
- Create: `apps/web/src/editor/save-status.test.tsx`

- [ ] **Step 1: 写保存确认、恢复入口与 409 状态失败测试**

```tsx
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { applyOperations, canonicalizeDocument, createEmptyDocument, schema } from '@storyforge/editor-schema';
import type { Chapter, SaveChangeRequest } from '@storyforge/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { WalStore } from '../persistence/wal';
import { useChapterWriter, type WriterLease } from './use-chapter-writer';

const lease: WriterLease = {
  start: vi.fn().mockResolvedValue(true),
  takeover: vi.fn().mockResolvedValue(true),
  stop: vi.fn().mockResolvedValue(undefined),
  canWrite: () => true
};
const insert = new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text('你')), 0, 0)).toJSON();
const document = applyOperations(createEmptyDocument(), [insert]).toJSON();
const digest = (value: unknown) => createHash('sha256').update(canonicalizeDocument(value)).digest('hex');

function options(save: (input: SaveChangeRequest) => Promise<{ change_id: string; server_version: number; content_hash: string }>) {
  const workId = crypto.randomUUID();
  const chapterId = crypto.randomUUID();
  const chapter: Chapter = {
    id: chapterId, work_id: workId, volume_id: crypto.randomUUID(), title: '第一章', position: 0,
    version: 0, content_hash: digest(createEmptyDocument()), document: createEmptyDocument()
  };
  const store = new WalStore();
  return {
    chapter, workId, chapterId, clientId: crypto.randomUUID(), store, lease,
    loadChapter: vi.fn().mockResolvedValue(chapter),
    saveChange: vi.fn().mockImplementation((_workId: string, _chapterId: string, input: SaveChangeRequest) => save(input))
  };
}

describe('useChapterWriter', () => {
  it('acknowledges only after the server response', async () => {
    const config = options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) }));
    const acknowledge = vi.spyOn(config.store, 'acknowledge');
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    expect(result.current.status).toBe('local_saved');
    expect(acknowledge).not.toHaveBeenCalled();
    await act(() => result.current.flush());
    expect(acknowledge).toHaveBeenCalledWith(expect.any(String), 1, digest(document));
    expect(result.current.status).toBe('synced');
  });

  it('flushes pending changes before releasing the lease on unmount', async () => {
    const localLease: WriterLease = {
      start: vi.fn().mockResolvedValue(true),
      takeover: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      canWrite: () => true
    };
    const config = {
      ...options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) })),
      lease: localLease
    };
    const acknowledge = vi.spyOn(config.store, 'acknowledge');
    const { result, unmount } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    unmount();
    await waitFor(() => expect(localLease.stop).toHaveBeenCalledTimes(1));
    expect(acknowledge).toHaveBeenCalledWith(expect.any(String), 1, digest(document));
    expect(acknowledge.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(localLease.stop).mock.invocationCallOrder[0]!
    );
  });

  it('starts heartbeats and resumes pending writes only after an explicit takeover', async () => {
    let held = false;
    const localLease: WriterLease = {
      start: vi.fn().mockImplementation(async () => false),
      takeover: vi.fn().mockImplementation(async () => { held = true; return true; }),
      stop: vi.fn().mockResolvedValue(undefined),
      canWrite: () => held
    };
    const config = {
      ...options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) })),
      lease: localLease
    };
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('read_only'));
    await act(() => result.current.takeover());
    expect(localLease.takeover).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('synced');
    expect(result.current.readOnly).toBe(false);
  });

  it('keeps pending WAL and exposes base, local and server documents on 409', async () => {
    const serverDocument = applyOperations(createEmptyDocument(), [insert]).toJSON();
    const config = options(async () => { throw new ApiError(409, 'CONFLICT', 'conflict', {
      server_version: 1, server_document: serverDocument, server_content_hash: digest(serverDocument)
    }, 'request-id'); });
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    await act(() => result.current.flush());
    expect(result.current.status).toBe('conflict');
    expect(result.current.conflict).toMatchObject({ baseVersion: 0, serverVersion: 1, localDocument: document, serverDocument });
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });

  it('opens a three-way conflict instead of flushing when the recovered base version differs from the server', async () => {
    const config = options(async (input) => ({ change_id: input.change_id, server_version: 2, content_hash: digest(document) }));
    await config.store.initialize(
      config.workId,
      config.chapterId,
      config.chapter.document,
      config.chapter.version,
      config.chapter.content_hash
    );
    await config.store.append({ workId: config.workId, chapterId: config.chapterId, clientId: config.clientId, operations: [insert] });
    const serverInsert = new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text('服')), 0, 0)).toJSON();
    const serverDocument = applyOperations(createEmptyDocument(), [serverInsert]).toJSON();
    config.loadChapter.mockResolvedValue({
      ...config.chapter,
      version: 1,
      content_hash: digest(serverDocument),
      document: serverDocument
    });

    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('conflict'));
    expect(result.current.conflict).toMatchObject({
      baseDocument: createEmptyDocument(),
      baseVersion: 0,
      localDocument: document,
      serverDocument,
      serverVersion: 1,
      requestId: 'initialization-version-mismatch'
    });
    expect(config.saveChange).not.toHaveBeenCalled();
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });

  it('restores the complete chapter and re-enables a held lease after local recovery fails', async () => {
    const config = options(async (input) => ({ change_id: input.change_id, server_version: 1, content_hash: digest(document) }));
    const recover = vi.spyOn(config.store, 'recover').mockRejectedValueOnce(new Error('corrupt snapshot'));
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('save_failed'));

    await act(() => result.current.restoreFromServer());
    expect(result.current.chapter).toEqual(config.chapter);
    expect(result.current.status).toBe('synced');
    expect(result.current.readOnly).toBe(false);
    expect(recover).toHaveBeenCalledTimes(2);

    await act(() => result.current.append([insert], document));
    expect(result.current.status).toBe('local_saved');
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });

  it('does not resolve a conflict into WAL after the writer loses its lease', async () => {
    let held = true;
    const localLease: WriterLease = {
      start: vi.fn().mockImplementation(async () => held),
      takeover: vi.fn().mockImplementation(async () => held),
      stop: vi.fn().mockResolvedValue(undefined),
      canWrite: () => held
    };
    const serverDocument = applyOperations(createEmptyDocument(), [insert]).toJSON();
    const config = {
      ...options(async () => { throw new ApiError(409, 'CONFLICT', 'conflict', {
        server_version: 1, server_document: serverDocument, server_content_hash: digest(serverDocument)
      }, 'request-id'); }),
      lease: localLease
    };
    const { result } = renderHook(() => useChapterWriter(config));
    await waitFor(() => expect(result.current.status).toBe('synced'));
    await act(() => result.current.append([insert], document));
    await act(() => result.current.flush());
    await waitFor(() => expect(result.current.status).toBe('conflict'));
    const resolve = vi.spyOn(config.store, 'resolveConflict');

    held = false;
    await act(async () => {
      await expect(result.current.resolveConflict(document)).rejects.toThrow('写入租约已失效');
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.status).toBe('read_only');
    expect((await config.store.recover(config.workId, config.chapterId)).pending).toHaveLength(1);
  });
});
```

`apps/web/src/editor/save-status.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SaveStatusView } from './save-status';

describe('SaveStatusView', () => {
  it('requires confirmation before restoring the server snapshot from save_failed', async () => {
    const onRestore = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SaveStatusView status="save_failed" onRetry={vi.fn()} onTakeover={vi.fn()} onRestore={onRestore} />);
    const restore = screen.getByRole('button', { name: '从服务端恢复' });

    await userEvent.click(restore);
    expect(onRestore).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(restore);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @storyforge/web test -- use-chapter-writer.test.tsx save-status.test.tsx`
Expected: FAIL，保存控制器与保存状态区域不存在；新增初始化冲突、恢复和租约保护测试不能通过。

- [ ] **Step 3: 实现保存控制器、状态区域与冲突 UI**

`apps/web/src/editor/use-chapter-writer.ts`：

```ts
import {
  versionConflictDetailsSchema,
  type Chapter,
  type ProseMirrorNode,
  type SaveChangeRequest,
  type SaveChangeResponse,
  type VersionConflictDetails
} from '@storyforge/contracts';
import { canonicalizeDocument, createEmptyDocument } from '@storyforge/editor-schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { WalStore } from '../persistence/wal';
import { WriteLease } from '../persistence/write-lease';
import { saveChange as defaultSave } from '../works/writing-client';

export type SaveStatus = 'local_saving' | 'local_saved' | 'syncing' | 'synced' | 'offline_pending' | 'conflict' | 'save_failed' | 'recovering' | 'read_only';
export interface WriterLease {
  start(onLost: () => void): Promise<boolean>;
  takeover(onLost: () => void): Promise<boolean>;
  stop(): Promise<void>;
  canWrite(): boolean;
}
export interface WriterConflict {
  baseDocument: ProseMirrorNode;
  baseVersion: number;
  localDocument: ProseMirrorNode;
  serverDocument: ProseMirrorNode;
  serverVersion: number;
  serverContentHash: string;
  requestId: string;
}
interface Options {
  workId: string;
  chapterId: string;
  clientId: string;
  store?: WalStore;
  lease?: WriterLease;
  loadChapter(): Promise<Chapter>;
  saveChange?: (workId: string, chapterId: string, input: SaveChangeRequest) => Promise<SaveChangeResponse>;
}

export function useChapterWriter(options: Options) {
  const { workId, chapterId, clientId } = options;
  const store = useRef(options.store ?? new WalStore());
  const lease = useRef<WriterLease>(options.lease ?? new WriteLease(chapterId, clientId));
  const save = useRef(options.saveChange ?? defaultSave);
  const [chapter, setChapter] = useState<Chapter>();
  const [document, setDocument] = useState<ProseMirrorNode>(createEmptyDocument());
  const [status, setStatus] = useState<SaveStatus>('recovering');
  const [conflict, setConflict] = useState<WriterConflict>();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const flushing = useRef<Promise<void> | undefined>(undefined);
  const autoSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ready = useRef(false);

  const flush = useCallback((): Promise<void> => {
    if (flushing.current) return flushing.current;
    const operation = (async () => {
      if (!ready.current || !lease.current.canWrite()) { if (ready.current) setStatus('read_only'); return; }
      let acknowledged = false;
      try {
        for (;;) {
          const pending = await store.current.nextPending(workId, chapterId);
          if (!pending) break;
          if (!lease.current.canWrite()) { setStatus('read_only'); return; }
          setStatus('syncing');
          const response = await save.current(workId, chapterId, {
            change_id: pending.change_id,
            client_id: pending.client_id,
            sequence: pending.sequence,
            base_version: pending.base_version,
            operations: pending.operations
          });
          await store.current.acknowledge(pending.change_id, response.server_version, response.content_hash);
          setChapter((current) => current ? { ...current, version: response.server_version, content_hash: response.content_hash } : current);
          acknowledged = true;
        }
        if (acknowledged) setStatus('synced');
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const details = versionConflictDetailsSchema.parse(error.details) as VersionConflictDetails;
          const recovered = await store.current.recover(workId, chapterId);
          setConflict({
            baseDocument: recovered.baseDocument,
            baseVersion: recovered.baseVersion,
            localDocument: recovered.document,
            serverDocument: details.server_document,
            serverVersion: details.server_version,
            serverContentHash: details.server_content_hash,
            requestId: error.requestId
          });
          setStatus('conflict');
        } else if (error instanceof ApiError && error.status < 500) {
          setStatus('save_failed');
        } else {
          setStatus('offline_pending');
        }
      }
    })();
    flushing.current = operation;
    void operation.finally(() => { if (flushing.current === operation) flushing.current = undefined; });
    return operation;
  }, [chapterId, workId]);

  useEffect(() => {
    let active = true;
    ready.current = false;
    setStatus('recovering');
    async function initialize() {
      try {
        const server = await options.loadChapter();
        await store.current.initialize(workId, chapterId, server.document, server.version, server.content_hash);
        if (!active) return;
        setChapter(server);
        const acquired = await lease.current.start(() => { ready.current = false; setStatus('read_only'); });
        if (!active) {
          if (acquired) await lease.current.stop();
          return;
        }
        const recovered = await store.current.recover(workId, chapterId);
        if (!active) return;
        setDocument(recovered.document); ready.current = acquired;
        if (recovered.baseVersion !== server.version) {
          setConflict({
            baseDocument: recovered.baseDocument,
            baseVersion: recovered.baseVersion,
            localDocument: recovered.document,
            serverDocument: server.document,
            serverVersion: server.version,
            serverContentHash: server.content_hash,
            requestId: 'initialization-version-mismatch'
          });
          setStatus('conflict');
          return;
        }
        setStatus(acquired ? (recovered.pending.length ? 'local_saved' : 'synced') : 'read_only');
        if (acquired && recovered.pending.length) await flush();
      } catch { if (active) setStatus('save_failed'); }
    }
    void initialize();
    const hidden = () => { if (window.document.visibilityState === 'hidden') void flush(); };
    window.document.addEventListener('visibilitychange', hidden);
    return () => {
      const finalFlush = ready.current && lease.current.canWrite() ? flush() : Promise.resolve();
      active = false;
      ready.current = false;
      if (autoSave.current) clearTimeout(autoSave.current);
      window.document.removeEventListener('visibilitychange', hidden);
      void finalFlush.finally(() => lease.current.stop());
    };
  }, [chapterId, flush, workId]);

  function append(operations: Array<Record<string, unknown>>, nextDocument: ProseMirrorNode): Promise<void> {
    const task = queue.current.then(async () => {
      if (!ready.current || !lease.current.canWrite()) { setStatus('read_only'); return; }
      setStatus('local_saving');
      try {
        await store.current.append({ workId, chapterId, clientId, operations });
        const recovered = await store.current.recover(workId, chapterId);
        if (canonicalizeDocument(recovered.document) !== canonicalizeDocument(nextDocument)) throw new Error('Recovered document differs from editor');
        setDocument(recovered.document); setStatus('local_saved');
        if (autoSave.current) clearTimeout(autoSave.current);
        autoSave.current = setTimeout(() => void flush(), 300);
      } catch { setStatus('save_failed'); }
    });
    queue.current = task.catch(() => undefined);
    return task;
  }

  async function resolveConflict(selectedDocument: ProseMirrorNode): Promise<void> {
    if (!conflict) return;
    if (!ready.current || !lease.current.canWrite()) {
      ready.current = false;
      setStatus('read_only');
      throw new Error('写入租约已失效，不能解决冲突；可先从服务端恢复，再显式接管写入');
    }
    const entry = await store.current.resolveConflict({
      workId, chapterId, clientId,
      baseDocument: conflict.baseDocument, baseVersion: conflict.baseVersion,
      localDocument: conflict.localDocument, serverDocument: conflict.serverDocument,
      serverVersion: conflict.serverVersion, serverContentHash: conflict.serverContentHash,
      selectedDocument
    });
    const recovered = await store.current.recover(workId, chapterId);
    setDocument(recovered.document); setConflict(undefined);
    setChapter((current) => current ? {
      ...current, document: conflict.serverDocument, version: conflict.serverVersion, content_hash: conflict.serverContentHash
    } : current);
    setStatus(entry ? 'local_saved' : 'synced');
    if (entry) await flush();
  }

  async function takeover(): Promise<void> {
    setStatus('recovering');
    try {
      const acquired = await lease.current.takeover(() => { ready.current = false; setStatus('read_only'); });
      ready.current = acquired;
      if (!acquired) { setStatus('read_only'); return; }
      const recovered = await store.current.recover(workId, chapterId);
      setDocument(recovered.document);
      setStatus(recovered.pending.length ? 'local_saved' : 'synced');
      if (recovered.pending.length) await flush();
    } catch {
      ready.current = false;
      setStatus('read_only');
    }
  }

  async function restoreFromServer(): Promise<void> {
    const server: Chapter = conflict ? {
      ...(chapter ?? await options.loadChapter()),
      document: conflict.serverDocument,
      version: conflict.serverVersion,
      content_hash: conflict.serverContentHash
    } : await options.loadChapter();
    await store.current.initialize(workId, chapterId, server.document, server.version, server.content_hash);
    await store.current.restoreFromServer(workId, chapterId, server.document, server.version, server.content_hash);
    const recovered = await store.current.recover(workId, chapterId);
    ready.current = lease.current.canWrite();
    setDocument(recovered.document); setConflict(undefined); setChapter(server);
    setStatus(ready.current ? 'synced' : 'read_only');
  }

  return {
    chapter, document, status, conflict,
    readOnly: status === 'recovering' || status === 'read_only',
    append, flush, takeover, resolveConflict, restoreFromServer,
    saveMarkdownDraft: (source: string) => store.current.saveMarkdown(chapterId, source),
    exportRecovery: () => store.current.exportChapter(workId, chapterId)
  };
}
```


`apps/web/src/editor/save-status.tsx`：

```tsx
import type { SaveStatus } from './use-chapter-writer';

const labels: Record<SaveStatus, string> = {
  local_saving: '本地保存中', local_saved: '本地已保存', syncing: '云端同步中', synced: '已同步',
  offline_pending: '离线待同步', conflict: '版本冲突', save_failed: '保存失败', recovering: '正在恢复', read_only: '只读'
};
interface Props {
  status: SaveStatus;
  onRetry(): void;
  onTakeover(): void;
  onRestore(): void;
}
export function SaveStatusView({ status, onRetry, onTakeover, onRestore }: Props) {
  return <div role="status" aria-live="polite">{labels[status]}
    {['offline_pending', 'save_failed'].includes(status) && <button type="button" onClick={onRetry}>重试</button>}
    {status === 'save_failed' && <button type="button" onClick={() => {
      if (window.confirm('从服务端恢复会保留本地备份并清除未确认日志，确认继续？')) onRestore();
    }}>从服务端恢复</button>}
    {status === 'read_only' && <button type="button" onClick={onTakeover}>接管写入</button>}
  </div>;
}
```

`apps/web/src/editor/conflict-dialog.tsx`：

```tsx
import type { ProseMirrorNode } from '@storyforge/contracts';
import { documentToMarkdown, markdownToDocument, parseDocument } from '@storyforge/editor-schema';
import { useEffect, useRef, useState } from 'react';
import type { WriterConflict } from './use-chapter-writer';

interface Props {
  conflict?: WriterConflict;
  onResolve(document: ProseMirrorNode): Promise<void>;
  onRestore(): Promise<void>;
  onExport(): Promise<string>;
}
export function ConflictDialog({ conflict, onResolve, onRestore, onExport }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (conflict && !ref.current?.open) {
      setManual(documentToMarkdown(conflict.localDocument)); ref.current?.showModal();
    }
    if (!conflict && ref.current?.open) ref.current.close();
  }, [conflict]);
  if (!conflict) return null;

  async function choose(document: ProseMirrorNode) {
    setPending(true); setError('');
    try { await onResolve(document); } catch (cause) { setError(cause instanceof Error ? cause.message : '冲突处理失败'); }
    finally { setPending(false); }
  }
  async function merge() {
    try { await choose(markdownToDocument(manual)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Markdown 解析失败'); setPending(false); }
  }
  async function download() {
    const blob = new Blob([await onExport()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `chapter-${conflict?.baseVersion}-recovery.json`; anchor.click();
    URL.revokeObjectURL(url);
  }
  return <dialog ref={ref} aria-labelledby="conflict-title">
    <h2 id="conflict-title">版本冲突</h2>
    <p>请求 ID：{conflict.requestId}。共同基准版本 {conflict.baseVersion}，服务端版本 {conflict.serverVersion}。</p>
    <h3>共同基准</h3><pre>{parseDocument(conflict.baseDocument).textContent}</pre>
    <h3>本地未确认</h3><pre>{parseDocument(conflict.localDocument).textContent}</pre>
    <h3>服务端当前</h3><pre>{parseDocument(conflict.serverDocument).textContent}</pre>
    <button disabled={pending} onClick={() => void choose(conflict.localDocument)}>使用本地</button>
    <button disabled={pending} onClick={() => void choose(conflict.serverDocument)}>使用服务端</button>
    <label htmlFor="manual-merge">手动合并</label>
    <textarea id="manual-merge" value={manual} onChange={(event) => setManual(event.target.value)} />
    <button disabled={pending} onClick={() => void merge()}>确认合并</button>
    <button disabled={pending} onClick={() => void download()}>导出恢复数据</button>
    <button disabled={pending} onClick={() => {
      if (window.confirm('从服务端恢复会保留本地备份并清除未确认日志，确认继续？')) void onRestore();
    }}>从服务端恢复</button>
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
```

- [ ] **Step 4: 验证保存和冲突状态机**

Run: `pnpm --filter @storyforge/web test -- use-chapter-writer.test.tsx save-status.test.tsx && pnpm --filter @storyforge/web typecheck`
Expected: 本地先落盘、服务端响应后才 acknowledge、卸载时最后一次 acknowledge 先于租约释放、显式接管后恢复写入、409 pending 不丢且三方正文完整、初始化 baseVersion 与服务端版本不一致时不自动 flush、恢复失败后能从服务端重建完整章节并恢复写就绪、失去租约后不能把冲突选择写入 WAL、`save_failed` 的服务端恢复必须经用户确认；实现还覆盖单飞 flush、300ms 自动同步、隐藏页 flush、离线状态、人工三选和导出。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 全部通过。

```bash
git add apps/web/src/editor
git commit -m "feat: synchronize local chapter changes safely"
```

### Task 13: 交付三栏工作台、章节树与深链

**Files:**
- Create: `apps/web/src/workbench/chapter-url.ts`
- Create: `apps/web/src/workbench/chapter-tree.tsx`
- Create: `apps/web/src/workbench/chapter-tree.test.tsx`
- Create: `apps/web/src/workbench/workbench-page.tsx`
- Create: `apps/web/src/workbench/workbench-page.test.tsx`
- Create: `apps/web/src/workbench/workbench.css`
- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: 写章节树、路由参数、面板持久化与焦点失败测试**

`apps/web/src/workbench/chapter-tree.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { TreeResponse } from '@storyforge/contracts';
import { ChapterTree } from './chapter-tree';

const workId = crypto.randomUUID();
const volumeId = crypto.randomUUID();
const firstId = crypto.randomUUID();
const secondId = crypto.randomUUID();
const tree: TreeResponse = {
  work: {
    id: workId, author_id: crypto.randomUUID(), title: '测试作品', description: '', status: 'active',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  },
  volumes: [{ id: volumeId, work_id: workId, title: '第一卷', position: 0 }],
  chapters: [
    { id: firstId, work_id: workId, volume_id: volumeId, title: '第一章', position: 0, version: 0, content_hash: 'a'.repeat(64) },
    { id: secondId, work_id: workId, volume_id: volumeId, title: '第二章', position: 1, version: 0, content_hash: 'a'.repeat(64) }
  ]
};

describe('ChapterTree', () => {
  it('opens deep links and supports arrow-key navigation', async () => {
    const open = vi.fn();
    render(<MemoryRouter><ChapterTree tree={tree} currentChapterId={firstId} onOpen={open} onAction={vi.fn()} /></MemoryRouter>);
    const first = screen.getByRole('link', { name: '第一章' });
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: '第二章' })).toHaveFocus();
    await userEvent.click(screen.getByRole('link', { name: '第二章' }));
    expect(open).toHaveBeenCalledWith(secondId);
  });

  it('returns a newly created chapter id for immediate navigation', async () => {
    const action = vi.fn().mockResolvedValue(secondId);
    const open = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('新章节');
    render(<MemoryRouter><ChapterTree tree={tree} currentChapterId={firstId} onOpen={open} onAction={action} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: '在第一卷新建章节' }));
    expect(action).toHaveBeenCalledWith({ type: 'create_chapter', volumeId, title: '新章节' });
    expect(open).toHaveBeenCalledWith(secondId);
  });
});
```

`apps/web/src/workbench/workbench-page.test.tsx`：

```tsx
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, TreeResponse } from '@storyforge/contracts';
import { createEmptyDocument } from '@storyforge/editor-schema';
import { WorkbenchRoute, type WorkbenchClient } from './workbench-page';

const workId = crypto.randomUUID();
const chapterId = crypto.randomUUID();
const volumeId = crypto.randomUUID();
const now = new Date().toISOString();
const chapter: Chapter = {
  id: chapterId, work_id: workId, volume_id: volumeId, title: '第一章', position: 0,
  version: 0, content_hash: 'a'.repeat(64), document: createEmptyDocument()
};
const tree: TreeResponse = {
  work: {
    id: workId, author_id: crypto.randomUUID(), title: '深链作品', description: '', status: 'active',
    created_at: now, updated_at: now
  },
  volumes: [{ id: volumeId, work_id: workId, title: '第一卷', position: 0 }],
  chapters: [{ id: chapterId, work_id: workId, volume_id: volumeId, title: '第一章', position: 0, version: 0, content_hash: 'a'.repeat(64) }]
};

function client(): WorkbenchClient {
  return {
    getTree: vi.fn().mockResolvedValue(tree),
    createVolume: vi.fn(), renameVolume: vi.fn(), reorderVolumes: vi.fn(),
    createChapter: vi.fn(), renameChapter: vi.fn(), reorderChapters: vi.fn(),
    getChapter: vi.fn().mockResolvedValue(chapter), saveChange: vi.fn()
  };
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPage(api: WorkbenchClient, entry = `/works/${workId}/write/${chapterId}?tab=manuscript&panel=chapter`) {
  return render(<MemoryRouter initialEntries={[entry]}><Routes>
    <Route path="/works/:workId/write/:chapterId" element={<><WorkbenchRoute client={api} /><LocationProbe /></>} />
  </Routes></MemoryRouter>);
}

beforeAll(() => {
  Range.prototype.getClientRects = (): DOMRectList => ({
    length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator]
  }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, media: '', onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn()
  });
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('storyforge-theme', 'light');
});

describe('WorkbenchRoute', () => {
  it('uses Routes and Route params to load the exact work and chapter', async () => {
    const api = client();
    renderPage(api);
    expect(await screen.findByRole('heading', { name: '深链作品' })).toBeVisible();
    await waitFor(() => expect(api.getChapter).toHaveBeenCalledWith(workId, chapterId));
    expect(api.getTree).toHaveBeenCalledWith(workId);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已同步'));
  });

  it('normalizes invalid deep-link state and persists panel width per work', async () => {
    const api = client();
    renderPage(api, `/works/${workId}/write/${chapterId}?tab=revisions&panel=comments`);
    expect(await screen.findByTestId('location')).toHaveTextContent('?tab=manuscript&panel=chapter');
    const slider = await screen.findByRole('slider', { name: '左侧栏宽度' });
    fireEvent.change(slider, { target: { value: '296' } });
    expect(JSON.parse(localStorage.getItem(`storyforge-workbench:${workId}`)!)).toMatchObject({ leftWidth: 296 });
  });

  it('restores focus to the narrow-screen navigation trigger after closing its dialog', async () => {
    renderPage(client());
    const trigger = await screen.findByRole('button', { name: '打开章节导航' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '章节导航' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '关闭章节导航' }));
    expect(trigger).toHaveFocus();
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @storyforge/web test -- chapter-tree.test.tsx workbench-page.test.tsx`
Expected: FAIL，工作台与章节树模块不存在；不得移除 `Routes/Route`，否则 `useParams` 无法提供作品和章节参数。

- [ ] **Step 3: 实现章节 URL、完整章节树、工作台与样式**

`apps/web/src/workbench/chapter-url.ts`：

```ts
export function chapterUrl(workId: string, chapterId: string): string {
  return `/works/${encodeURIComponent(workId)}/write/${encodeURIComponent(chapterId)}?tab=manuscript&panel=chapter`;
}
```

`apps/web/src/workbench/chapter-tree.tsx`：

```tsx
import { useState, type KeyboardEvent } from 'react';
import type { TreeResponse } from '@storyforge/contracts';
import { chapterUrl } from './chapter-url';

export type TreeAction =
  | { type: 'create_volume'; title: string }
  | { type: 'rename_volume'; volumeId: string; title: string }
  | { type: 'move_volume'; volumeId: string; direction: -1 | 1 }
  | { type: 'create_chapter'; volumeId: string; title: string }
  | { type: 'rename_chapter'; chapterId: string; title: string }
  | { type: 'move_chapter'; volumeId: string; chapterId: string; direction: -1 | 1 };

interface Props {
  tree: TreeResponse;
  currentChapterId: string;
  onOpen(chapterId: string): void;
  onAction(action: TreeAction): Promise<string | undefined>;
}

function titlePrompt(label: string, current = ''): string | undefined {
  const value = window.prompt(label, current)?.trim();
  return value ? value : undefined;
}

export function ChapterTree({ tree, currentChapterId, onOpen, onAction }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: TreeAction, navigate = false): Promise<void> {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const createdId = await onAction(action);
      if (navigate && createdId) onOpen(createdId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '章节操作失败');
    } finally {
      setBusy(false);
    }
  }

  function moveFocus(event: KeyboardEvent<HTMLAnchorElement>): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const links = Array.from(event.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLAnchorElement>('[data-chapter-link]') ?? []);
    const index = links.indexOf(event.currentTarget);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
      : event.key === 'ArrowDown' ? Math.min(links.length - 1, index + 1) : Math.max(0, index - 1);
    links[nextIndex]?.focus();
  }

  return <nav aria-label="作品结构">
    <div className="tree-actions">
      <button type="button" disabled={busy} onClick={() => {
        const title = titlePrompt('卷名称');
        if (title) void run({ type: 'create_volume', title });
      }}>新建卷</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <ul role="tree" aria-label="卷章节">
      {[...tree.volumes].sort((a, b) => a.position - b.position).map((volume, volumeIndex) => {
        const chapters = tree.chapters.filter((chapter) => chapter.volume_id === volume.id)
          .sort((a, b) => a.position - b.position);
        return <li role="treeitem" aria-expanded="true" key={volume.id}>
          <div className="volume-row">
            <strong>{volume.title}</strong>
            <button type="button" aria-label={`重命名${volume.title}`} disabled={busy} onClick={() => {
              const title = titlePrompt('卷名称', volume.title);
              if (title) void run({ type: 'rename_volume', volumeId: volume.id, title });
            }}>重命名</button>
            <button type="button" aria-label={`上移${volume.title}`} disabled={busy || volumeIndex === 0}
              onClick={() => void run({ type: 'move_volume', volumeId: volume.id, direction: -1 })}>上移</button>
            <button type="button" aria-label={`下移${volume.title}`} disabled={busy || volumeIndex === tree.volumes.length - 1}
              onClick={() => void run({ type: 'move_volume', volumeId: volume.id, direction: 1 })}>下移</button>
            <button type="button" aria-label={`在${volume.title}新建章节`} disabled={busy} onClick={() => {
              const title = titlePrompt('章节名称');
              if (title) void run({ type: 'create_chapter', volumeId: volume.id, title }, true);
            }}>新建章节</button>
          </div>
          <ul role="group">
            {chapters.map((chapter, chapterIndex) => <li role="treeitem"
              aria-selected={chapter.id === currentChapterId} key={chapter.id}>
              <a data-chapter-link href={chapterUrl(tree.work.id, chapter.id)}
                tabIndex={chapter.id === currentChapterId ? 0 : -1}
                onKeyDown={moveFocus}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); onOpen(chapter.id);
                }}>{chapter.title}</a>
              <button type="button" aria-label={`重命名${chapter.title}`} disabled={busy} onClick={() => {
                const title = titlePrompt('章节名称', chapter.title);
                if (title) void run({ type: 'rename_chapter', chapterId: chapter.id, title });
              }}>重命名</button>
              <button type="button" aria-label={`上移${chapter.title}`} disabled={busy || chapterIndex === 0}
                onClick={() => void run({ type: 'move_chapter', volumeId: volume.id, chapterId: chapter.id, direction: -1 })}>上移</button>
              <button type="button" aria-label={`下移${chapter.title}`} disabled={busy || chapterIndex === chapters.length - 1}
                onClick={() => void run({ type: 'move_chapter', volumeId: volume.id, chapterId: chapter.id, direction: 1 })}>下移</button>
            </li>)}
          </ul>
        </li>;
      })}
    </ul>
  </nav>;
}
```

`apps/web/src/workbench/workbench-page.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { applyTheme, initialTheme, type Theme } from '@storyforge/design-tokens';
import type { SaveChangeRequest, TreeResponse } from '@storyforge/contracts';
import { ConflictDialog } from '../editor/conflict-dialog';
import { EditorPane } from '../editor/editor-pane';
import { SaveStatusView } from '../editor/save-status';
import { useChapterWriter } from '../editor/use-chapter-writer';
import {
  createChapter, createVolume, getChapter, getTree, renameChapter, renameVolume,
  reorderChapters, reorderVolumes, saveChange
} from '../works/writing-client';
import { ChapterTree, type TreeAction } from './chapter-tree';
import { chapterUrl } from './chapter-url';
import './workbench.css';

export interface WorkbenchClient {
  getTree: typeof getTree;
  createVolume: typeof createVolume;
  renameVolume: typeof renameVolume;
  reorderVolumes: typeof reorderVolumes;
  createChapter: typeof createChapter;
  renameChapter: typeof renameChapter;
  reorderChapters: typeof reorderChapters;
  getChapter: typeof getChapter;
  saveChange: (workId: string, chapterId: string, input: SaveChangeRequest) => ReturnType<typeof saveChange>;
}

const defaultClient: WorkbenchClient = {
  getTree, createVolume, renameVolume, reorderVolumes, createChapter, renameChapter,
  reorderChapters, getChapter, saveChange
};

interface PanelState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}
const defaults: PanelState = { leftWidth: 264, rightWidth: 280, leftCollapsed: false, rightCollapsed: false };
function readPanelState(workId: string): PanelState {
  try {
    const value = JSON.parse(localStorage.getItem(`storyforge-workbench:${workId}`) ?? '{}') as Partial<PanelState>;
    return {
      leftWidth: typeof value.leftWidth === 'number' && value.leftWidth >= 200 && value.leftWidth <= 400 ? value.leftWidth : 264,
      rightWidth: typeof value.rightWidth === 'number' && value.rightWidth >= 220 && value.rightWidth <= 420 ? value.rightWidth : 280,
      leftCollapsed: value.leftCollapsed === true,
      rightCollapsed: value.rightCollapsed === true
    };
  } catch { return defaults; }
}

interface Props { client?: WorkbenchClient }

export function WorkbenchRoute({ client = defaultClient }: Props) {
  const { workId = '', chapterId = '' } = useParams();
  return <WorkbenchPage key={`${workId}:${chapterId}`} client={client} />;
}

export function WorkbenchPage({ client = defaultClient }: Props) {
  const { workId = '', chapterId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tree, setTree] = useState<TreeResponse>();
  const [error, setError] = useState('');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [panels, setPanels] = useState<PanelState>(() => readPanelState(workId));
  const [clientId] = useState(() => crypto.randomUUID());
  const [exporting, setExporting] = useState(false);
  const leftDialog = useRef<HTMLDialogElement>(null);
  const rightDialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const writer = useChapterWriter({
    workId, chapterId, clientId,
    loadChapter: () => client.getChapter(workId, chapterId),
    saveChange: client.saveChange
  });

  const loadTree = useCallback(async () => {
    try { setTree(await client.getTree(workId)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '作品结构加载失败'); }
  }, [client, workId]);
  useEffect(() => { void loadTree(); }, [loadTree]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (next.get('tab') !== 'manuscript') next.set('tab', 'manuscript');
    if (next.get('panel') !== 'chapter') next.set('panel', 'chapter');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const close = () => { if (query.matches) { leftDialog.current?.close(); rightDialog.current?.close(); } };
    query.addEventListener('change', close);
    return () => query.removeEventListener('change', close);
  }, []);

  function updatePanels(patch: Partial<PanelState>): void {
    setPanels((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem(`storyforge-workbench:${workId}`, JSON.stringify(next));
      return next;
    });
  }

  async function performAction(action: TreeAction): Promise<string | undefined> {
    let createdId: string | undefined;
    if (action.type === 'create_volume') await client.createVolume(workId, { title: action.title });
    if (action.type === 'rename_volume') await client.renameVolume(workId, action.volumeId, { title: action.title });
    if (action.type === 'move_volume' && tree) {
      const ordered = [...tree.volumes].sort((a, b) => a.position - b.position).map((volume) => volume.id);
      const index = ordered.indexOf(action.volumeId);
      const target = index + action.direction;
      if (index >= 0 && target >= 0 && target < ordered.length) {
        [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
        await client.reorderVolumes(workId, ordered);
      }
    }
    if (action.type === 'create_chapter') {
      createdId = (await client.createChapter(workId, action.volumeId, { title: action.title })).id;
    }
    if (action.type === 'rename_chapter') await client.renameChapter(workId, action.chapterId, { title: action.title });
    if (action.type === 'move_chapter' && tree) {
      const ordered = tree.chapters.filter((chapter) => chapter.volume_id === action.volumeId)
        .sort((a, b) => a.position - b.position).map((chapter) => chapter.id);
      const index = ordered.indexOf(action.chapterId);
      const target = index + action.direction;
      if (index >= 0 && target >= 0 && target < ordered.length) {
        [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
        await client.reorderChapters(workId, action.volumeId, ordered);
      }
    }
    await loadTree();
    return createdId;
  }

  function openDialog(dialog: HTMLDialogElement | null): void {
    if (!dialog) return;
    returnFocus.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('button, a, input')?.focus();
  }
  function restoreDialogFocus(): void {
    returnFocus.current?.focus();
    returnFocus.current = null;
  }

  async function downloadRecovery(): Promise<void> {
    if (exporting) return;
    setExporting(true); setError('');
    try {
      const blob = new Blob([await writer.exportRecovery()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = `chapter-${chapterId}-recovery.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复数据导出失败');
    } finally { setExporting(false); }
  }

  const navigation = tree ? <ChapterTree tree={tree} currentChapterId={chapterId}
    onOpen={(id) => navigate(chapterUrl(workId, id))} onAction={performAction} /> : <p role="status">正在加载章节</p>;
  function context(idSuffix: string) {
    const widthId = `right-width-${idSuffix}`;
    return <section aria-label="章节信息">
      <h2>章节信息</h2>
      <p>章节：{writer.chapter?.title ?? '正在读取'}</p>
      <p>服务端版本：{writer.chapter?.version ?? 0}</p>
      <p>客户端 ID：{clientId}</p>
      <label htmlFor={widthId}>右侧栏宽度</label>
      <input id={widthId} aria-label="右侧栏宽度" type="range" min="220" max="420" step="8"
        value={panels.rightWidth} onChange={(event) => updatePanels({ rightWidth: Number(event.target.value) })} />
    </section>;
  }
  const style = {
    '--left-width': panels.leftCollapsed ? '0px' : `${panels.leftWidth}px`,
    '--right-width': panels.rightCollapsed ? '0px' : `${panels.rightWidth}px`
  } as CSSProperties;

  return <div className="workbench">
    <header className="workbench-header">
      <Link to="/works">返回作品库</Link>
      <button className="panel-trigger left-trigger" type="button" onClick={() => openDialog(leftDialog.current)}>打开章节导航</button>
      <h1>{tree?.work.title ?? '正在加载作品'}</h1>
      <SaveStatusView status={writer.status} onRetry={() => void writer.flush()} onTakeover={() => void writer.takeover()}
        onRestore={() => {
          void writer.restoreFromServer().catch((cause) => {
            setError(cause instanceof Error ? cause.message : '服务端恢复失败');
          });
        }} />
      <button type="button" disabled={exporting} onClick={() => void downloadRecovery()}>{exporting ? '导出中' : '导出恢复数据'}</button>
      <button type="button" onClick={() => {
        const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); applyTheme(next);
      }}>{theme === 'light' ? '切换深色主题' : '切换浅色主题'}</button>
      <button className="panel-trigger right-trigger" type="button" onClick={() => openDialog(rightDialog.current)}>打开章节信息</button>
    </header>
    {error && <p role="alert">{error}</p>}
    <div className="workbench-grid" style={style}>
      <aside className="workbench-left" aria-label="章节导航栏">
        <button type="button" onClick={() => updatePanels({ leftCollapsed: !panels.leftCollapsed })}>
          {panels.leftCollapsed ? '展开左侧栏' : '折叠左侧栏'}
        </button>
        {!panels.leftCollapsed && <>
          <label htmlFor="left-width">左侧栏宽度</label>
          <input id="left-width" aria-label="左侧栏宽度" type="range" min="200" max="400" step="8"
            value={panels.leftWidth} onChange={(event) => updatePanels({ leftWidth: Number(event.target.value) })} />
          {navigation}
        </>}
      </aside>
      <main className="workbench-center" aria-label="正文工作区">
        <EditorPane initialDocument={writer.document} readOnly={writer.readOnly}
          onDocument={(operations, next) => { void writer.append(operations, next); }}
          onMarkdownDraft={writer.saveMarkdownDraft} />
      </main>
      <aside className="workbench-right" aria-label="章节上下文栏">
        <button type="button" onClick={() => updatePanels({ rightCollapsed: !panels.rightCollapsed })}>
          {panels.rightCollapsed ? '展开右侧栏' : '折叠右侧栏'}
        </button>
        {!panels.rightCollapsed && context('desktop')}
      </aside>
    </div>
    <dialog ref={leftDialog} className="workbench-dialog left-dialog" aria-labelledby="left-dialog-title" onClose={restoreDialogFocus}>
      <h2 id="left-dialog-title">章节导航</h2>
      <button type="button" onClick={() => leftDialog.current?.close()}>关闭章节导航</button>
      {navigation}
    </dialog>
    <dialog ref={rightDialog} className="workbench-dialog right-dialog" aria-labelledby="right-dialog-title" onClose={restoreDialogFocus}>
      <h2 id="right-dialog-title">章节信息</h2>
      <button type="button" onClick={() => rightDialog.current?.close()}>关闭章节信息</button>
      {context('dialog')}
    </dialog>
    <ConflictDialog conflict={writer.conflict} onResolve={writer.resolveConflict}
      onRestore={writer.restoreFromServer} onExport={writer.exportRecovery} />
  </div>;
}
```

`apps/web/src/workbench/workbench.css`：

```css
.workbench { min-height: 100vh; background: var(--bg-primary); color: var(--text-primary); }
.workbench-header {
  min-height: 64px; padding: var(--sp-2) var(--sp-4); display: flex; align-items: center;
  flex-wrap: wrap; gap: var(--sp-2); background: var(--bg-secondary); border-bottom: 1px solid var(--border-color);
}
.workbench-header h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-semibold); }
.workbench-header button, .tree-actions button, .volume-row button, [role='treeitem'] button {
  min-height: 32px; padding: var(--sp-1) var(--sp-2); color: var(--text-primary);
  background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: var(--radius-md);
}
.workbench-header button:hover, [role='treeitem'] button:hover { background: var(--bg-hover); }
.workbench-header button:disabled, [role='treeitem'] button:disabled { opacity: 0.5; cursor: not-allowed; }
.workbench-grid {
  display: grid; grid-template-columns: var(--left-width) minmax(0, 1fr) var(--right-width);
  height: calc(100vh - 64px); min-height: 480px; overflow: hidden;
}
.workbench-left, .workbench-right { min-width: 0; padding: var(--sp-3); overflow: auto; background: var(--bg-secondary); }
.workbench-left { border-right: 1px solid var(--border-color); }
.workbench-right { border-left: 1px solid var(--border-color); }
.workbench-center { min-width: 0; overflow: auto; padding: var(--sp-5); }
.workbench-center > section { width: min(100%, 720px); margin: 0 auto; }
.workbench-center textarea {
  width: 100%; min-height: 60vh; padding: var(--sp-4); resize: vertical;
  color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: var(--radius-md); font: var(--fw-regular) var(--fs-body-lg)/1.8 var(--font-mono);
}
.ProseMirror {
  min-height: 60vh; padding: var(--sp-5); color: var(--text-primary); background: var(--bg-secondary);
  border: 1px solid var(--border-color); border-radius: var(--radius-md);
  font-size: var(--fs-body-lg); line-height: 1.8; outline: none;
}
.ProseMirror:focus-visible { border-color: var(--brand-500); box-shadow: 0 0 0 2px var(--brand-100); }
[role='tree'], [role='group'] { margin: 0; padding-left: var(--sp-3); list-style: none; }
[role='tree'] { padding-left: 0; }
[role='treeitem'] { margin: var(--sp-1) 0; }
[role='treeitem'] a { display: inline-block; padding: var(--sp-2); color: var(--text-primary); text-decoration: none; }
[role='treeitem'][aria-selected='true'] > a { color: var(--brand-600); background: var(--brand-100); border-radius: var(--radius-md); }
.volume-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); margin-top: var(--sp-3); }
.tree-actions { margin: var(--sp-3) 0; }
.panel-trigger { display: none; }
.workbench-dialog {
  width: min(88vw, 360px); height: 100dvh; max-height: none; padding: var(--sp-4);
  color: var(--text-primary); background: var(--bg-secondary); border: 0;
}
.workbench-dialog::backdrop { background: rgb(15 23 42 / 55%); }
.left-dialog { margin: 0 auto 0 0; }
.right-dialog { margin: 0 0 0 auto; }
@media (max-width: 1023px) {
  .workbench-grid { grid-template-columns: var(--left-width) minmax(0, 1fr); }
  .workbench-right { display: none; }
  .right-trigger { display: inline-flex; }
}
@media (max-width: 767px) {
  .workbench-header { padding: var(--sp-2); }
  .workbench-header h1 { width: 100%; font-size: var(--fs-h3); }
  .workbench-grid { grid-template-columns: minmax(0, 1fr); height: calc(100vh - 112px); }
  .workbench-left { display: none; }
  .workbench-center { padding: var(--sp-3); }
  .ProseMirror { padding: var(--sp-4); }
  .left-trigger { display: inline-flex; }
}
@media (min-width: 1024px) {
  .workbench-dialog { display: none; }
}
```

将 `apps/web/src/app.tsx` 完整替换为以下版本；`WorkbenchRoute` 的 key 使章节切换时旧 hook 先完成卸载 flush，再创建新章节的租约和恢复状态：

```tsx
import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { SessionResponse } from '@storyforge/contracts';
import { AuthPage } from './auth/auth-page';
import { getSession, login } from './auth/auth-client';
import { WorksPage } from './works/works-page';
import { WorkbenchRoute } from './workbench/workbench-page';

export function App() {
  const [session, setSession] = useState<SessionResponse>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    getSession().then(setSession).catch(() => setSession(undefined)).finally(() => setLoading(false));
  }, []);
  if (loading) return <p role="status">正在恢复会话</p>;
  if (!session) return <AuthPage login={login} onSuccess={setSession} />;
  return <BrowserRouter><Routes>
    <Route path="/" element={<Navigate to="/works" replace />} />
    <Route path="/works" element={<WorksPage />} />
    <Route path="/works/:workId/write/:chapterId" element={<WorkbenchRoute />} />
    <Route path="*" element={<Navigate to="/works" replace />} />
  </Routes></BrowserRouter>;
}
```

- [ ] **Step 4: 验证工作台组件和构建**

Run: `pnpm --filter @storyforge/web test -- chapter-tree.test.tsx workbench-page.test.tsx && pnpm --filter @storyforge/web build`
Expected: 章节创建后深链、方向键、真实路由参数、非法 query 归一化、宽度持久化、dialog 焦点恢复测试 PASS；TypeScript 与 Vite 构建成功。

- [ ] **Step 5: 提交**

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: 工作区 Lint、类型检查、测试、构建和合规检查全部通过。

```bash
git add apps/web/src/app.tsx apps/web/src/workbench
git commit -m "feat: add linked three pane writing workbench"
```

### Task 14: 完成真实浏览器、故障注入、CI 与 M1 验收证据

**Files:**
- Create: `tests/e2e/m1-helpers.ts`
- Create: `tests/e2e/m1-writing.spec.ts`
- Create: `tests/e2e/m1-recovery.spec.ts`
- Create: `tests/e2e/m1-conflict.spec.ts`
- Create: `tests/e2e/m1-multitab.spec.ts`
- Create: `tests/e2e/m1-resilience.spec.ts`
- Create: `tests/e2e/m1-accessibility.spec.ts`
- Create: `tests/e2e/m1-baseline.spec.ts`
- Create: `scripts/verify-m1-db-failure.mjs`
- Create: `scripts/verify-m1.mjs`
- Create: `docs/05-测试与验收报告/M1写作基座验收报告.md`（仅由验收脚本根据实测结果生成）
- Modify: `playwright.config.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/02-技术与架构/技术栈.md`
- Modify: `docs/02-技术与架构/目录结构.md`
- Modify: `docs/03-规划与路线/小说AI写作软件改造实施路线图.md`

- [ ] **Step 1: 写完整浏览器与故障验收失败测试**

`tests/e2e/m1-writing.spec.ts` 覆盖作品创建、双模式正文、自动保存、深链重载和 WAL 导出：

```ts
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  chapterUrl,
  expectSaveStatus,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test('author writes one chapter in both modes, reopens its deep link and exports recovery data', async ({ page }, testInfo) => {
  const location = await loginAndOpenChapter(page, `M1 主流程 ${Date.now()}`);
  const editor = page.locator('.ProseMirror');
  await expect(editor).toBeEditable();
  await editor.fill('第一章正文');
  await expectSaveStatus(page, '已同步');

  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const source = page.getByLabel('Markdown 正文');
  await expect(source).toHaveValue(/第一章正文/);
  await source.fill('# 第一章\n\n云端正文');
  await page.getByRole('button', { name: '富文本', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  await expect(editor).toContainText('云端正文');

  await page.goto(chapterUrl(location.workId, location.chapterId));
  await expectSaveStatus(page, '已同步');
  await expect(page.locator('.ProseMirror')).toContainText('云端正文');
  expect(new URL(page.url()).pathname).toBe(`/works/${location.workId}/write/${location.chapterId}`);
  expect(new URL(page.url()).search).toBe('?tab=manuscript&panel=chapter');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出恢复数据', exact: true }).click();
  const download = await downloadPromise;
  const evidence = testInfo.outputPath('chapter-recovery.json');
  await download.saveAs(evidence);
  const exported = JSON.parse(await readFile(evidence, 'utf8')) as {
    format: string;
    snapshot: { work_id: string; chapter_id: string; server_version: number };
    changes: unknown[];
  };
  expect(exported.format).toBe('storyforge-wal-v1');
  expect(exported.snapshot).toMatchObject({
    work_id: location.workId,
    chapter_id: location.chapterId,
    server_version: 2
  });
  expect(exported.changes).toEqual([]);
  await testInfo.attach('chapter-recovery', { path: evidence, contentType: 'application/json' });
});
```

`tests/e2e/m1-recovery.spec.ts` 在保存请求尚未返回时杀死真实 Chromium 进程，并使用同一个持久化 profile 重启：

```ts
import { expect, test, chromium } from '@playwright/test';
import {
  chapterUrl,
  crashBrowser,
  expectSaveStatus,
  getServerChapter,
  login,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test.setTimeout(90_000);

test('pending IndexedDB change survives a real browser crash and synchronizes after restart', async ({}, testInfo) => {
  const baseURL = 'http://127.0.0.1:5173';
  const profile = testInfo.outputPath('chromium-profile');
  let context = await chromium.launchPersistentContext(profile, { baseURL, headless: true });
  let page = context.pages()[0] ?? await context.newPage();
  const location = await loginAndOpenChapter(page, `M1 崩溃恢复 ${Date.now()}`);

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => { markFirstRequest = resolve; });
  await page.route('**/changes', async (route) => {
    markFirstRequest();
    await firstGate;
    await route.continue();
  });
  await page.locator('.ProseMirror').fill('浏览器崩溃前已落盘');
  await firstRequest;
  expect((await readLocalState(page, location)).changes).toHaveLength(1);
  expect((await getServerChapter(page, location)).version).toBe(0);

  const browser = context.browser();
  expect(browser).not.toBeNull();
  await crashBrowser(browser!);
  expect(browser!.isConnected()).toBe(false);
  releaseFirst();

  context = await chromium.launchPersistentContext(profile, { baseURL, headless: true });
  page = context.pages()[0] ?? await context.newPage();
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let markSecondRequest!: () => void;
  const secondRequest = new Promise<void>((resolve) => { markSecondRequest = resolve; });
  await page.route('**/changes', async (route) => {
    markSecondRequest();
    await secondGate;
    await route.continue();
  });
  await login(page);
  await page.goto(chapterUrl(location.workId, location.chapterId));
  await expect(page.locator('.ProseMirror')).toContainText('浏览器崩溃前已落盘');
  await secondRequest;
  await expectSaveStatus(page, '云端同步中');
  expect((await readLocalState(page, location)).changes).toHaveLength(1);
  releaseSecond();
  await expectSaveStatus(page, '已同步');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);
  expect((await getServerChapter(page, location)).document).toMatchObject({
    content: [{ content: [{ text: '浏览器崩溃前已落盘' }] }]
  });
  await context.close();
});
```

`tests/e2e/m1-conflict.spec.ts` 用另一个真实 API 写入推进服务端版本，验证 409 不丢 pending，且只有人工选择后才重新保存：

```ts
import { expect, test } from '@playwright/test';
import {
  expectSaveStatus,
  getServerChapter,
  loginAndOpenChapter,
  postServerText,
  readLocalState
} from './m1-helpers';

test('409 keeps base, local and server versions until the author chooses local text', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 冲突 ${Date.now()}`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markRequest!: () => void;
  const requestStarted = new Promise<void>((resolve) => { markRequest = resolve; });
  await page.route('**/changes', async (route) => {
    markRequest();
    await gate;
    await route.continue();
  });
  await page.locator('.ProseMirror').fill('本地未确认');
  await requestStarted;
  expect((await readLocalState(page, location)).changes).toHaveLength(1);

  const serverSave = await postServerText(page, location, '服务端当前');
  expect(serverSave.server_version).toBe(1);
  release();
  const dialog = page.getByRole('dialog', { name: '版本冲突' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('本地未确认', { exact: true })).toBeVisible();
  await expect(dialog.getByText('服务端当前', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('共同基准版本 0，服务端版本 1');
  expect((await readLocalState(page, location)).changes).toHaveLength(1);

  await dialog.getByRole('button', { name: '使用本地', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  await expect(dialog).toHaveCount(0);
  const server = await getServerChapter(page, location);
  expect(server.version).toBe(2);
  expect(server.document).toMatchObject({ content: [{ content: [{ text: '本地未确认' }] }] });
  const local = await readLocalState(page, location);
  expect(local.changes).toHaveLength(0);
  expect(local.conflicts).toHaveLength(1);
  expect(local.conflicts[0]).toMatchObject({ base_version: 0, server_version: 1 });
});
```

`tests/e2e/m1-multitab.spec.ts` 验证活跃租约不可抢占、15 秒 TTL 后的显式接管、fencing token 递增以及旧页面失效：

```ts
import { expect, test } from '@playwright/test';
import {
  chapterUrl,
  expectSaveStatus,
  login,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test.setTimeout(90_000);

test('second tab takes over only after TTL and the stale writer loses its fencing token', async ({ page: first }) => {
  const location = await loginAndOpenChapter(first, `M1 多标签 ${Date.now()}`);
  const second = await first.context().newPage();
  await login(second);
  await second.goto(chapterUrl(location.workId, location.chapterId));
  await expectSaveStatus(second, '只读');
  await expect(second.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');

  const before = (await readLocalState(second, location)).leases[0];
  expect(before).toBeDefined();
  await second.getByRole('button', { name: '接管写入', exact: true }).click();
  await expectSaveStatus(second, '只读');
  expect((await readLocalState(second, location)).leases[0]?.fencing_token).toBe(before!.fencing_token);

  const cdp = await first.context().newCDPSession(first);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await second.waitForTimeout(16_000);
  await second.getByRole('button', { name: '接管写入', exact: true }).click();
  await expectSaveStatus(second, '已同步');
  const after = (await readLocalState(second, location)).leases[0];
  expect(after?.fencing_token).toBeGreaterThan(before!.fencing_token);
  expect(after?.owner_id).not.toBe(before?.owner_id);

  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await expectSaveStatus(first, '只读');
  await expect(first.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
  await second.locator('.ProseMirror').fill('新写入页正文');
  await expectSaveStatus(second, '已同步');
  await expectSaveStatus(first, '只读');
});
```

`tests/e2e/m1-resilience.spec.ts` 覆盖断网、非法 Markdown、配额失败与本地快照损坏；故障断言不得依赖定时器伪装状态：

```ts
import { expect, test } from '@playwright/test';
import {
  corruptSnapshot,
  expectSaveStatus,
  getServerChapter,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test('offline edits remain pending and retry persists them after reconnection', async ({ page, context }) => {
  const location = await loginAndOpenChapter(page, `M1 断网 ${Date.now()}`);
  await context.setOffline(true);
  await page.locator('.ProseMirror').fill('离线正文');
  await expectSaveStatus(page, '离线待同步');
  expect((await readLocalState(page, location)).changes).toHaveLength(1);
  expect((await getServerChapter(page, location)).version).toBe(0);

  await context.setOffline(false);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);
  expect((await getServerChapter(page, location)).document).toMatchObject({
    content: [{ content: [{ text: '离线正文' }] }]
  });
});

test('unsafe Markdown keeps its source and never executes or reaches the server', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 非法 Markdown ${Date.now()}`);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const source = page.getByLabel('Markdown 正文');
  const unsafe = '<script>window.__m1Unsafe = true</script>';
  await source.fill(unsafe);
  await page.getByRole('button', { name: '富文本', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Line 1, column 1');
  await expect(source).toHaveValue(unsafe);
  await expect(source).toBeVisible();
  expect(await page.evaluate(() => '__m1Unsafe' in window)).toBe(false);
  expect((await getServerChapter(page, location)).version).toBe(0);
});

test('quota failure shows save_failed, retains the snapshot and still permits recovery export', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 配额 ${Date.now()}`);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'changes') {
        IDBObjectStore.prototype.add = original;
        throw new DOMException('M1 quota injection', 'QuotaExceededError');
      }
      return original.call(this, value, key);
    };
  });
  await page.locator('.ProseMirror').fill('无法写入 WAL');
  await expectSaveStatus(page, '保存失败');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);
  expect((await readLocalState(page, location)).snapshot).toBeDefined();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出恢复数据', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(`chapter-${location.chapterId}-recovery.json`);
});

test('corrupt local data is retained in a backup and explicit server restore re-enables writing', async ({ page }) => {
  const location = await loginAndOpenChapter(page, `M1 损坏 ${Date.now()}`);
  await corruptSnapshot(page, location);
  await page.reload();
  await expectSaveStatus(page, '保存失败');
  expect((await readLocalState(page, location)).snapshot?.document).toEqual({ type: 'paragraph' });

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '从服务端恢复', exact: true }).click();
  await expectSaveStatus(page, '已同步');
  const recovered = await readLocalState(page, location);
  expect(recovered.snapshot?.document).toMatchObject({ type: 'doc' });
  expect(recovered.conflicts).toHaveLength(1);
  expect(recovered.conflicts[0]?.local_document).toEqual({ type: 'paragraph' });
  await page.locator('.ProseMirror').fill('恢复后可写');
  await expectSaveStatus(page, '已同步');
  expect((await getServerChapter(page, location)).version).toBe(1);
});
```

`tests/e2e/m1-accessibility.spec.ts` 在四个规定宽度执行 axe-core，并验证窄屏 dialog 焦点恢复、键盘可达和横向溢出：

```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectSaveStatus, loginAndOpenChapter } from './m1-helpers';

async function audit(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await testInfo.attach(`${name}-axe`, {
    body: JSON.stringify(result.violations, null, 2),
    contentType: 'application/json'
  });
  expect(result.violations).toEqual([]);
}

test('375/768/1024/1440 layouts keep operations reachable and pass axe in both themes', async ({ page }, testInfo) => {
  await loginAndOpenChapter(page, `M1 无障碍 ${Date.now()}`);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expectSaveStatus(page, '已同步');
    const dimensions = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: window.innerWidth
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

    if (width < 768) {
      const trigger = page.getByRole('button', { name: '打开章节导航', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '章节导航' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '关闭章节导航' })).toBeFocused();
      await audit(page, testInfo, `${width}-navigation-dialog`);
      await dialog.getByRole('button', { name: '关闭章节导航' }).click();
      await expect(trigger).toBeFocused();
    } else if (width < 1024) {
      const trigger = page.getByRole('button', { name: '打开章节信息', exact: true });
      await trigger.click();
      await expect(page.getByRole('dialog', { name: '章节信息' })).toBeVisible();
      await audit(page, testInfo, `${width}-context-dialog`);
      await page.getByRole('button', { name: '关闭章节信息' }).click();
      await expect(trigger).toBeFocused();
    } else {
      await audit(page, testInfo, `${width}-light`);
    }

    const screenshot = testInfo.outputPath(`workbench-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`workbench-${width}`, { path: screenshot, contentType: 'image/png' });
  }

  await page.getByRole('button', { name: '切换深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await audit(page, testInfo, '1440-dark');
  const chapterLink = page.getByRole('link', { name: '第一章', exact: true });
  await chapterLink.focus();
  await expect(chapterLink).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(chapterLink).toBeFocused();
});
```

`tests/e2e/m1-baseline.spec.ts` 只采集 M1 基线，不声明 M5 的千章虚拟化、四浏览器或正式 P95 门槛已完成。输入指标明确包含 Playwright 自动化和本机回环网络环境：

```ts
import { cpus, platform, release, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { chapterUrl, expectSaveStatus, loginAndOpenChapter } from './m1-helpers';

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

test.setTimeout(120_000);

test('collect an environment-labelled M1 performance baseline without claiming the M5 gate', async ({ page, browser }, testInfo) => {
  const location = await loginAndOpenChapter(page, `M1 性能基线 ${Date.now()}`);
  const editor = page.locator('.ProseMirror');
  await editor.fill('字'.repeat(10_000));
  await expectSaveStatus(page, '已同步');

  const inputSamples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await editor.pressSequentially('测');
    inputSamples.push(performance.now() - started);
  }
  await expectSaveStatus(page, '已同步');

  const openSamples: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    await page.goto(chapterUrl(location.workId, location.chapterId));
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await expectSaveStatus(page, '已同步');
    openSamples.push(performance.now() - started);
  }

  const processor = cpus();
  const evidence = {
    schema_version: 1,
    scope: 'M1 baseline only; not an M5 performance-gate result',
    captured_at: new Date().toISOString(),
    hardware: {
      platform: platform(),
      release: release(),
      cpu_model: processor[0]?.model ?? 'unknown',
      logical_cpus: processor.length,
      memory_bytes: totalmem()
    },
    browser: { name: 'chromium', version: browser.version() },
    dataset: {
      works: 1,
      volumes: 1,
      chapters: 1,
      initial_characters: 10_000,
      appended_characters: 20,
      thousand_chapter_virtualization: false
    },
    network: {
      included: true,
      kind: 'loopback HTTP plus browser IndexedDB and Playwright protocol',
      base_url: 'http://127.0.0.1:5173'
    },
    metrics: {
      input_wall_ms: { samples: inputSamples, p95: percentile95(inputSamples) },
      chapter_open_wall_ms: { samples: openSamples, p95: percentile95(openSamples) }
    },
    m5_gate_claimed: false
  };
  const directory = join(process.cwd(), 'test-results', 'm1-evidence');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'performance.json');
  await writeFile(path, JSON.stringify(evidence, null, 2), 'utf8');
  await testInfo.attach('m1-performance-baseline', { path, contentType: 'application/json' });
  expect(evidence.metrics.input_wall_ms.samples).toHaveLength(20);
  expect(evidence.metrics.chapter_open_wall_ms.samples).toHaveLength(5);
});
```

- [ ] **Step 2: 运行浏览器测试并确认失败**

Run: `pnpm exec playwright test tests/e2e/m1-writing.spec.ts tests/e2e/m1-recovery.spec.ts tests/e2e/m1-conflict.spec.ts tests/e2e/m1-multitab.spec.ts tests/e2e/m1-resilience.spec.ts tests/e2e/m1-accessibility.spec.ts tests/e2e/m1-baseline.spec.ts`
Expected: FAIL，首先提示 `./m1-helpers` 不存在；不得删除真实浏览器崩溃、409、TTL、fencing、配额、损坏恢复或 axe 断言来使测试变绿。

- [ ] **Step 3: 写入完整 E2E helpers、Playwright 配置与依赖**

`tests/e2e/m1-helpers.ts` 提供可复用的真实登录、作品创建、深链、API、IndexedDB 和浏览器进程操作。API helper 复用页面会话 Cookie 与 CSRF Cookie，不绕过鉴权：

```ts
import { expect, type Browser, type Page } from '@playwright/test';
import {
  chapterSchema,
  saveChangeResponseSchema,
  type Chapter,
  type ProseMirrorNode,
  type SaveChangeResponse
} from '@storyforge/contracts';
import { createEmptyDocument, replaceDocumentOperations } from '@storyforge/editor-schema';
import { e2eEnvironment } from './e2e-env';

export interface ChapterLocation {
  workId: string;
  chapterId: string;
}

interface SnapshotState {
  work_id: string;
  chapter_id: string;
  document: ProseMirrorNode;
  server_version: number;
  content_hash: string;
}
interface ChangeState {
  change_id: string;
  work_id: string;
  chapter_id: string;
  base_version: number;
}
interface LeaseState {
  chapter_id: string;
  owner_id: string;
  fencing_token: number;
  expires_at: number;
}
interface ConflictState {
  id: string;
  work_id: string;
  chapter_id: string;
  base_version: number;
  server_version: number;
  local_document: ProseMirrorNode;
}
interface MarkdownState { chapter_id: string; source: string; updated_at: string }

export interface LocalWritingState {
  snapshot?: SnapshotState;
  changes: ChangeState[];
  leases: LeaseState[];
  conflicts: ConflictState[];
  markdown?: MarkdownState;
}

export function chapterUrl(workId: string, chapterId: string): string {
  return `/works/${encodeURIComponent(workId)}/write/${encodeURIComponent(chapterId)}?tab=manuscript&panel=chapter`;
}

function locationFromUrl(value: string): ChapterLocation {
  const match = new URL(value).pathname.match(/^\/works\/([^/]+)\/write\/([^/]+)$/);
  if (!match) throw new Error(`Not a chapter URL: ${value}`);
  return { workId: decodeURIComponent(match[1]!), chapterId: decodeURIComponent(match[2]!) };
}

export async function login(page: Page): Promise<void> {
  const { authorEmail, authorPassword } = e2eEnvironment();
  await page.goto('/');
  const loginButton = page.getByRole('button', { name: '登录', exact: true });
  const worksHeading = page.getByRole('heading', { name: '作品库', exact: true });
  await expect(loginButton.or(worksHeading)).toBeVisible();
  if (await loginButton.isVisible()) {
    await page.getByLabel('邮箱').fill(authorEmail);
    await page.getByLabel('密码').fill(authorPassword);
    await loginButton.click();
  }
  await expect(worksHeading).toBeVisible();
}

export async function loginAndOpenChapter(page: Page, title: string): Promise<ChapterLocation> {
  await login(page);
  await page.getByRole('button', { name: '新建作品', exact: true }).click();
  await page.getByLabel('作品名称').fill(title);
  await page.getByLabel('作品简介').fill('M1 Playwright 真实验收作品');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.waitForURL(/\/works\/[^/]+\/write\/[^/]+/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expectSaveStatus(page, '已同步');
  return locationFromUrl(page.url());
}

export async function expectSaveStatus(page: Page, label: string): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: label })).toBeVisible({ timeout: 20_000 });
}

export async function getServerChapter(page: Page, location: ChapterLocation): Promise<Chapter> {
  const response = await page.request.get(
    `/api/v1/works/${encodeURIComponent(location.workId)}/chapters/${encodeURIComponent(location.chapterId)}`
  );
  expect(response.ok()).toBe(true);
  const body = await response.json() as { data: unknown };
  return chapterSchema.parse(body.data);
}

export async function postServerText(
  page: Page,
  location: ChapterLocation,
  text: string
): Promise<SaveChangeResponse> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'storyforge_csrf')?.value;
  expect(csrf).toBeTruthy();
  const document = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  };
  const response = await page.request.post(
    `/api/v1/works/${encodeURIComponent(location.workId)}/chapters/${encodeURIComponent(location.chapterId)}/changes`,
    {
      headers: { 'x-csrf-token': csrf! },
      data: {
        change_id: crypto.randomUUID(),
        client_id: crypto.randomUUID(),
        sequence: 1,
        base_version: 0,
        operations: replaceDocumentOperations(createEmptyDocument(), document)
      }
    }
  );
  expect(response.status()).toBe(200);
  const body = await response.json() as { data: unknown };
  return saveChangeResponseSchema.parse(body.data);
}

export async function readLocalState(page: Page, location: ChapterLocation): Promise<LocalWritingState> {
  const raw = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('storyforge-writing');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const storeNames = ['snapshots', 'changes', 'markdown', 'conflicts', 'leases'] as const;
    const transaction = db.transaction(storeNames, 'readonly');
    async function all(storeName: typeof storeNames[number]): Promise<Array<Record<string, unknown>>> {
      return await new Promise((resolve, reject) => {
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        request.onerror = () => reject(request.error);
      });
    }
    const [snapshots, changes, markdown, conflicts, leases] = await Promise.all(
      storeNames.map((name) => all(name))
    );
    db.close();
    return { snapshots, changes, markdown, conflicts, leases };
  });
  return {
    snapshot: raw.snapshots.find((item) => item.work_id === location.workId && item.chapter_id === location.chapterId) as SnapshotState | undefined,
    changes: raw.changes.filter((item) => item.work_id === location.workId && item.chapter_id === location.chapterId) as unknown as ChangeState[],
    markdown: raw.markdown.find((item) => item.chapter_id === location.chapterId) as MarkdownState | undefined,
    conflicts: raw.conflicts.filter((item) => item.work_id === location.workId && item.chapter_id === location.chapterId) as unknown as ConflictState[],
    leases: raw.leases.filter((item) => item.chapter_id === location.chapterId) as unknown as LeaseState[]
  };
}

export async function corruptSnapshot(page: Page, location: ChapterLocation): Promise<void> {
  await page.evaluate(async ({ workId, chapterId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('storyforge-writing');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get([workId, chapterId]);
      request.onsuccess = () => resolve(request.result as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    });
    if (!snapshot) throw new Error('Snapshot not found');
    snapshot.document = { type: 'paragraph' };
    await new Promise<void>((resolve, reject) => {
      const request = store.put(snapshot);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, location);
}

export async function crashBrowser(browser: Browser): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  const information = await session.send('SystemInfo.getProcessInfo') as {
    processInfo: Array<{ id: number; type: string }>;
  };
  const browserProcess = information.processInfo.find((item) => item.type === 'browser');
  if (!browserProcess) throw new Error('Chromium browser process id not found');
  process.kill(browserProcess.id, 'SIGKILL');
  await expect.poll(() => browser.isConnected(), { timeout: 10_000 }).toBe(false);
}
```

将 `playwright.config.ts` 完整替换为以下版本。默认 Chromium 只用于 M1 验收和基线采集，不代表 M5 跨浏览器门槛：

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
  timeout: 60_000,
  expect: { timeout: 10_000 },
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

将根 `package.json` 完整替换为以下版本，再运行 pnpm 更新 lockfile；不在文档中手写依赖锁定结果：

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
    "verify:m1:db": "node scripts/verify-m1-db-failure.mjs",
    "verify:m1": "node scripts/verify-m1.mjs",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "ci": "pnpm --filter @storyforge/contracts build && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@axe-core/playwright": "^4.10.2",
    "@playwright/test": "^1.51.1",
    "@storyforge/editor-schema": "workspace:*",
    "dotenv": "^16.5.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: 写入真实 PostgreSQL 行锁与重启故障脚本**

`scripts/verify-m1-db-failure.mjs` 必须先取得真实章节行锁，再发起保存；只有观察到保存事务等待锁后才重启 Docker PostgreSQL。脚本要求显式 `M1_ALLOW_DATABASE_RESTART=1`，测试库仍强制以 `_test` 结尾：

```js
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = join(root, 'test-results', 'm1-evidence');
const evidencePath = join(evidenceDirectory, 'db-failure.json');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';
const authorEmail = process.env.AUTHOR_EMAIL;
const authorPassword = process.env.AUTHOR_PASSWORD;
const apiRequire = createRequire(join(root, 'apps/api', 'package.json'));
const { Client } = apiRequire('pg');
const baseUrl = 'http://127.0.0.1:3102';
let apiProcess;
let blocker;
let observer;

function safeError(error) {
  return String(error instanceof Error ? error.stack ?? error.message : error)
    .replaceAll(databaseUrl, '[redacted-database-url]')
    .replaceAll(authorPassword ?? '__no_password__', '[redacted-password]');
}

function execute(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'unknown'}`);
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out${lastError ? `: ${safeError(lastError)}` : ''}`);
}

async function startApi() {
  apiProcess = spawn(pnpm, ['--filter', '@storyforge/api', 'start'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      PORT: '3102',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
      SESSION_TTL_SECONDS: '604800'
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32'
  });
  await waitFor(async () => {
    if (apiProcess.exitCode !== null) throw new Error(`API exited with ${apiProcess.exitCode}`);
    const response = await fetch(`${baseUrl}/api/v1/health`);
    return response.ok;
  }, 'API health');
}

async function stopApi() {
  if (!apiProcess?.pid || apiProcess.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(apiProcess.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-apiProcess.pid, 'SIGTERM'); } catch { /* 进程已退出。 */ }
  }
  await Promise.race([
    new Promise((resolve) => apiProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
}

async function main() {
  if (process.env.M1_ALLOW_DATABASE_RESTART !== '1') {
    throw new Error('Set M1_ALLOW_DATABASE_RESTART=1 only for the disposable PostgreSQL test service');
  }
  if (!authorEmail || !authorPassword) throw new Error('AUTHOR_EMAIL and AUTHOR_PASSWORD are required');
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) throw new Error('TEST_DATABASE_URL must end in _test');

  execute('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', 'postgres', '--wait']);
  execute(pnpm, ['--filter', '@storyforge/api', 'test:prepare']);
  await startApi();

  const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: authorEmail, password: authorPassword })
  });
  if (!loginResponse.ok) throw new Error(`Login failed with HTTP ${loginResponse.status}`);
  await loginResponse.json();
  const cookies = new Map();
  for (const item of loginResponse.headers.getSetCookie()) {
    const [pair] = item.split(';');
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const session = cookies.get('storyforge_session');
  const csrf = cookies.get('storyforge_csrf');
  if (!session || !csrf) throw new Error('Login did not return both session and CSRF cookies');
  const cookieHeader = `storyforge_session=${session}; storyforge_csrf=${csrf}`;

  async function api(path, method = 'GET', body) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Cookie: cookieHeader,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': csrf })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  async function data(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(`API returned HTTP ${response.status}: ${JSON.stringify(body.error ?? {})}`);
    return body.data;
  }

  const created = await data(await api('/api/v1/works', 'POST', {
    title: `M1 数据库故障 ${Date.now()}`,
    description: '真实行锁与 PostgreSQL 重启验收'
  }));
  const workId = created.work.id;
  const chapterId = created.first_chapter_id;
  const change = {
    change_id: randomUUID(),
    client_id: randomUUID(),
    sequence: 1,
    base_version: 0,
    operations: [{
      stepType: 'replace',
      from: 1,
      to: 1,
      slice: { content: [{ type: 'text', text: '数据库故障后正文' }] }
    }]
  };

  blocker = new Client({ connectionString: databaseUrl });
  observer = new Client({ connectionString: databaseUrl });
  await blocker.connect();
  await observer.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM chapters WHERE id = $1 FOR UPDATE', [chapterId]);

  let settled = false;
  const interrupted = api(
    `/api/v1/works/${workId}/chapters/${chapterId}/changes`,
    'POST',
    change
  ).then(async (response) => ({
    status: response.status,
    body: await response.text()
  })).catch((error) => ({
    status: 0,
    body: error instanceof Error ? error.name : 'NetworkError'
  })).finally(() => { settled = true; });

  await waitFor(async () => {
    const waiting = await observer.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'"
    );
    return waiting.rows[0].count > 0;
  }, 'save transaction row-lock wait');
  if (settled) throw new Error('Save completed before the injected database restart');

  execute('docker', ['compose', '-f', 'infra/docker-compose.yml', 'restart', 'postgres']);
  execute('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', 'postgres', '--wait']);
  const interruptedResult = await Promise.race([
    interrupted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Interrupted save did not settle')), 15_000))
  ]);
  if (interruptedResult.status >= 200 && interruptedResult.status < 300) {
    throw new Error('Interrupted save unexpectedly returned success');
  }

  await waitFor(async () => (await fetch(`${baseUrl}/api/v1/health`)).ok, 'API health after database restart');
  const verification = new Client({ connectionString: databaseUrl });
  await verification.connect();
  try {
    const afterFailure = await verification.query(
      'SELECT version, document FROM chapters WHERE id = $1',
      [chapterId]
    );
    const failureChanges = await verification.query(
      'SELECT count(*)::int AS count FROM chapter_changes WHERE chapter_id = $1',
      [chapterId]
    );
    if (afterFailure.rows[0]?.version !== 0 || failureChanges.rows[0]?.count !== 0) {
      throw new Error('Database contains a partial chapter save after restart');
    }
    if (afterFailure.rows[0]?.document?.content?.[0]?.content !== undefined) {
      throw new Error('Chapter document changed despite the interrupted transaction');
    }

    const retryResponse = await api(
      `/api/v1/works/${workId}/chapters/${chapterId}/changes`,
      'POST',
      change
    );
    const retry = await data(retryResponse);
    if (retry.server_version !== 1) throw new Error('Retry did not commit version 1');
    const replay = await data(await api(
      `/api/v1/works/${workId}/chapters/${chapterId}/changes`,
      'POST',
      change
    ));
    if (replay.change_id !== retry.change_id || replay.server_version !== 1) {
      throw new Error('Idempotent replay returned a different result');
    }
    const finalChapter = await verification.query(
      'SELECT version, document FROM chapters WHERE id = $1',
      [chapterId]
    );
    const finalChanges = await verification.query(
      'SELECT count(*)::int AS count FROM chapter_changes WHERE chapter_id = $1',
      [chapterId]
    );
    if (finalChapter.rows[0]?.version !== 1 || finalChanges.rows[0]?.count !== 1) {
      throw new Error('Retry or idempotent replay produced duplicate state');
    }
    if (finalChapter.rows[0]?.document?.content?.[0]?.content?.[0]?.text !== '数据库故障后正文') {
      throw new Error('Retry did not preserve the requested document');
    }

    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(evidencePath, JSON.stringify({
      schema_version: 1,
      passed: true,
      captured_at: new Date().toISOString(),
      row_lock_observed: true,
      database_restarted_while_save_waiting: true,
      interrupted_response: { status: interruptedResult.status },
      after_failure: { version: 0, chapter_changes: 0 },
      retry: { server_version: retry.server_version, chapter_changes: 1 },
      idempotent_replay: { server_version: replay.server_version, chapter_changes: 1 }
    }, null, 2), 'utf8');
    console.info(`M1 database failure evidence: ${evidencePath}`);
  } finally {
    await verification.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(evidencePath, JSON.stringify({
    schema_version: 1,
    passed: false,
    captured_at: new Date().toISOString(),
    error: safeError(error)
  }, null, 2), 'utf8');
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  if (observer) await observer.end().catch(() => undefined);
  if (blocker) {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end().catch(() => undefined);
  }
  await stopApi();
}
```

- [ ] **Step 5: 单独验证数据库故障 RED → GREEN**

Run: `docker compose -f infra/docker-compose.yml up -d postgres --wait`
Run: `M1_ALLOW_DATABASE_RESTART=1 pnpm verify:m1:db`（Windows PowerShell 使用 `$env:M1_ALLOW_DATABASE_RESTART='1'; pnpm verify:m1:db`）
Expected: 脚本文件写入前命令提示模块不存在；写入后观察到行锁等待，保存请求在数据库重启后以网络错误或 5xx 结束，章节仍为版本 0 且变更数为 0；相同 change 重试得到版本 1，幂等重放仍为版本 1 且仅一条变更记录。脚本不得输出密码、会话 Cookie 或数据库连接串。

- [ ] **Step 6: 写入完整验收入口、CI 与文档同步内容**

`scripts/verify-m1.mjs` 逐项保存真实命令退出码，只有全部检查、数据库故障证据和环境完整的性能基线同时有效时才写“通过”：

```js
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = join(root, 'test-results', 'm1-evidence');
const reportPath = join(root, 'docs', '05-测试与验收报告', 'M1写作基座验收报告.md');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';
mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });

function execute(command, args, env = process.env) {
  return spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024
  });
}
function requiredOutput(command, args) {
  const result = execute(command, args);
  if (result.status !== 0) throw new Error(`Unable to collect ${args.join(' ')}`);
  return result.stdout.trim();
}
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

if (process.env.M1_ALLOW_DATABASE_RESTART !== '1') {
  throw new Error('M1 verification requires M1_ALLOW_DATABASE_RESTART=1 for the disposable test database service');
}
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error('TEST_DATABASE_URL must end in _test');
}
const testEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
  M1_ALLOW_DATABASE_RESTART: '1'
};
const checks = [
  { id: 'docker', label: 'PostgreSQL 16 测试服务', command: 'docker', args: ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', 'postgres', '--wait'] },
  { id: 'workspace-ci', label: '工作区 CI', command: pnpm, args: ['run', 'ci'] },
  { id: 'compliance', label: '四类合规检查', command: 'python', args: ['scripts/run_checks.py', '--path', '.'] },
  { id: 'legacy-pytest', label: '旧 Python 测试', command: 'python', args: ['-m', 'pytest', '-q'] },
  { id: 'legacy-compile', label: '旧 Python 语法编译', command: 'python', args: ['-m', 'compileall', '-q', '.'] },
  { id: 'migration-fresh', label: '测试库清表与完整显式迁移', command: pnpm, args: ['--filter', '@storyforge/api', 'test:prepare'], env: testEnv },
  { id: 'migration-second', label: '显式迁移幂等重跑', command: pnpm, args: ['--filter', '@storyforge/api', 'migration:run'], env: testEnv },
  { id: 'browser', label: 'M0/M1 Chromium 浏览器验收', command: pnpm, args: ['test:e2e'], env: testEnv },
  { id: 'database-failure', label: '保存中行锁等待与数据库重启', command: 'node', args: ['scripts/verify-m1-db-failure.mjs'], env: testEnv }
];

const revision = requiredOutput('git', ['rev-parse', 'HEAD']);
const pnpmVersion = requiredOutput(pnpm, ['--version']);
const results = [];
for (const check of checks) {
  const completed = execute(check.command, check.args, check.env ?? process.env);
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

let postgresVersion = '查询失败';
let databasePassed = false;
const apiRequire = createRequire(join(root, 'apps/api', 'package.json'));
const { Client } = apiRequire('pg');
const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const version = await client.query('SHOW server_version');
  postgresVersion = String(version.rows[0].server_version);
  databasePassed = postgresVersion.startsWith('16.');
} catch {
  databasePassed = false;
} finally {
  await client.end().catch(() => undefined);
}

const repeatedMigration = results.find((result) => result.id === 'migration-second');
const repeatedMigrationPassed = repeatedMigration?.exitCode === 0
  && repeatedMigration.output.includes('No migrations are pending');
const performancePath = join(evidenceDirectory, 'performance.json');
const databaseFailurePath = join(evidenceDirectory, 'db-failure.json');
const performance = existsSync(performancePath) ? json(performancePath) : undefined;
const databaseFailure = existsSync(databaseFailurePath) ? json(databaseFailurePath) : undefined;
const performancePassed = performance?.schema_version === 1
  && performance.m5_gate_claimed === false
  && performance.hardware?.cpu_model
  && performance.browser?.version
  && performance.dataset?.initial_characters === 10_000
  && performance.network?.included === true
  && performance.metrics?.input_wall_ms?.samples?.length === 20
  && performance.metrics?.chapter_open_wall_ms?.samples?.length === 5;
const databaseFailurePassed = databaseFailure?.passed === true
  && databaseFailure.row_lock_observed === true
  && databaseFailure.database_restarted_while_save_waiting === true
  && databaseFailure.after_failure?.version === 0
  && databaseFailure.after_failure?.chapter_changes === 0
  && databaseFailure.retry?.server_version === 1
  && databaseFailure.idempotent_replay?.chapter_changes === 1;
const toolchainPassed = process.version === 'v22.16.0' && pnpmVersion === '10.12.4';
const allPassed = results.length === checks.length
  && results.every((result) => result.exitCode === 0)
  && repeatedMigrationPassed
  && databasePassed
  && performancePassed
  && databaseFailurePassed
  && toolchainPassed;
const browserPassed = results.find((result) => result.id === 'browser')?.exitCode === 0;
const pythonResult = results.find((result) => result.id === 'legacy-pytest');
const pythonSummary = pythonResult?.output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '未执行到测试汇总';

const report = [
  '# M1 写作基座验收报告',
  '',
  `> 状态：${allPassed ? '通过' : '未通过'}`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
  '## 环境与基线',
  '',
  '| 项目 | 实测值 |',
  '| --- | --- |',
  `| Git 验收基线（Task 14 提交前 HEAD） | \`${revision}\` |`,
  `| Node.js / pnpm | \`${process.version}\` / \`${pnpmVersion}\` |`,
  `| PostgreSQL | \`${postgresVersion}\` |`,
  `| 旧 Python 测试汇总 | ${cell(pythonSummary)} |`,
  `| 重复显式迁移 | ${repeatedMigrationPassed ? 'No migrations are pending' : '未确认'} |`,
  '',
  '## 命令结果',
  '',
  '| 验收项 | 命令 | 退出码 | 本地证据 |',
  '| --- | --- | ---: | --- |',
  ...results.map((result) => `| ${result.label} | \`${result.command} ${result.args.join(' ')}\` | ${result.exitCode} | \`test-results/m1-evidence/${result.id}.log\` |`),
  '',
  '## 写作、恢复与冲突验收',
  '',
  `- 作品创建、富文本/Markdown、自动保存、深链和 WAL 导出：${browserPassed ? '通过' : '未通过'}。`,
  `- 真实 Chromium 进程崩溃后 IndexedDB pending 恢复：${browserPassed ? '通过' : '未通过'}。`,
  `- 409 三方正文保留、人工选择、多标签 TTL/fencing：${browserPassed ? '通过' : '未通过'}。`,
  `- 断网、非法 Markdown、配额、WAL 损坏和服务端恢复：${browserPassed ? '通过' : '未通过'}。`,
  `- 375/768/1024/1440、键盘/dialog 焦点及 axe-core：${browserPassed ? '通过' : '未通过'}。`,
  `- 保存事务等待真实行锁时重启 PostgreSQL：${databaseFailurePassed ? '通过；无半提交，重试和幂等重放均为一个版本/一条变更' : '未通过'}。`,
  '',
  '## M1 性能基线（不是 M5 门槛结论）',
  '',
  '| 项目 | 实测值 |',
  '| --- | --- |',
  `| 硬件 | ${performance ? cell(`${performance.hardware.cpu_model}; ${performance.hardware.logical_cpus} logical CPUs; ${performance.hardware.memory_bytes} bytes; ${performance.hardware.platform} ${performance.hardware.release}`) : '未采集'} |`,
  `| 浏览器 | ${performance ? cell(`${performance.browser.name} ${performance.browser.version}`) : '未采集'} |`,
  `| 数据集 | ${performance ? cell(JSON.stringify(performance.dataset)) : '未采集'} |`,
  `| 是否含网络 | ${performance ? cell(`${performance.network.included}; ${performance.network.kind}`) : '未采集'} |`,
  `| 输入 wall time P95 | ${performance ? `${performance.metrics.input_wall_ms.p95} ms（含 Playwright 协议，不是 M5 Event Timing 门槛）` : '未采集'} |`,
  `| 打开章节 wall time P95 | ${performance ? `${performance.metrics.chapter_open_wall_ms.p95} ms（含回环网络）` : '未采集'} |`,
  '',
  'M1 不宣称千级章节导航虚拟化、最新两个主版本四浏览器兼容或 M5 正式性能/发布门槛已经完成。上述数值只用于后续里程碑对比。',
  '',
  '## 边界确认',
  '',
  '- ProseMirror JSON 是唯一正文；Markdown 经共享白名单转换；服务端在行锁事务内按 change_id 幂等保存。',
  '- 本地 WAL 只确认连续边界；409 不静默覆盖；租约为 15 秒 TTL、5 秒 heartbeat，并使用 fencing token。',
  '- 旧 Flask、JSON 业务数据和旧 UI 未修改、未迁移、未双写；NestJS 仅新增 M0/M1 PostgreSQL 表。',
  '- M2+ 修订、评论、AI、剧情、知识库和旧数据切换均不属于本次通过范围。',
  ''
].join('\n');
writeFileSync(reportPath, report, 'utf8');
console.info(`M1 verification report: ${reportPath}`);
if (!allPassed) process.exitCode = 1;
```

将 `.github/workflows/ci.yml` 完整替换为以下配置。PostgreSQL 改由 Docker Compose 管理，故障脚本才能在 CI 中真实重启数据库；`pnpm verify:m1` 已包含工作区 CI、合规、旧测试、迁移、E2E 和故障检查，不重复执行：

```yaml
name: CI

on:
  push:
    branches: [main, master, develop]
  pull_request:
    branches: [main, master, develop]

jobs:
  m1:
    name: M0/M1 新旧系统与写作基座验收
    runs-on: ubuntu-22.04
    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test
      TEST_DATABASE_URL: postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test
      PORT: 3001
      WEB_ORIGIN: http://127.0.0.1:5173
      SESSION_TTL_SECONDS: 604800
      AUTHOR_EMAIL: ${{ secrets.M0_AUTHOR_EMAIL }}
      AUTHOR_DISPLAY_NAME: M1 CI Author
      AUTHOR_PASSWORD: ${{ secrets.M0_AUTHOR_PASSWORD }}
      M1_ALLOW_DATABASE_RESTART: "1"
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
      - name: Start disposable PostgreSQL 16
        run: docker compose -f infra/docker-compose.yml up -d postgres --wait
      - name: Create isolated test database
        run: docker compose -f infra/docker-compose.yml exec -T postgres psql -U storyforge -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE storyforge_test"
      - name: Install workspace dependencies
        run: pnpm install --frozen-lockfile
      - name: Install Chromium
        run: pnpm exec playwright install --with-deps chromium
      - name: Check required author secrets without printing them
        run: node -e "for (const key of ['AUTHOR_EMAIL','AUTHOR_PASSWORD']) { if (!process.env[key]) throw new Error(key + ' repository secret is required'); }"
      - name: Run complete M1 verification
        run: pnpm verify:m1
      - name: Upload M1 evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: m1-writing-foundation-evidence
          path: |
            test-results/
            playwright-report/
            docs/05-测试与验收报告/M1写作基座验收报告.md
          retention-days: 14
```

在 `docs/02-技术与架构/技术栈.md` 末尾追加以下完整章节；前文旧系统描述保持原样，不宣称 Flask 已退场：

```markdown
## 九、M1 写作基座目标架构（2026-11-15）

M1 在 M0 隔离工作区上增加以下能力，实际通过状态以 `docs/05-测试与验收报告/M1写作基座验收报告.md` 的实测结果为准：

| 工作区 | 技术 | M1 职责 |
| --- | --- | --- |
| `packages/editor-schema` | ProseMirror Schema/Step、markdown-it、prosemirror-markdown | 唯一正文 Schema、Step 应用、严格 Markdown 白名单互转 |
| `packages/design-tokens` | CSS tokens、React 主题控制 | 墨韵科技风明暗主题、响应式与 reduced-motion |
| `apps/api/src/writing` | NestJS、TypeORM、PostgreSQL 行锁事务 | 作品/卷章节 API、change_id 幂等、原子正文保存、409 服务端正文 |
| `apps/web/src/persistence` | IndexedDB/idb | 快照、连续确认 WAL、冲突备份、15 秒租约与 fencing token |
| `apps/web/src/editor` | React、ProseMirror | 双模式编辑、自动保存、恢复和人工冲突处理 |
| `apps/web/src/workbench` | React Router、原生 dialog | 三栏工作台、章节树、深链、窄屏抽屉和焦点恢复 |
| `tests/e2e` 与 `scripts/verify-m1*` | Playwright、axe-core、Docker PostgreSQL | 崩溃/断网/冲突/多标签/数据库重启验收与环境化性能基线 |

旧 Flask 仍是既有小说业务数据的唯一写入方。M1 不读取或修改旧 JSON 业务数据，不开放双写，不实现 M2+ 修订、评论、AI、剧情或知识库，也不执行旧数据迁移。
```

在 `docs/02-技术与架构/目录结构.md` 末尾追加以下完整章节：

````markdown
## 七、M1 新增写作基座目录

```text
StoryForgeAI/
├── apps/
│   ├── api/src/writing/              # 作品、卷章节与锁内幂等正文保存
│   └── web/src/
│       ├── api/                      # 同源 API、CSRF 与结构化错误
│       ├── works/                    # 作品库和完整 writing-client
│       ├── editor/                   # 双模式、WAL 保存控制与人工冲突 UI
│       ├── persistence/              # IndexedDB 快照/WAL/备份/写入租约
│       └── workbench/                # 三栏、章节树、深链与响应式 dialog
├── packages/
│   ├── contracts/src/writing.ts      # 写作与冲突共享契约
│   ├── editor-schema/                # 唯一 Schema、Step 与 Markdown 白名单
│   └── design-tokens/                # 双主题设计令牌
├── tests/e2e/m1-*                   # 真实浏览器、故障、axe 和基线
└── scripts/verify-m1*               # 数据库重启及完整验收报告
```

这些目录与 Flask 既有目录并存，不重排旧业务文件。M4 之前的迁移和唯一写入方切换不在本目录状态中。
````

在 `docs/03-规划与路线/小说AI写作软件改造实施路线图.md` 末尾追加以下完整章节，避免把旧 P5 记录或 M1 基线误写成新架构全量发布完成：

```markdown
## M1 写作基座实施记录（2026-11-15）

- 新架构里程碑：M0 提供 Monorepo、鉴权与工程基座；M1 增加作品库、卷章节树、三栏写作工作台、ProseMirror/Markdown、IndexedDB WAL、原子保存、崩溃恢复、409 人工冲突处理和单章节多标签写入保护。
- 验收依据：`2026-11-15-m1-writing-foundation.md` Task 1–14 与 `docs/05-测试与验收报告/M1写作基座验收报告.md`；只有报告状态为“通过”才将 M1 标记完成。
- 性能记录：M1 仅保存注明硬件、Chromium 版本、单章 1 万字数据集和回环网络的基线；千级章节虚拟化、四浏览器最新两个主版本及正式性能门槛留给 M5。
- 系统边界：旧 Flask 与旧 JSON 业务数据保持原写入路径，未迁移、未双写、未退场。M2/M3/M4 仍分别负责变更协作、AI 创作和迁移切换。
```

- [ ] **Step 7: 安装锁定依赖并运行全部 M1 浏览器 GREEN 验证**

Run: `pnpm install`
Expected: `@axe-core/playwright` 与根工作区对 `@storyforge/editor-schema` 的引用安装成功，`pnpm-lock.yaml` 由 pnpm 实际更新；不得手工编造 lockfile。

Run: `pnpm --filter @storyforge/contracts build && pnpm exec playwright install chromium`
Expected: 共享契约构建成功，Chromium 安装成功。

Run: `pnpm exec playwright test tests/e2e/m1-writing.spec.ts tests/e2e/m1-recovery.spec.ts tests/e2e/m1-conflict.spec.ts tests/e2e/m1-multitab.spec.ts tests/e2e/m1-resilience.spec.ts tests/e2e/m1-accessibility.spec.ts tests/e2e/m1-baseline.spec.ts`
Expected: 7 个 M1 spec 全部 PASS；崩溃恢复使用真实 Chromium 进程退出，409 由真实 API 写入触发，多标签经过真实 15 秒 TTL，配额与损坏注入均保留本地证据，四个宽度和双主题 axe 无违规；`test-results/m1-evidence/performance.json` 含 20 个输入样本、5 个章节打开样本且 `m5_gate_claimed=false`。若失败，修复实现或测试环境后重跑，不得删除故障断言或降低 axe 规则。

- [ ] **Step 8: 运行完整 M1 验收并提交实测通过证据**

先执行提交前工作区 CI 与合规检查：

Run: `pnpm run ci && python scripts/run_checks.py --path .`
Expected: Lint、类型检查、单元/集成测试、构建以及四类合规检查全部通过。

Linux/macOS Run: `M1_ALLOW_DATABASE_RESTART=1 pnpm verify:m1`
Windows PowerShell Run: `$env:M1_ALLOW_DATABASE_RESTART='1'; pnpm verify:m1`
Expected: Docker PostgreSQL 16、工作区 CI、`python scripts/run_checks.py --path .`、旧 Python 测试与语法编译、全新显式迁移、第二次迁移输出 `No migrations are pending`、全部 M0/M1 Playwright、真实行锁等待期间数据库重启、重试与幂等重放、性能证据和数据库故障证据全部通过。`docs/05-测试与验收报告/M1写作基座验收报告.md` 必须实测生成且首段为 `> 状态：通过`；若任一命令失败或报告为“未通过”，不得提交。

只暂存本任务明确列出的文件，不把 `test-results/`、Playwright 临时 profile、trace、截图或本机会话写入 Git：

```bash
git add tests/e2e/m1-helpers.ts tests/e2e/m1-writing.spec.ts tests/e2e/m1-recovery.spec.ts tests/e2e/m1-conflict.spec.ts tests/e2e/m1-multitab.spec.ts tests/e2e/m1-resilience.spec.ts tests/e2e/m1-accessibility.spec.ts tests/e2e/m1-baseline.spec.ts scripts/verify-m1-db-failure.mjs scripts/verify-m1.mjs playwright.config.ts package.json pnpm-lock.yaml .github/workflows/ci.yml docs/05-测试与验收报告/M1写作基座验收报告.md docs/02-技术与架构/技术栈.md docs/02-技术与架构/目录结构.md docs/03-规划与路线/小说AI写作软件改造实施路线图.md
git commit -m "test: verify the M1 writing foundation"
```

---

## 三、M1 完成定义

只有同时满足以下条件，才能把 M1 标记为完成：

1. Task 1–14 均按顺序完成，每次提交前的任务测试、相关 CI/静态检查和 `python scripts/run_checks.py --path .` 均真实通过；最终 CI 的 `pnpm verify:m1` 也通过。
2. `docs/05-测试与验收报告/M1写作基座验收报告.md` 由脚本根据当次实测生成并明确为“通过”，不是人工预写的通过结论；性能 JSON 与数据库故障 JSON 和报告中的环境、退出码一致。
3. ProseMirror JSON 是浏览器、API 和 PostgreSQL 中唯一正文；Markdown 只通过共享严格白名单互转，非法输入保留源码并报告精确位置，不进入正文保存链。
4. 本地 Step 先写 IndexedDB WAL；快照只推进到最老连续已确认边界，后续 pending 保留。服务端在单一行锁事务内完成 `change_id` 幂等、Step 应用、正文更新和变更插入，409 返回服务端正文且不静默覆盖本地。
5. 真实 Chromium 崩溃、断网、配额失败、快照损坏和 PostgreSQL 保存中途重启均有通过证据；恢复前保留本地备份，未确认内容不能因自动初始化或恢复而无声丢失。
6. 单章节多标签使用 IndexedDB 租约、15 秒 TTL、5 秒 heartbeat 和递增 fencing token；失去租约的旧页面只读，不能继续 append、flush 或解决冲突写入。
7. 作品库、卷章节树、三栏工作台、章节深链、窄屏 dialog、焦点恢复、键盘操作、明暗主题和四个规定宽度的浏览器/axe 验收全部通过。
8. M1 只记录带硬件、操作系统、Chromium 版本、数据集和网络说明的性能基线；千级章节虚拟化、最新两个主版本四浏览器矩阵、正式性能门槛和发布门槛仍属 M5，不得在本里程碑宣称完成。
9. 旧 Flask、旧 JSON 业务数据和旧写入路径保持不变；不迁移旧数据、不双写，不提前交付 M2+ 修订、评论、AI、剧情树或知识库。
