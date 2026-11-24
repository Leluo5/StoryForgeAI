import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AgentChannel, AgentChannelRequest, AgentChannelResult } from '@storyforge/contracts';
import { env as defaultEnv } from '../../config/env';
import { SiteConfigService } from '../../site-config/site-config.service';
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
    // v3 返回 id 作为 chat_id
    id?: string;
    chat_id?: string;
    conversation_id?: string;
  };
}

interface CozeRetrieveResponse {
  code?: number;
  msg?: string;
  data?: {
    status?: string;
  };
}

interface CozeMessageListResponse {
  code?: number;
  msg?: string;
  data?: Array<{
    role?: string;
    type?: string;
    content?: string;
    content_type?: string;
  }>;
}

// F11 Coze 适配器（F2 §5.1）：
//   POST {COZE_API_BASE}/v3/chat 发起 → 轮询 GET /v3/chat/retrieve → completed 后
//   GET /v3/chat/message/list 取 assistant answer 文本。
// 说明（真实链路校准）：Coze v3 的 retrieve 为 GET + query 参数且不返回消息体；
// 消息需单独调 message/list。路径前缀是 /v3 而非 /open_api/v3。
// JSON 输出交给统一结果校验器（T13）。Coze 与 Flowise 并存，可回退。
@Injectable()
export class CozeChannel implements AgentChannel {
  readonly name = 'coze' as const;
  private static readonly POLL_INTERVAL_MS = 1_000;

  constructor(
    @Optional() private readonly envProvider: CozeChannelEnv = defaultEnv,
    @Inject(SiteConfigService) private readonly siteConfig?: SiteConfigService
  ) {}

  async invoke(request: AgentChannelRequest): Promise<AgentChannelResult> {
    // 作者级接管：优先从 site_config 平台凭据读，未命中回退 envProvider（env 兜底）
    const credentials = await this.siteConfig?.getPlatformCredentials(request.author_id) ?? {};
    const cozeCreds = credentials.coze ?? {};
    const env = this.envProvider;
    const COZE_API_BASE = cozeCreds.base_url ?? env.COZE_API_BASE;
    const COZE_PAT = cozeCreds.pat ?? env.COZE_PAT;
    // COZE_BOT_ID 保留 env 兜底（站点设置未纳入 Bot 标识）
    const COZE_BOT_ID = env.COZE_BOT_ID;
    const COLLAB_HTTP_TIMEOUT_MS = env.COLLAB_HTTP_TIMEOUT_MS ?? 120_000;
    if (!COZE_API_BASE || !COZE_PAT || !COZE_BOT_ID) {
      throw new CollabUpstreamError('Coze 通道未配置', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
    }

    const base = COZE_API_BASE.replace(/\/+$/, '');
    const startedAt = Date.now();
    const deadline = Date.now() + COLLAB_HTTP_TIMEOUT_MS;

    // 1) 发起对话
    // 注意：auto_save_history=false 时 Coze 强制要求 stream=true，这里不传该字段以保持同步轮询。
    const chat = await this.post<CozeChatResponse>(
      `${base}/v3/chat`,
      {
        bot_id: COZE_BOT_ID,
        user_id: `storyforge-${request.workId}`,
        stream: false,
        additional_messages: [
          {
            role: 'user',
            content: JSON.stringify({
              instruction: request.instruction,
              workId: request.workId,
              roleContext: request.roleContext,
              citations: request.citations,
              outputFields: request.outputFields,
              // 把结果契约一并告知 Bot：仅靠 instruction 无法约束 Bot 的输出结构与长度
              outputContract: {
                format:
                  '只输出一个 JSON 对象，顶层仅允许 fields（可选 notes）；fields 的键必须与 outputFields 完全一致，禁止翻译或增减',
                maxChars: { identity: 80, personality: 2000, experience: 20000 }
              }
            }),
            content_type: 'text'
          }
        ]
      },
      COZE_PAT,
      deadline
    );

    const chatId = chat.data?.id ?? chat.data?.chat_id;
    const conversationId = chat.data?.conversation_id;
    if (!chatId || !conversationId) {
      throw upstreamFailedError('Coze 未返回 chat_id');
    }

    const query = `conversation_id=${encodeURIComponent(conversationId)}&chat_id=${encodeURIComponent(chatId)}`;

    // 2) 轮询检索状态（GET + query）
    while (Date.now() < deadline) {
      const retrieved = await this.get<CozeRetrieveResponse>(
        `${base}/v3/chat/retrieve?${query}`,
        COZE_PAT,
        deadline
      );

      if (retrieved.code !== 0) {
        throw upstreamFailedError(`Coze 检索失败: ${retrieved.msg ?? '未知'}`);
      }
      const status = retrieved.data?.status;

      if (status === 'completed') {
        const text = await this.fetchAnswer(base, query, COZE_PAT, deadline);
        return { rawText: text, model: 'coze', latencyMs: Date.now() - startedAt };
      }
      if (status === 'failed' || status === 'error') {
        throw upstreamFailedError('Coze 任务失败');
      }
      if (status === 'requires_action') {
        throw upstreamFailedError('Coze 需要额外动作，暂不支持');
      }

      // 尚未完成：等待后继续轮询
      await this.sleep(CozeChannel.POLL_INTERVAL_MS);
    }

    throw timeoutError(`Coze 请求超时 ${COLLAB_HTTP_TIMEOUT_MS}ms`);
  }

  /** completed 后取消息列表中的 assistant answer 文本（多个 answer 拼接） */
  private async fetchAnswer(base: string, query: string, pat: string, deadline: number): Promise<string> {
    const listed = await this.get<CozeMessageListResponse>(
      `${base}/v3/chat/message/list?${query}`,
      pat,
      deadline
    );
    if (listed.code !== 0) {
      throw upstreamFailedError(`Coze 消息列表失败: ${listed.msg ?? '未知'}`);
    }
    const answer = (listed.data ?? [])
      .filter((m) => m.role === 'assistant' && m.type === 'answer' && typeof m.content === 'string')
      .map((m) => m.content as string)
      .join('\n')
      .trim();
    if (answer === '') {
      throw upstreamFailedError('Coze 完成但无有效文本');
    }
    return answer;
  }

  private async get<T>(url: string, pat: string, deadline: number): Promise<T> {
    return this.request<T>(url, { method: 'GET', headers: { Authorization: `Bearer ${pat}` } }, deadline);
  }

  private async post<T>(url: string, body: unknown, pat: string, deadline: number): Promise<T> {
    return this.request<T>(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      deadline
    );
  }

  private async request<T>(url: string, init: RequestInit, deadline: number): Promise<T> {
    const controller = new AbortController();
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
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
