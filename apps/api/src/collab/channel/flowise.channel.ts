import { Injectable } from '@nestjs/common';
import type { AgentChannel, AgentChannelRequest, AgentChannelResult } from '@storyforge/contracts';
import { env as defaultEnv } from '../../config/env';
import { CollabUpstreamError, timeoutError, upstreamFailedError } from './collab-upstream.error';

// Flowise 通道所需环境变量子集（便于单测注入替身；显式允许 undefined）
export interface FlowiseChannelEnv {
  FLOWISE_BASE_URL?: string | undefined;
  FLOWISE_API_KEY?: string | undefined;
  COLLAB_HTTP_TIMEOUT_MS?: number | undefined;
}

// F11 Flowise 适配器（F2 §5.1）：POST {FLOWISE_BASE_URL}/api/v1/prediction/{chatflowId}
// 请求头 Bearer 凭据，响应读取 text 字段；JSON 输出交给统一结果校验器（T13）。
@Injectable()
export class FlowiseChannel implements AgentChannel {
  readonly name = 'flowise' as const;

  constructor(private readonly envProvider: FlowiseChannelEnv = defaultEnv) {}

  async invoke(request: AgentChannelRequest): Promise<AgentChannelResult> {
    const { FLOWISE_BASE_URL, FLOWISE_API_KEY, COLLAB_HTTP_TIMEOUT_MS = 120_000 } = this.envProvider;
    if (!FLOWISE_BASE_URL || !FLOWISE_API_KEY) {
      throw new CollabUpstreamError('Flowise 通道未配置', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
    }
    if (!request.chatflowId) {
      throw new CollabUpstreamError('Flowise Chatflow 标识缺失', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
    }

    const url = `${FLOWISE_BASE_URL.replace(/\/+$/, '')}/api/v1/prediction/${encodeURIComponent(request.chatflowId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COLLAB_HTTP_TIMEOUT_MS);

    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FLOWISE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          question: request.instruction,
          history: [],
          overrideConfig: {
            // 仅注入请求上下文，不传递任何凭据或敏感键
            sessionId: request.taskId,
            // Flowise 2.x 的 overrideConfig 覆盖键必须是「节点参数名」。
            // 以其它键名（如 systemMessage）发送会被 isParameterEnabled 直接跳过，
            // 导致角色上下文静默丢失（真实链路验证发现）。
            systemMessagePrompt: JSON.stringify({
              workId: request.workId,
              roleContext: request.roleContext,
              citations: request.citations,
              outputFields: request.outputFields
            })
          }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw upstreamFailedError(`Flowise 返回 ${response.status}`);
      }
      const data = (await response.json()) as { text?: unknown };
      if (typeof data.text !== 'string' || data.text.trim() === '') {
        throw upstreamFailedError('Flowise 响应缺少有效 text');
      }
      return {
        rawText: data.text,
        model: 'flowise',
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      if (error instanceof CollabUpstreamError) throw error;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) throw timeoutError(`Flowise 请求超时 ${COLLAB_HTTP_TIMEOUT_MS}ms`);
      throw upstreamFailedError(`Flowise 请求失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
