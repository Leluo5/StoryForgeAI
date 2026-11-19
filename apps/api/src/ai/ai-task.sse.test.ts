import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskEventBus, AiTaskSseService } from './ai-task.sse';
import { AiTaskService } from './ai-task.service';
import { AgentService } from '../agent/agent.service';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import type { AiTaskEvent } from '@storyforge/contracts';

let fixture: WritingFixture;
let service: AiTaskService;
let sse: AiTaskSseService;
let bus: AiTaskEventBus;

/** 构造一个最小任务（通过 AiTaskService.createTask 落库，保证事件/序号一致） */
async function createTask(): Promise<AiTaskEntity> {
  const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
    tool: 'continue',
    input_summary: { selection: { from: 0, to: 10 } },
    idempotency_key: randomUUID()
  });
  return fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
}

/** 直接落库一个 scope='plot'、无章节的推衍任务（ai_tasks.chapter_id 允许为空） */
async function createPlotTask(): Promise<AiTaskEntity> {
  const repo = fixture.dataSource.getRepository(AiTaskEntity);
  return repo.save(repo.create({
    id: randomUUID(),
    idempotency_key: `plot-${randomUUID()}`,
    work_id: fixture.workId,
    chapter_id: null,
    scope: 'plot',
    tool: 'plot_derivation',
    agent_id: null,
    input_summary: { session_id: randomUUID(), step_no: 1 },
    base_version: 0,
    status: 'queued',
    event_seq: 0,
    result_revision_set_id: null,
    error: null,
    attempts: 0,
    created_by: fixture.authorId
  }));
}

/** 直接向 ai_task_events 写一个事件（模拟 appendEvent 落库，绕过广播；用于补取测试） */
async function insertEvent(taskId: string, seq: number, type: string, payload: Record<string, unknown>): Promise<void> {
  const repo = fixture.dataSource.getRepository(AiTaskEventEntity);
  const event = repo.create();
  event.id = randomUUID();
  event.task_id = taskId;
  event.event_seq = seq;
  event.type = type as AiTaskEvent['type'];
  event.payload = payload;
  await repo.save(event);
}

/** 模拟 Response：收集 write 内容 + flushHeaders + 触发 close */
function makeResponse(): { res: Response; chunks: string[]; triggerClose: () => void } {
  const chunks: string[] = [];
  const closeListeners: Array<() => void> = [];
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      chunks.push(String(chunk));
      return true;
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') closeListeners.push(listener);
      return res;
    }),
    __close: () => closeListeners.forEach((l) => l())
  } as unknown as Response;
  return {
    res,
    chunks,
    triggerClose: () => (res as unknown as { __close: () => void }).__close()
  };
}

/** 模拟 Request：仅需 on('close') */
function makeRequest(): { req: Request; triggerClose: () => void } {
  const closeListeners: Array<() => void> = [];
  const req = {
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') closeListeners.push(listener);
      return req;
    }),
    __close: () => closeListeners.forEach((l) => l())
  } as unknown as Request;
  return { req, triggerClose: () => (req as unknown as { __close: () => void }).__close() };
}

function parseFrames(chunks: string[]): Array<{ type: string; id: string; data: Record<string, unknown> }> {
  const frames: Array<{ type: string; id: string; data: Record<string, unknown> }> = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let type = '';
    let id = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event: ')) type = line.slice(7).trim();
      else if (line.startsWith('id: ')) id = line.slice(4).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (type && dataLines.length > 0) {
      frames.push({ type, id, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> });
    }
  }
  return frames;
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  bus = new AiTaskEventBus();
  service = new AiTaskService(fixture.dataSource, {
    record: vi.fn(async () => ({ id: randomUUID() }))
  } as never, {
    enqueue: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  }, bus,
  new AgentService(fixture.dataSource, { record: vi.fn() } as never, {} as never, {} as never, {} as never, {} as never));
  sse = new AiTaskSseService(fixture.dataSource, bus);
});

afterEach(async () => {
  await destroyWritingFixture(fixture);
});

describe('AiTaskEventBus', () => {
  it('publishes an event to subscribers of that task only', () => {
    const taskA = randomUUID();
    const taskB = randomUUID();
    const receivedA: AiTaskEvent[] = [];
    const receivedB: AiTaskEvent[] = [];
    const listenerA = (e: AiTaskEvent): void => { receivedA.push(e); };
    const listenerB = (e: AiTaskEvent): void => { receivedB.push(e); };
    bus.subscribe(taskA, listenerA);
    bus.subscribe(taskB, listenerB);
    const event = { id: randomUUID(), task_id: taskA, event_seq: 1, type: 'progress' as const, payload: { pct: 50 }, created_at: new Date().toISOString() };
    bus.publish(taskA, event);
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
    bus.unsubscribe(taskA, listenerA);
    bus.publish(taskA, event);
    expect(receivedA).toHaveLength(1);
  });
});

