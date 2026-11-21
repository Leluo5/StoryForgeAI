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
    const fetchMock = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = capture(new ArkClawService(endpoint, fetchMock, 1000).chat('问题'));
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;
    expect(error.getStatus()).toBe(504);
    expect(error.message).toBe('ArkClaw 调用超时，请稍后手动重试');
  });
});
