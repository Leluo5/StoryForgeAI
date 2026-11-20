import { Injectable } from '@nestjs/common';
import type { ProseMirrorNode } from '@storyforge/contracts';

/**
 * 模型 Provider 输入：基准章节 + 任务上下文（工具 + 输入摘要）。
 * M3a 仅需要生成候选输出所需的最小上下文；M3b 接入 Coze 时扩展。
 */
export interface AiModelContext {
  workId: string;
  chapterId: string;
  tool: string;
  inputSummary: Record<string, unknown>;
  /** 基准章节文档（候选输出据此 diff） */
  baseDocument: ProseMirrorNode;
  /** 基准章节版本 */
  baseVersion: number;
}

/**
 * 模型 Provider 输出：候选文档（AI 建议的章节新状态）。
 * 服务端将 baseDocument → candidateDocument 的差异转成 M2 修订集操作集。
 */
export interface AiModelCandidate {
  candidateDocument: ProseMirrorNode;
}

/** 模型调用错误（可重试标记，供 BullMQ 退避决策） */
export class AiModelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string
  ) {
    super(message);
    this.name = 'AiModelError';
  }
}

/**
 * 可插拔模型 Provider 接口。
 * M3a 用 Mock 打通闭环；M3b 接入 Coze（实现本接口），不阻塞本里程碑。
 */
export interface AiModelProvider {
  /** 生成候选输出（成功返回候选文档；失败抛 AiModelError） */
  generate(context: AiModelContext): Promise<AiModelCandidate>;
}

export const AI_MODEL_PROVIDER = Symbol('AI_MODEL_PROVIDER');

/**
 * Mock 模型 Provider：固定候选输出 + 可配置延迟/失败，保证测试确定性。
 * - 默认返回 baseDocument 原样（无操作）；可通过静态配置注入候选/失败。
 * - 供单元测试与本地开发打通闭环；生产环境 M3a 阶段默认使用。
 */
@Injectable()
export class MockAiModelProvider implements AiModelProvider {
  /** 可配置：模拟延迟（ms） */
  private readonly latencyMs: number;
  /** 可配置：是否模拟失败（抛 AiModelError retryable） */
  private readonly fail: boolean;
  /** 可配置：固定候选输出覆盖（默认在 baseDocument 末尾追加一段） */
  private readonly candidateOverride: ProseMirrorNode | null;

  constructor(options?: { latencyMs?: number; fail?: boolean; candidate?: ProseMirrorNode }) {
    this.latencyMs = options?.latencyMs ?? 0;
    this.fail = options?.fail ?? false;
    this.candidateOverride = options?.candidate ?? null;
  }

  async generate(context: AiModelContext): Promise<AiModelCandidate> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    if (this.fail) {
      throw new AiModelError('Mock model simulated failure', true, 'MOCK_FAIL');
    }
    const candidateDocument = this.candidateOverride ?? this.defaultCandidate(context.baseDocument);
    return { candidateDocument };
  }

  /** 默认候选：在 baseDocument 末尾追加一段续写（Mock 工具 continue 的确定性输出） */
  private defaultCandidate(baseDocument: ProseMirrorNode): ProseMirrorNode {
    const paragraph: ProseMirrorNode = {
      type: 'paragraph',
      content: [{ type: 'text', text: '（Mock AI 续写内容）' }]
    };
    return {
      ...baseDocument,
      content: [...(baseDocument.content ?? []), paragraph]
    };
  }
}
