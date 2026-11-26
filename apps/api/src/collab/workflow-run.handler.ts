import { Injectable } from '@nestjs/common';
import type { CozeImportClient } from './coze-import.client';
import { upstreamFailedError } from './channel/collab-upstream.error';

// M4-T7 工作流运行处理器：读取任务 input_summary（workflow_id / platform / platform_config / parameters）
// → 解析上游工作流 ID 与运行参数 → 调 Coze POST /v1/workflow/run → 返回结构化摘要（processor 写 succeeded）。
// 归属语义：workflow_id 是本地 ai_workflows.id；上游工作流 ID 取自 platform_config.workflow_id。
// 失败语义：缺上游 ID / 上游 code!==0 均映射为 CollabUpstreamError（不可重试 → 标 failed，防死循环）。

export interface WorkflowRunTaskContext {
  taskId: string;
  authorId: string;
  workId: string | null;
  tool: string;
  inputSummary: Record<string, unknown>;
}

@Injectable()
export class WorkflowRunHandler {
  constructor(private readonly coze: CozeImportClient) {}

  async handle(ctx: WorkflowRunTaskContext): Promise<Record<string, unknown>> {
    const platformConfig =
      typeof ctx.inputSummary.platform_config === 'object' && ctx.inputSummary.platform_config !== null
        ? (ctx.inputSummary.platform_config as Record<string, unknown>)
        : {};
    const upstreamWorkflowId = platformConfig.workflow_id;
    if (typeof upstreamWorkflowId !== 'string' || upstreamWorkflowId.trim() === '') {
      throw upstreamFailedError('工作流未配置上游 workflow_id，不可运行');
    }

    const parameters =
      typeof ctx.inputSummary.parameters === 'object' && ctx.inputSummary.parameters !== null
        ? (ctx.inputSummary.parameters as Record<string, unknown>)
        : {};

    const response = await this.coze.runWorkflow(ctx.authorId, upstreamWorkflowId, parameters);

    if (typeof response.code === 'number' && response.code !== 0) {
      throw upstreamFailedError(`Coze 工作流运行失败: ${response.code} ${response.msg ?? ''}`.trim());
    }

    return {
      scope: 'workflow_run',
      channel: 'coze',
      workflow_id: ctx.inputSummary.workflow_id,
      data: response.data ?? null
    };
  }
}
