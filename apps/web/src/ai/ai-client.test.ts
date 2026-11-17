import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeTaskEvents } from './ai-client';

type Handler = (event: { data: string; lastEventId: string | null }) => void;

/** 原生 EventSource 的可控替身：记录实例、支持按类型触发帧 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: Handler | null = null;
  private handlers = new Map<string, Handler>();
  closed = false;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  close(): void {
    this.closed = true;
  }

  /** 触发一帧：具名类型走 addEventListener，普通消息走 onmessage */
  emit(type: string, data: string, lastEventId: string | null): void {
    const handler = type === 'message' ? this.onmessage : this.handlers.get(type);
    handler?.({ data, lastEventId });
  }
}

const now = new Date().toISOString();

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeTaskEvents', () => {
  it('connects with credentials to the SSE endpoint and reports open/closed state', () => {
    const onStateChange = vi.fn();
    const stream = subscribeTaskEvents('work-1', 'task-1', { onEvent: vi.fn(), onStateChange });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/v1/works/work-1/ai-tasks/task-1/events');
    expect(source.withCredentials).toBe(true);
    expect(stream.getState()).toBe('connecting');

    source.onopen?.();
    expect(stream.getState()).toBe('open');
    expect(onStateChange).toHaveBeenLastCalledWith('open');

    stream.close();
    expect(source.closed).toBe(true);
    expect(stream.getState()).toBe('closed');
  });

  it('normalizes a plain event frame to { seq, type, payload }', () => {
    const onEvent = vi.fn();
    subscribeTaskEvents('work-1', 'task-1', { onEvent });

    const source = FakeEventSource.instances[0]!;
    source.emit('progress', JSON.stringify({
      id: 'e-1', task_id: 'task-1', event_seq: 3, type: 'progress',
      payload: { progress: 42, stage: '改写中' }, created_at: now
    }), '3');

    expect(onEvent).toHaveBeenCalledWith({ seq: 3, type: 'progress', payload: { progress: 42, stage: '改写中' } });
  });

  it('falls back to payload event_seq when the frame id is not numeric (snapshot frame)', () => {
    const onEvent = vi.fn();
    subscribeTaskEvents('work-1', 'task-1', { onEvent });

    const source = FakeEventSource.instances[0]!;
    // snapshot 帧 id 为 "snapshot-<taskId>" 字符串，payload 携带 event_seq
    source.emit('snapshot', JSON.stringify({
      seq: 5, payload: { status: 'running', event_seq: 5 }
    }), 'snapshot-task-1');

    expect(onEvent).toHaveBeenCalledWith({ seq: 5, type: 'snapshot', payload: { status: 'running', event_seq: 5 } });
  });

  it('treats an empty id as seq 0 and routes named event types through addEventListener', () => {
    const onEvent = vi.fn();
    subscribeTaskEvents('work-1', 'task-1', { onEvent });

    const source = FakeEventSource.instances[0]!;
    source.emit('succeeded', JSON.stringify({ payload: {} }), '');

    expect(onEvent).toHaveBeenCalledWith({ seq: 0, type: 'succeeded', payload: {} });
  });

  it('invokes onError and stays connecting when the transport errors', () => {
    const onStateChange = vi.fn();
    subscribeTaskEvents('work-1', 'task-1', { onEvent: vi.fn(), onStateChange });

    const source = FakeEventSource.instances[0]!;
    source.onopen?.();
    source.onerror?.();
    expect(streamStateAfterError(onStateChange)).toBe('connecting');
  });

  it('ignores malformed JSON frames without throwing', () => {
    const onEvent = vi.fn();
    subscribeTaskEvents('work-1', 'task-1', { onEvent });

    const source = FakeEventSource.instances[0]!;
    expect(() => source.emit('progress', 'not-json', '1')).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });
});

/** 从 onStateChange 调用序列提取最后一次状态 */
function streamStateAfterError(onStateChange: ReturnType<typeof vi.fn>): string | undefined {
  const calls = onStateChange.mock.calls.map((call) => call[0]);
  return calls[calls.length - 1];
}
