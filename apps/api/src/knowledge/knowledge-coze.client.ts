// M3c-3 知识库 T14 真实模型接入 · Coze 知识库 LLM 客户端
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5 + F2 §5.1（Coze v3 链路校准）
// 行为：POST {base}/v3/chat 发起（additional_messages 单条 user，内容为知识库提示词+原文）
//       → 轮询 GET /v3/chat/retrieve → completed 后 GET /v3/chat/message/list 取 assistant answer 文本。
// 与 Agent 通道（coze.channel.ts）的差异：知识库语义（system 提示词 + rawContent 原文），
// 不复用 Agent 指令结构（instruction/roleContext/outputFields）。独立 HTTP 客户端，便于单测。
import { KnowledgeModelError } from './knowledge-openai.client';

/** 知识库 Coze 凭据（来自作者 site_config.platform_credentials.coze，bot_id 走 env 兜底） */
export interface KnowledgeCozeCredentials {
  baseUrl: string;
  pat: string;
  botId: string;
  timeoutMs?: number;
}

interface CozeChatResponse {
  code?: number;
  msg?: string;
  data?: { id?: string; chat_id?: string; conversation_id?: string };
}

interface CozeRetrieveResponse {
  code?: number;
  msg?: string;
  data?: { status?: string };
}

interface CozeMessageListResponse {
  code?: number;
  msg?: string;
  /** Coze v3 message/list：data 为对象，内含 messages 数组 */
  data?: {
    messages?: Array<{ role?: string; type?: string; content?: string; content_type?: string }>;
  };
}

/** Coze 知识库对话：system（提示词）+ user（原文 JSON）→ assistant answer 文本 */
export class KnowledgeCozeClient {
  private static readonly POLL_INTERVAL_MS = 1_000;

  constructor(
    private readonly creds: KnowledgeCozeCredentials,
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (!creds.baseUrl || !creds.pat || !creds.botId) {
      throw new KnowledgeModelError('Coze 凭据缺失（baseUrl/pat/botId）', 'NOT_CONFIGURED');
    }
  }

  private base(): string {
    return this.creds.baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetcher(`${this.base()}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.creds.pat}`
        },
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new KnowledgeModelError(`Coze 上游 ${res.status}：${text.slice(0, 300)}`, 'UPSTREAM');
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof KnowledgeModelError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new KnowledgeModelError(`Coze 请求失败：${message}`, 'UPSTREAM');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Coze 对话：system 提示词 + user 原文 → assistant answer 文本 */
  async chat(input: { system: string; user: string }): Promise<string> {
    const timeoutMs = this.creds.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;

    // 1) 发起对话（stream:false 保持同步轮询）
    const chat = await this.request<CozeChatResponse>(
      '/v3/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bot_id: this.creds.botId,
          user_id: 'storyforge-knowledge',
          stream: false,
          additional_messages: [
            {
              role: 'user',
              content: JSON.stringify({
                instruction: input.system,
                rawContent: input.user
              }),
              content_type: 'text'
            }
          ]
        })
      },
      timeoutMs
    );
    const chatId = chat.data?.id ?? chat.data?.chat_id;
    const conversationId = chat.data?.conversation_id;
    if (!chatId || !conversationId) {
      throw new KnowledgeModelError(`Coze 未返回 chat_id：${chat.msg ?? ''}`, 'PARSE');
    }
    const query = `conversation_id=${encodeURIComponent(conversationId)}&chat_id=${encodeURIComponent(chatId)}`;

    // 2) 轮询检索状态（GET + query）
    while (Date.now() < deadline) {
      const retrieved = await this.request<CozeRetrieveResponse>(
        `/v3/chat/retrieve?${query}`,
        { method: 'GET' },
        timeoutMs
      );
      const status = retrieved.data?.status;
      if (status === 'completed') break;
      if (status === 'failed' || status === 'error') {
        throw new KnowledgeModelError(`Coze 对话失败：${retrieved.msg ?? status}`, 'UPSTREAM');
      }
      await new Promise((resolve) => setTimeout(resolve, KnowledgeCozeClient.POLL_INTERVAL_MS));
    }

    // 3) 取 assistant answer 文本
    const messages = await this.request<CozeMessageListResponse>(
      `/v3/chat/message/list?${query}`,
      { method: 'GET' },
      timeoutMs
    );
    const answer = (messages.data?.messages ?? [])
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
      .map((m) => m.content as string)
      .join('\n');
    if (!answer.trim()) {
      throw new KnowledgeModelError(`Coze 对话无 answer 内容：${messages.msg ?? '空'}`.slice(0, 300), 'PARSE');
    }
    return answer;
  }
}
