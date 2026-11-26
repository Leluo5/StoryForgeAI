import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AiTask } from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { WorkflowEntity } from '../database/workflow.entity';
import { AiTaskService } from '../ai/ai-task.service';

/**
 * 工作流运行服务（M4-T7）。
 * 职责：作者归属校验 → 状态校验 → 创建 ai-task（scope='workflow_run'）→ 入队。
 * 归属语义：ai_workflows 为作者级（作者隔离），任务归属以 ai_workflows.author_id 为准；
 * 工作流绑定作品时任务携带 work_id，否则为空（ai_tasks.work_id 已放开 NOT NULL）。
 */
@Injectable()
export class WorkflowRunService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AiTaskService) private readonly aiTaskService: AiTaskService
  ) {}

  /** 发起一次工作流运行，返回 aiTaskId（运行进度经 ai-task SSE / 进度查询获取）。 */
  async runWorkflow(authorId: string, workflowId: string): Promise<{ aiTaskId: string }> {
    const workflow = await this.assertOwnedWorkflow(authorId, workflowId);
    if (workflow.status !== 'active') {
      throw new ConflictException('工作流已归档，不可运行');
    }
    const platformConfig = workflow.platform_config ?? {};
    if (typeof platformConfig.workflow_id !== 'string' || platformConfig.workflow_id.trim() === '') {
      throw new ConflictException('工作流未配置上游 workflow_id，不可运行');
    }
    const { task } = await this.aiTaskService.createWorkflowRunTask(authorId, {
      workflowId: workflow.id,
      workId: workflow.work_id,
      platform: workflow.platform,
      platformConfig,
      idempotencyKey: `workflow-run:${workflow.id}:${Date.now()}`
    });
    return { aiTaskId: task.id };
  }

  /** 查询某次运行的任务状态（工作流归属 + 任务作用域双重校验）。 */
  async getRunStatus(authorId: string, workflowId: string, aiTaskId: string): Promise<AiTask> {
    const workflow = await this.assertOwnedWorkflow(authorId, workflowId);
    const { task } = await this.aiTaskService.getWorkflowRunTask(aiTaskId);
    if (task.input_summary?.workflow_id !== workflow.id) {
      throw new NotFoundException('工作流运行任务不存在');
    }
    return task;
  }

  /** 归属校验（作者隔离；工作流状态变更已由 WorkflowService 事务内串行化，此处无需锁）。 */
  private async assertOwnedWorkflow(authorId: string, workflowId: string): Promise<WorkflowEntity> {
    const workflow = await this.dataSource.getRepository(WorkflowEntity).findOneBy({
      id: workflowId,
      author_id: authorId
    });
    if (!workflow) throw new NotFoundException('工作流不存在');
    return workflow;
  }
}
