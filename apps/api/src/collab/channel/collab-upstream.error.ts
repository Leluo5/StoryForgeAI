import type { CollabErrorCode } from '@storyforge/contracts';

// F11 通道上游错误：任务处理器据此做 BullMQ 退避决策（F2 §5.1）
// code 一律使用契约错误码，携带脱敏消息，不暴露上游原始响应
export class CollabUpstreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: CollabErrorCode
  ) {
    super(message);
    this.name = 'CollabUpstreamError';
  }
}

/** 构造超时错误（可重试） */
export function timeoutError(message: string): CollabUpstreamError {
  return new CollabUpstreamError(message, true, 'COLLAB_UPSTREAM_TIMEOUT');
}

/** 构造上游失败错误（可重试，由调用方视情况收紧） */
export function upstreamFailedError(message: string, retryable = true): CollabUpstreamError {
  return new CollabUpstreamError(message, retryable, 'COLLAB_UPSTREAM_FAILED');
}
