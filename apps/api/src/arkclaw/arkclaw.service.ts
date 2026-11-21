import { randomUUID } from 'node:crypto';
import { BadGatewayException, GatewayTimeoutException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ArkClawChatResponse } from '@storyforge/contracts';
import { z } from 'zod';

const a2aTaskResponseSchema = z.object({
  result: z.object({
    kind: z.literal('task'),
    status: z.object({
      state: z.literal('completed'),
      message: z.object({
        parts: z.array(z.object({ kind: z.string(), text: z.string().optional() }).passthrough())
      }).passthrough()
    }).passthrough()
  }).passthrough(),
  error: z.never().optional()
}).passthrough();

@Injectable()
export class ArkClawService {
  constructor(
    private readonly endpoint: string | undefined,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 120_000
  ) {}

  async chat(message: string): Promise<ArkClawChatResponse> {
    if (!this.endpoint) throw new ServiceUnavailableException('ArkClaw 服务尚未配置');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: randomUUID(),
            method: 'message/send',
            params: {
              message: {
                parts: [{ kind: 'text', text: message }],
                messageId: randomUUID(),
                role: 'user'
              }
            }
          }),
          signal: controller.signal
        });
      } catch {
        if (controller.signal.aborted) throw new GatewayTimeoutException('ArkClaw 调用超时，请稍后手动重试');
        throw new BadGatewayException('ArkClaw 连接失败，请稍后手动重试');
      }

      if (!response.ok) throw new BadGatewayException('ArkClaw 调用失败');

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw new GatewayTimeoutException('ArkClaw 调用超时，请稍后手动重试');
        throw new BadGatewayException('ArkClaw 返回了无效响应');
      }

      const parsed = a2aTaskResponseSchema.safeParse(payload);
      if (!parsed.success) throw new BadGatewayException('ArkClaw 返回了无效响应');
      const answer = parsed.data.result.status.message.parts
        .filter((part) => part.kind === 'text')
        .map((part) => part.text ?? '')
        .join('');
      if (!answer.trim()) throw new BadGatewayException('ArkClaw 返回了无效响应');
      return { answer };
    } finally {
      clearTimeout(timeout);
    }
  }
}
