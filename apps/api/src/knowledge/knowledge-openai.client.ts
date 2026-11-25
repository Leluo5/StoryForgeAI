// M3c-3 知识库 T14 真实模型接入 · OpenAI 兼容客户端（LLM + 嵌入共同底座）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5（向量 1024 维）
// 行为：/v1/chat/completions（LLM）+ /v1/embeddings（嵌入，dimensions=1024 对齐 vector(1024)）。
// 凭据由调用方注入（真实 LLM Provider 从 site_config.llm_config 读取），本客户端不感知作者上下文。
// 设计：与 Coze 通道并列（知识库独立 HTTP 客户端，不复用 Agent 通道语义）。

/** 知识库真实模型客户端凭据（来自作者 site_config.llm_config，OpenAI 兼容协议） */
export interface KnowledgeOpenAiCredentials {
  /** 服务地址，如 https://api.openai.com/v1 或自建兼容网关（含 /v1 前缀） */
  baseUrl: string;
  apiKey: string;
  /** 对话模型名，如 gpt-4o-mini / deepseek-chat */
  model: string;
  /** 嵌入模型名，如 text-embedding-3-small（默认取 model 之外的嵌入模型） */
  embedModel?: string;
  /** 嵌入维度，默认 1024（对齐知识库 vector(1024)） */
  embedDimensions?: number;
  /** 请求超时（毫秒），默认 120_000 */
  timeoutMs?: number;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  error?: { message?: string };
}

/** 知识库真实模型调用错误（凭据缺失 / 网络 / 非 2xx） */
export class KnowledgeModelError extends Error {
  constructor(message: string, readonly code: 'NOT_CONFIGURED' | 'UPSTREAM' | 'PARSE') {
    super(message);
    this.name = 'KnowledgeModelError';
  }
}

/**
 * OpenAI 兼容客户端：chat + embeddings。
 * 纯函数式封装（无 Nest 装饰器），供真实 LLM Provider 与真实嵌入 Provider 复用；
 * 便于单测注入替身凭据与 fetch。
 */
export class KnowledgeOpenAiClient {
  constructor(
    private readonly creds: KnowledgeOpenAiCredentials,
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (!creds.baseUrl || !creds.apiKey || !creds.model) {
      throw new KnowledgeModelError(
        'OpenAI 兼容凭据缺失（baseUrl/apiKey/model）',
        'NOT_CONFIGURED'
      );
    }
  }

  private base(): string {
    // 允许传入带 /v1 或不带；统一补全 /v1，避免双前缀
    const b = this.creds.baseUrl.replace(/\/+$/, '');
    return b.endsWith('/v1') ? b : `${b}/v1`;
  }

  private async request<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetcher(`${this.base()}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.creds.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new KnowledgeModelError(
          `OpenAI 兼容上游 ${res.status}：${text.slice(0, 300)}`,
          'UPSTREAM'
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof KnowledgeModelError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new KnowledgeModelError(`OpenAI 兼容请求失败：${message}`, 'UPSTREAM');
    } finally {
      clearTimeout(timer);
    }
  }

  /** LLM 对话：system + user → 文本 */
  async chat(input: { system: string; user: string; temperature?: number; maxTokens?: number }): Promise<string> {
    const timeoutMs = this.creds.timeoutMs ?? 120_000;
    const res = await this.request<ChatCompletionsResponse>(
      '/chat/completions',
      {
        model: this.creds.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user }
        ],
        temperature: input.temperature ?? 0.3,
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {})
      },
      timeoutMs
    );
    const content = res.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new KnowledgeModelError(
        `OpenAI 兼容对话无内容：${res.error?.message ?? '空响应'}`,
        'PARSE'
      );
    }
    return content;
  }

  /** 嵌入：文本数组 → 向量数组（dimensions 对齐知识库 1024） */
  async embed(texts: string[]): Promise<number[][]> {
    const timeoutMs = this.creds.timeoutMs ?? 120_000;
    const res = await this.request<EmbeddingsResponse>(
      '/embeddings',
      {
        model: this.creds.embedModel ?? this.creds.model,
        input: texts,
        ...(this.creds.embedDimensions ? { dimensions: this.creds.embedDimensions } : {})
      },
      timeoutMs
    );
    if (!Array.isArray(res.data) || res.data.length !== texts.length) {
      throw new KnowledgeModelError(
        `OpenAI 兼容嵌入返回数不符（${res.data?.length ?? 0}/${texts.length}）：${res.error?.message ?? ''}`,
        'PARSE'
      );
    }
    // 按 index 排序，返回与输入同序的向量
    const sorted = [...res.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => d.embedding ?? []);
  }
}