describe('AiTaskSseService.handleEvents', () => {
  it('pushes snapshot on connect (status + event_seq + result)', async () => {
    const task = await createTask();
    const { res, chunks } = makeResponse();
    const { req } = makeRequest();
    await sse.handleEvents({ authorId: fixture.authorId, workId: fixture.workId, taskId: task.id, request: req, response: res });
    const frames = parseFrames(chunks);
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe('snapshot');
    expect((frames[0]!.data.payload as Record<string, unknown>).status).toBe('queued');
    expect(frames[0]!.data.event_seq).toBe(task.event_seq);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
  });

  it('backfills missed events after since (Last-Event-ID / query param), ordered by event_seq', async () => {
    const task = await createTask();
    // 任务创建时已写 queued(seq=1)；补取目标是从客户端游标之后的遗漏事件
    await insertEvent(task.id, task.event_seq + 1, 'running', { tool: 'continue' });
    await insertEvent(task.id, task.event_seq + 2, 'progress', { pct: 50 });
    await insertEvent(task.id, task.event_seq + 3, 'succeeded', { revision_set_id: null });
    const { res, chunks } = makeResponse();
    const { req } = makeRequest();
    // 客户端已收到 queued(seq=1)，since=1 → 应补取 seq 2、3、4
    await sse.handleEvents({ authorId: fixture.authorId, workId: fixture.workId, taskId: task.id, request: req, response: res, since: task.event_seq });
    const frames = parseFrames(chunks);
    const types = frames.map((f) => f.type);
    expect(types).toEqual(['snapshot', 'running', 'progress', 'succeeded']);
    // 事件序号不丢序
    const seqs = frames.map((f) => Number(f.id));
    expect(seqs).toEqual([task.event_seq, task.event_seq + 1, task.event_seq + 2, task.event_seq + 3]);
    expect((frames[2]!.data.payload as Record<string, unknown>).pct).toBe(50);
  });

  it('respects Last-Event-ID header over query param since', async () => {
    const task = await createTask();
    await insertEvent(task.id, task.event_seq + 1, 'running', {});
    await insertEvent(task.id, task.event_seq + 2, 'progress', { pct: 10 });
    const { res, chunks } = makeResponse();
    const { req } = makeRequest();
    await sse.handleEvents({ authorId: fixture.authorId, workId: fixture.workId, taskId: task.id, request: req, response: res, lastEventId: String(task.event_seq + 2), since: 0 });
    const frames = parseFrames(chunks);
    // 客户端游标 = seq(queued)+2 → 只补 seq>游标，无遗漏
    expect(frames.map((f) => f.type)).toEqual(['snapshot']);
  });

  it('forwards real-time events published after connect (via bus)', async () => {
    const task = await createTask();
    const { res, chunks } = makeResponse();
    const { req } = makeRequest();
    await sse.handleEvents({ authorId: fixture.authorId, workId: fixture.workId, taskId: task.id, request: req, response: res });
    // 连接后，模拟 appendEvent 广播一个 progress 事件
    const evt: AiTaskEvent = {
      id: randomUUID(), task_id: task.id, event_seq: task.event_seq + 1,
      type: 'progress', payload: { pct: 40 }, created_at: new Date().toISOString()
    };
    bus.publish(task.id, evt);
    const frames = parseFrames(chunks);
    expect(frames.map((f) => f.type)).toEqual(['snapshot', 'progress']);
    expect((frames[1]!.data.payload as Record<string, unknown>).pct).toBe(40);
  });

  it('cleans up subscription and heartbeat on disconnect (no further forwarding)', async () => {
    const task = await createTask();
    const { res, chunks } = makeResponse();
    const { req, triggerClose } = makeRequest();
    await sse.handleEvents({ authorId: fixture.authorId, workId: fixture.workId, taskId: task.id, request: req, response: res });
    triggerClose(); // 断开
    bus.publish(task.id, {
      id: randomUUID(), task_id: task.id, event_seq: task.event_seq + 1,
      type: 'progress', payload: { pct: 80 }, created_at: new Date().toISOString()
    });
    const frames = parseFrames(chunks);
    // 断开后不再收到新事件
    expect(frames.map((f) => f.type)).toEqual(['snapshot']);
  });

  it('rejects with 404 when the task is not owned by the author', async () => {
    const task = await createTask();
    const { res } = makeResponse();
    const { req } = makeRequest();
    await expect(sse.handleEvents({ authorId: fixture.otherAuthorId, workId: fixture.workId, taskId: task.id, request: req, response: res }))
      .rejects.toThrow(/not found/i);
  });

  it('streams plot tasks without a chapter (chapter_id = null)', async () => {
    const task = await createPlotTask();
    const { res, chunks } = makeResponse();
    const { req } = makeRequest();
    await sse.handleEvents({ authorId: fixture.authorId, workId: fixture.workId, taskId: task.id, request: req, response: res });
    const frames = parseFrames(chunks);
    expect(frames.map((f) => f.type)).toEqual(['snapshot']);
    expect((frames[0]!.data.payload as Record<string, unknown>).tool).toBe('plot_derivation');
  });

  it('rejects plot tasks owned by another author', async () => {
    const task = await createPlotTask();
    const { res } = makeResponse();
    const { req } = makeRequest();
    await expect(sse.handleEvents({ authorId: fixture.otherAuthorId, workId: fixture.workId, taskId: task.id, request: req, response: res }))
      .rejects.toThrow(/not found/i);
  });
});
