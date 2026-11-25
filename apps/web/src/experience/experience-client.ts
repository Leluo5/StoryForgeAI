import type {
  ChatExperienceEvent,
  ListPublicWorksResponse,
  PublicWork,
  VerifyWorkAccessRequest,
  VerifyWorkAccessResponse
} from '@storyforge/contracts';
import {
  chatExperienceEventSchema,
  listPublicWorksResponseSchema,
  publicWorkSchema,
  verifyWorkAccessResponseSchema
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

export function listPublicWorks(): Promise<ListPublicWorksResponse> {
  return apiRequest('/api/v1/experience/works', listPublicWorksResponseSchema);
}

export function getPublicWork(workId: string): Promise<PublicWork> {
  return apiRequest(`/api/v1/experience/works/${workId}`, publicWorkSchema);
}

export function verifyWorkAccess(workId: string, input: VerifyWorkAccessRequest): Promise<VerifyWorkAccessResponse> {
  return apiRequest(`/api/v1/experience/works/${workId}/verify`, verifyWorkAccessResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

/**
 * SSE 流式聊天：手动 fetch 读 text/event-stream，逐帧解析为统一契约事件回调。
 * 访问码作品需传 accessToken（verify 颁发）。
 */
export async function chatStream(
  workId: string,
  input: { user_id: string; conversation_id: string | null; message: string },
  accessToken: string | null,
  onEvent: (event: ChatExperienceEvent) => void
): Promise<void> {
  const response = await fetch(`/api/v1/experience/works/${workId}/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { 'x-access-token': accessToken } : {})
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    let message = '对话请求失败';
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      message = json.error?.message ?? message;
    } catch { /* 保持默认 */ }
    onEvent({ type: 'error', message });
    return;
  }
  if (!response.body) {
    onEvent({ type: 'error', message: '无响应流' });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let eventName = '';
      let dataStr = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      const parsed = chatExperienceEventSchema.safeParse({ ...JSON.parse(dataStr), type: eventName });
      if (parsed.success) onEvent(parsed.data);
    }
  }
}
