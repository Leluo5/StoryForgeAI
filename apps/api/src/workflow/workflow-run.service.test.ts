import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskEventBus } from '../ai/ai-task.sse';
import { AiTaskService, type AiTaskQueuePort } from '../ai/ai-task.service';
import { AgentService } from '../agent/agent.service';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiToolEntity } from '../database/ai-tool.entity';
import { WorkflowEntity } from '../database/workflow.entity';
import { WorkflowRunService } from './workflow-run.service';
import { WorkflowService } from './workflow.service';

let fixture: WritingFixture;
let workflowService: WorkflowService;
let runService: WorkflowRunService;
let queue: AiTaskQueuePort;
let enqueued: string[];

/** 构造合法的创建工作流入参（契约 llm_config 必填） */
function makeCreateInput(name: string, platform_config: Record<string, unknown> = {}): Parameters<WorkflowService['createWorkflow']>[1] {
  return { name, platform_config, llm_config: { model: 'gpt-4o' } };
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  enqueued = [];
  queue = {
    enqueue: vi.fn(async (taskId: string) => { enqueued.push(taskId); }),
    remove: vi.fn(async () => undefined)
  };
  const auditStub = {
    record: vi.fn(async () => ({
      id: randomUUID(),
      action: 'ai_task_create',
      target_type: 'ai_task',
      target_id: randomUUID(),
      detail: {},
      actor_id: fixture.authorId,
      created_at: new Date().toISOString()
    }))
  };
  const aiTaskService = new AiTaskService(
    fixture.dataSource,
    auditStub as never,
    queue,
    new AiTaskEventBus(),
    new AgentService(fixture.dataSource, auditStub as never, {} as never, {} as never, {} as never, {} as never)
  );
  workflowService = new WorkflowService(fixture.dataSource);
  runService = new WorkflowRunService(fixture.dataSource, aiTaskService);
});

afterEach(() => destroyWritingFixture(fixture));

describe('WorkflowRunService', () => {
  it('creates a queued workflow_run task and enqueues it', async () => {
    const wf = await workflowService.createWorkflow(fixture.authorId, makeCreateInput('运行流', { workflow_id: 'wf-upstream-001', workspace_id: 'ws-1' }));
    const { aiTaskId } = await runService.runWorkflow(fixture.authorId, wf.id);

    const task = await fixture.dataSource
      .getRepository(AiTaskEntity)
      .findOneBy({ id: aiTaskId });
    expect(task).not.toBeNull();
    expect(task!.scope).toBe('workflow_run');
    expect(task!.status).toBe('queued');
    expect(task!.work_id).toBeNull();
    expect(task!.chapter_id).toBeNull();
    expect(task!.input_summary).toEqual({
      workflow_id: wf.id,
      platform: wf.platform,
      platform_config: { workflow_id: 'wf-upstream-001', workspace_id: 'ws-1' }
    });
    expect(enqueued).toEqual([aiTaskId]);
  });

  it('binds work_id when the workflow belongs to a work', async () => {
    const wf = await workflowService.createWorkflow(fixture.authorId, makeCreateInput('作品流', { workflow_id: 'wf-work-001' }));
    // 模拟作品级工作流归属（迁移已为 ai_workflows 增加 work_id）
    await fixture.dataSource.getRepository(WorkflowEntity).update({ id: wf.id }, { work_id: fixture.workId });

    const { aiTaskId } = await runService.runWorkflow(fixture.authorId, wf.id);
    const task = await fixture.dataSource.getRepository(AiTaskEntity).findOneBy({ id: aiTaskId });
    expect(task!.work_id).toBe(fixture.workId);
  });

  it('rejects running a workflow without a platform config with 409', async () => {
    const wf = await workflowService.createWorkflow(fixture.authorId, makeCreateInput('无平台流'));
    await expect(runService.runWorkflow(fixture.authorId, wf.id))
      .rejects.toBeInstanceOf(ConflictException);
    expect(enqueued).toEqual([]);
  });

  it('persists platform_config into the run task input summary', async () => {
    const wf = await workflowService.createWorkflow(fixture.authorId, makeCreateInput('平台流', { workflow_id: 'wf-upstream-001', workspace_id: 'ws-1' }));
    const { aiTaskId } = await runService.runWorkflow(fixture.authorId, wf.id);
    const task = await fixture.dataSource.getRepository(AiTaskEntity).findOneBy({ id: aiTaskId });
    expect(task!.channel).toBe('coze');
    expect(task!.input_summary.platform_config).toEqual({
      workflow_id: 'wf-upstream-001',
      workspace_id: 'ws-1'
    });
  });

  it('rejects running a workflow owned by another author with 404', async () => {
    const wf = await workflowService.createWorkflow(fixture.authorId, makeCreateInput('私有流'));
    await expect(runService.runWorkflow(fixture.otherAuthorId, wf.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects running an archived workflow with 409', async () => {
    const wf = await workflowService.createWorkflow(fixture.authorId, makeCreateInput('归档流'));
    await workflowService.archiveWorkflow(fixture.authorId, wf.id);
    await expect(runService.runWorkflow(fixture.authorId, wf.id))
      .rejects.toBeInstanceOf(ConflictException);
    expect(enqueued).toEqual([]);
  });

  it('returns the run status for the owner and rejects cross-author read with 404', async () => {
    const wf = await workflowService.createWorkflow(fixture.authorId, makeCreateInput('状态流', { workflow_id: 'wf-status-001' }));
    const { aiTaskId } = await runService.runWorkflow(fixture.authorId, wf.id);

    const owned = await runService.getRunStatus(fixture.authorId, wf.id, aiTaskId);
    expect(owned.id).toBe(aiTaskId);
    expect(owned.scope).toBe('workflow_run');

    await expect(runService.getRunStatus(fixture.otherAuthorId, wf.id, aiTaskId))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(runService.getRunStatus(fixture.authorId, wf.id, randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
