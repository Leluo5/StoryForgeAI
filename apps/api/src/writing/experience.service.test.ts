import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { WorkEntity } from '../database/work.entity';
import { ExperienceService } from './experience.service';

let fixture: WritingFixture;
let service: ExperienceService;

beforeAll(async () => {
  fixture = await createWritingFixture();
  service = new ExperienceService(fixture.dataSource);
});
afterAll(() => destroyWritingFixture(fixture));

async function insertWork(overrides: Partial<WorkEntity> = {}): Promise<WorkEntity> {
  return fixture.dataSource.getRepository(WorkEntity).save({
    id: crypto.randomUUID(),
    author_id: fixture.authorId,
    title: '公开作品',
    description: '',
    status: 'active',
    is_public: true,
    access_code: '',
    interaction_type: 'chat',
    suggested_questions: [],
    parameters: [],
    coze_meta: {},
    ...overrides
  });
}

function mockResponse(): { response: Response; writes: string[] } {
  const writes: string[] = [];
  const response = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => { writes.push(chunk); return true; })
  } as unknown as Response;
  return { response, writes };
}

describe('ExperienceService', () => {
  it('lists only public works', async () => {
    await insertWork({ title: '公开A', is_public: true });
    await insertWork({ title: '私有B', is_public: false });
    const works = await service.listPublicWorks();
    expect(works.length).toBeGreaterThanOrEqual(1);
    expect(works.every((w) => w.requires_access_code === false || w.requires_access_code === true)).toBe(true);
    expect(works.some((w) => w.name === '私有B')).toBe(false);
  });

  it('getPublicWork hides access_code/pat_token and surfaces requires_access_code', async () => {
    const work = await insertWork({ access_code: 'SECRET', coze_bot_id: 'bot-1', pat_token: 'pat-123' });
    const pub = await service.getPublicWork(work.id);
    expect(pub.requires_access_code).toBe(true);
    expect(pub.coze_bot_id).toBe('bot-1');
    expect('pat_token' in pub).toBe(false);
  });

  it('verifyAccess grants without code, rejects wrong code, issues token for correct code', async () => {
    const noCode = await insertWork({ access_code: '' });
    expect(await service.verifyAccess(noCode.id, { access_code: '' })).toEqual({ granted: true, token: null });

    const coded = await insertWork({ access_code: 'SUN' });
    await expect(service.verifyAccess(coded.id, { access_code: 'BAD' })).rejects.toBeInstanceOf(UnauthorizedException);
    const okRes = await service.verifyAccess(coded.id, { access_code: 'SUN' });
    expect(okRes.granted).toBe(true);
    expect(okRes.token).toBeTruthy();
  });

  it('getPublicWork throws Forbidden for non-public work', async () => {
    const work = await insertWork({ is_public: false });
    await expect(service.getPublicWork(work.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chatStream requires valid access token when work has access_code', async () => {
    const work = await insertWork({ access_code: 'SUN', coze_bot_id: 'bot-1', pat_token: 'pat-1' });
    const { response } = mockResponse();
    await expect(service.chatStream({
      workId: work.id,
      input: { user_id: 'visitor_1', message: 'hi', conversation_id: null },
      accessToken: null,
      response
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chatStream throws NotFound when work has no coze bot binding', async () => {
    const work = await insertWork({ coze_bot_id: null, pat_token: null });
    const { response } = mockResponse();
    await expect(service.chatStream({
      workId: work.id,
      input: { user_id: 'visitor_1', message: 'hi', conversation_id: null },
      accessToken: null,
      response
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('chatStream forwards Coze SSE deltas and done events', async () => {
    const work = await insertWork({ coze_bot_id: 'bot-1', pat_token: 'pat-1' });
    // 模拟 Coze SSE 上游
    const sseBody = [
      'event: conversation.message.delta\ndata: {"data":{"content":"你好"}}\n\n',
      'event: conversation.message.delta\ndata: {"data":{"content":"，世界"}}\n\n',
      'event: conversation.chat.completed\ndata: {"data":{"conversation_id":"conv-9","id":"conv-9"}}\n\n'
    ].join('');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseBody));
          controller.close();
        }
      })
    } as unknown as globalThis.Response);

    const { response, writes } = mockResponse();
    await service.chatStream({
      workId: work.id,
      input: { user_id: 'visitor_1', message: 'hi', conversation_id: null },
      accessToken: null,
      response
    });

    const all = writes.join('');
    expect(all).toContain('event: delta');
    expect(all).toContain('"content":"你好"');
    expect(all).toContain('"content":"，世界"');
    expect(all).toContain('event: done');
    expect(all).toContain('conv-9');
    vi.restoreAllMocks();
  });
});
