import { describe, expect, it } from 'vitest';
import {
  aiTaskSchema,
  aiTaskEventSchema,
  createAiTaskRequestSchema,
  listAiTasksQuerySchema,
  listAiTaskEventsQuerySchema,
  aiTaskStatusSchema,
  aiTaskEventTypeSchema
} from './ai-task';

const baseTask = {
  id: crypto.randomUUID(),
  work_id: crypto.randomUUID(),
  chapter_id: crypto.randomUUID(),
  scope: 'chapter',
  tool: 'continue',
  agent_id: null,
  input_summary: { selection: '第 3 段' },
  base_version: 2,
  status: 'queued',
  event_seq: 0,
  result_revision_set_id: null,
  error: null,
  attempts: 0,
  created_by: crypto.randomUUID(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

describe('ai-task contracts', () => {
  it('accepts a valid queued task and rejects unknown status / negative version', () => {
    expect(aiTaskSchema.parse(baseTask).status).toBe('queued');
    expect(aiTaskSchema.safeParse({ ...baseTask, status: 'bogus' }).success).toBe(false);
    expect(aiTaskSchema.safeParse({ ...baseTask, base_version: -1 }).success).toBe(false);
  });

  it('accepts a succeeded task with result revision set and stale error payload', () => {
    const revisionSetId = crypto.randomUUID();
    const task = aiTaskSchema.parse({ ...baseTask, status: 'succeeded', result_revision_set_id: revisionSetId });
    expect(task.result_revision_set_id).toBe(revisionSetId);
    const failed = aiTaskSchema.parse({
      ...baseTask,
      status: 'failed',
      error: { code: 'MODEL_TIMEOUT', message: '上游超时' }
    });
    expect(failed.error?.code).toBe('MODEL_TIMEOUT');
  });

  it('rejects invalid event type / snapshot is transport-only in event', () => {
    const event = {
      id: crypto.randomUUID(),
      task_id: baseTask.id,
      event_seq: 1,
      type: 'progress',
      payload: { progress: 50, stage: 'generating' },
      created_at: new Date().toISOString()
    };
    expect(aiTaskEventSchema.parse(event).type).toBe('progress');
    // snapshot 是 SSE 传输层包装，不属于 ai_task_events 持久化类型
    expect(aiTaskEventSchema.safeParse({ ...event, type: 'snapshot' }).success).toBe(false);
  });

  it('enforces status/event enum whitelists', () => {
    expect(aiTaskStatusSchema.safeParse('cancelled').success).toBe(true);
    expect(aiTaskStatusSchema.safeParse('done').success).toBe(false);
    expect(aiTaskEventTypeSchema.safeParse('snapshot').success).toBe(true);
    expect(aiTaskEventTypeSchema.safeParse('heartbeat').success).toBe(false);
  });

  it('supports plot scope with null chapter_id and rejects unknown scope', () => {
    const plot = aiTaskSchema.parse({ ...baseTask, chapter_id: null, scope: 'plot' });
    expect(plot.chapter_id).toBeNull();
    expect(plot.scope).toBe('plot');
    expect(aiTaskSchema.safeParse({ ...baseTask, scope: 'bogus' }).success).toBe(false);
  });

  it('validates create request: tool + idempotency_key, defaults input_summary', () => {
    const req = createAiTaskRequestSchema.parse({ tool: 'rewrite', idempotency_key: 'k-1' });
    expect(req.input_summary).toEqual({});
    expect(createAiTaskRequestSchema.safeParse({ tool: '', idempotency_key: 'k-1' }).success).toBe(false);
    expect(createAiTaskRequestSchema.safeParse({ tool: 'continue', idempotency_key: '' }).success).toBe(false);
  });

  it('parses list/event query params with coercion and bounds', () => {
    expect(listAiTasksQuerySchema.parse({ status: 'running', page: '2', page_size: '50' }).page).toBe(2);
    expect(listAiTasksQuerySchema.safeParse({ page_size: 999 }).success).toBe(false);
    expect(listAiTaskEventsQuerySchema.parse({ since: '7' }).since).toBe(7);
  });
});
