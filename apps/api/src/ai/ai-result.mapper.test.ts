import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import type { ProseMirrorNode } from '@storyforge/contracts';
import { applyOperations } from '@storyforge/editor-schema';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiResultMapper, toRevisionOperations } from './ai-result.mapper';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { ChapterEntity } from '../database/chapter.entity';

let fixture: WritingFixture;
let mapper: AiResultMapper;

function makeDoc(text: string): ProseMirrorNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  mapper = new AiResultMapper(fixture.dataSource, {
    record: vi.fn(async () => ({ id: randomUUID() }))
  } as never);
});

afterEach(() => destroyWritingFixture(fixture));

describe('toRevisionOperations', () => {
  it('returns an empty array when the candidate equals the base document', () => {
    const doc = makeDoc('相同内容');
    expect(toRevisionOperations(doc, doc)).toEqual([]);
  });

  it('returns a single ReplaceStep when the candidate differs', () => {
    const base = makeDoc('第一段');
    const candidate = makeDoc('第一段（续写）');
    const ops = toRevisionOperations(base, candidate);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.stepType).toBe('replace');
    expect(ops[0]!.from).toBe(0);
  });

  it('ignores pid-only differences between base and candidate', () => {
    const pid = '11111111-1111-4111-8111-111111111111';
    const base: ProseMirrorNode = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { pid }, content: [{ type: 'text', text: '同一段' }] }]
    };
    expect(toRevisionOperations(base, makeDoc('同一段'))).toEqual([]);
    expect(toRevisionOperations(makeDoc('同一段'), base)).toEqual([]);
  });

  it('reuses pids for unchanged paragraphs and allocates new pids for rewritten ones', () => {
    const firstPid = '11111111-1111-4111-8111-111111111111';
    const secondPid = '22222222-2222-4222-8222-222222222222';
    const base: ProseMirrorNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { pid: firstPid }, content: [{ type: 'text', text: '第一段' }] },
        { type: 'paragraph', attrs: { pid: secondPid }, content: [{ type: 'text', text: '第二段' }] }
      ]
    };
    const candidate: ProseMirrorNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第二段改写' }] }
      ]
    };
    const applied = applyOperations(base, toRevisionOperations(base, candidate)).toJSON() as {
      content: Array<{ attrs?: { pid?: string } }>;
    };
    expect(applied.content[0]?.attrs?.pid).toBe(firstPid);
    expect(applied.content[1]?.attrs?.pid).not.toBe(secondPid);
    expect(applied.content[1]?.attrs?.pid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects an invalid candidate document', () => {
    const base = makeDoc('内容');
    expect(() => toRevisionOperations(base, { type: 'doc', content: [] })).toThrow();
  });
});

describe('AiResultMapper.toAiRevisionSet', () => {
  it('creates an ai revision set with pending operations when the base version matches', async () => {
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: fixture.chapterId });
    const candidate = makeDoc('（AI 续写）新内容');
    const result = await fixture.dataSource.transaction(async (manager: EntityManager) => {
      return mapper.toAiRevisionSet(manager, {
        authorId: fixture.authorId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        baseVersion: chapter.version,
        candidateDocument: candidate
      });
    });

    expect(result.revision_set_id).not.toBeNull();
    expect(result.stale).toBe(false);

    const stored = await fixture.dataSource.getRepository(RevisionSetEntity).findOneByOrFail({ id: result.revision_set_id! });
    expect(stored.actor_type).toBe('ai');
    expect(stored.ai_set).toBe(true);
    expect(stored.base_version).toBe(chapter.version);
    expect(stored.status).toBe('pending');
    expect(stored.operations).toHaveLength(1);
    const op = stored.operations[0] as { index: number; step: Record<string, unknown>; status: string };
    expect(op.index).toBe(0);
    expect(op.status).toBe('pending');
    expect(op.step.stepType).toBe('replace');
  });

  it('marks the result as stale when the base version has changed', async () => {
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: fixture.chapterId });
    // 模拟章节基准版本已变化（AI 输出基于旧版本生成）：用合法的旧版本 0
    const oldBaseVersion = chapter.version > 0 ? 0 : chapter.version;
    const candidate = makeDoc('基于旧版本的重写');
    const result = await fixture.dataSource.transaction(async (manager: EntityManager) => {
      return mapper.toAiRevisionSet(manager, {
        authorId: fixture.authorId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        baseVersion: oldBaseVersion,
        candidateDocument: candidate
      });
    });

    expect(result.revision_set_id).not.toBeNull();
    expect(result.stale).toBe(oldBaseVersion !== chapter.version);
    const stored = await fixture.dataSource.getRepository(RevisionSetEntity).findOneByOrFail({ id: result.revision_set_id! });
    expect(stored.base_version).toBe(oldBaseVersion);
  });

  it('returns null revision_set_id when the candidate equals the base (no revision set to create)', async () => {
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: fixture.chapterId });
    const result = await fixture.dataSource.transaction(async (manager: EntityManager) => {
      return mapper.toAiRevisionSet(manager, {
        authorId: fixture.authorId,
        workId: fixture.workId,
        chapterId: fixture.chapterId,
        baseVersion: chapter.version,
        candidateDocument: chapter.document // 候选 == 基准
      });
    });

    expect(result.revision_set_id).toBeNull();
    expect(result.stale).toBe(false);
  });

  it('throws when the chapter does not exist', async () => {
    await expect(fixture.dataSource.transaction(async (manager: EntityManager) => {
      return mapper.toAiRevisionSet(manager, {
        authorId: fixture.authorId,
        workId: fixture.workId,
        chapterId: randomUUID(),
        baseVersion: 0,
        candidateDocument: makeDoc('内容')
      });
    })).rejects.toThrow(/not found/i);
  });
});
