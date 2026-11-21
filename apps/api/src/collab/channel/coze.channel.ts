import { Injectable } from '@nestjs/common';
import type { AgentChannel, AgentChannelRequest, AgentChannelResult } from '@storyforge/contracts';
import { env as defaultEnv } from '../../config/env';
import { CollabUpstreamError, timeoutError, upstreamFailedError } from './collab-upstream.error';

// Coze 通道所需环境变量子集（便于单测注入替身；显式允许 undefined）
export interface CozeChannelEnv {
  COZE_API_BASE?: string | undefined;
  COZE_PAT?: string | undefined;
  COZE_BOT_ID?: string | undefined;
  COLLAB_HTTP_TIMEOUT_MS?: number | undefined;
}

interface CozeChatResponse {
  code?: number;
  msg?: string;
  data?: {
    chat_id?: string;
    conversation_id?: string;
  };
}

interface CozeRetrieveResponse {
  code?: number;
  msg?: string;
  data?: {
    status?: string;
    messages?: Array<{
      role?: string;
      type?: string;
      content?: string;
      content_type?: string;
    }>;
  };
}

// F11 Coze 适配器（F2 §5.1）：POST {COZE_API_BASE}/open_api/v3/chat 发起，
// 按返回 chat_id 轮询 /open_api/v3/chat/retrieve 直到 completed 或超时，取消息列表文本。
// JSON 输出交给统一结果校验器（T13）。Coze 与 Flowise 并存，可回退。
@Injectable()
export class CozeChannel implements AgentChannel {
  readonly name = 'coze' as const;
  private static readonly POLL_INTERVAL_MS = 1_000;

  constructor(private readonly envProvider: CozeChannelEnv = defaultEnv) {}

  async invoke(request: AgentChannelRequest): Promise<AgentChannelResult> {
    const { COZE_API_BASE, COZE_PAT, COZE_BOT_ID, COLLAB_HTTP_TIMEOUT_MS = 120_000 } = this.envProvider;
    if (!COZE_API_BASE || !COZE_PAT || !COZE_BOT_ID) {
      throw new CollabUpstreamError('Coze 通道未配置', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
    }

    const base = COZE_API_BASE.replace(/\/+$/, '');
    const startedAt = Date.now();
    const deadline = Date.now() + COLLAB_HTTP_TIMEOUT_MS;

    // 1) 发起对话
    const chat = await this.post<CozeChatResponse>(
      `${base}/open_api/v3/chat`,
      {
        bot_id: COZE_BOT_ID,
        user_id: `storyforge-${request.workId}`,
        stream: false,
        auto_save_history: false,
        additional_messages: [
          {
            role: 'user',
            content: JSON.stringify({
              instruction: request.instruction,
              workId: request.workId,
              roleContext: request.roleContext,
              citations: request.citations,
              outputFields: request.outputFields
            }),
            content_type: 'text'
          }
        ]
      },
      COZE_PAT,
      deadline
    );

    if (!chat.data?.chat_id || !chat.data.conversation_id) {
      throw upstreamFailedError('Coze 未返回 chat_id');
    }

    // 2) 轮询检索结果
    const pollUrl = `${base}/open_api/v3/chat/retrieve`;
    let lastText = '';
    while (Date.now() < deadline) {
      const retrieved = await this.post<CozeRetrieveResponse>(
        pollUrl,
        { chat_id: chat.data.chat_id, conversation_id: chat.data.conversation_id },
        COZE_PAT,
        deadline
      );

      if (retrieved.code !== 0) {
        throw upstreamFailedError(`Coze 检索失败: ${retrieved.msg ?? '未知'}`);
      }
      const status = retrieved.data?.status;
      const messages = retrieved.data?.messages ?? [];
      const answer = messages
        .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
        .map((m) => m.content)
        .join('\n');
      if (answer.trim() !== '') lastText = answer;

      if (status === 'completed') {
        if (lastText.trim() === '') {
          throw upstreamFailedError('Coze 完成但无有效文本');
        }
        return { rawText: lastText, model: 'coze', latencyMs: Date.now() - startedAt };
      }
      if (status === 'failed' || status === 'error') {
        throw upstreamFailedError('Coze 任务失败');
      }

      // 尚未完成：等待后继续轮询
      await this.sleep(CozeChannel.POLL_INTERVAL_MS);
    }

    throw timeoutError(`Coze 请求超时 ${COLLAB_HTTP_TIMEOUT_MS}ms`);
  }

  private async post<T>(url: string, body: unknown, pat: string, deadline: number): Promise<T> {
    const controller = new AbortController();
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw upstreamFailedError(`Coze 返回 ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof CollabUpstreamError) throw error;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) throw timeoutError('Coze 请求超时');
      throw upstreamFailedError(`Coze 请求失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
