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
