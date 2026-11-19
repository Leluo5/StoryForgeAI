import { Inject, Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { FlowProgressEntity, FlowStepRecord } from '../database/flow-progress.entity';
import type { FlowStepStatus } from '@storyforge/contracts';

/** 流程进度状态常量 */
export const PROGRESS_IDLE = 'idle';
export const PROGRESS_RUNNING = 'running';
export const PROGRESS_DONE = 'done';
export const PROGRESS_FAILED = 'failed';

/** 单步骤状态 */
const STEP_PENDING: FlowStepStatus = 'pending';
const STEP_RUNNING: FlowStepStatus = 'running';
const STEP_DONE: FlowStepStatus = 'done';
const STEP_FAILED: FlowStepStatus = 'failed';

/** 流程总步骤数（固定 11 步） */
const TOTAL_STEPS = 11;

function buildDefaultSteps(): FlowStepRecord[] {
  const steps: FlowStepRecord[] = [];
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    steps.push({
      step_order: i,
      status: STEP_PENDING,
      started_at: null,
      finished_at: null
    });
  }
  return steps;
}

@Injectable()
export class FlowProgressService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @InjectRepository(FlowProgressEntity)
    private readonly repo: Repository<FlowProgressEntity>
  ) {}

  /**
   * 获取角色的流程进度。不存在则懒创建初始 idle 记录。
   */
  async getProgress(projectId: string, roleId: string): Promise<FlowProgressEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FlowProgressEntity);
      let progress = await repo.findOneBy({ project_id: projectId, role_id: roleId });
      if (progress) return progress;

      progress = repo.create();
      progress.project_id = projectId;
      progress.role_id = roleId;
      progress.run_id = null;
      progress.status = PROGRESS_IDLE;
      progress.current_step = 0;
      progress.completed_steps = [];
      progress.steps = buildDefaultSteps();
      progress.context = {};
      progress.last_error = '';
      progress.started_at = null;
      progress.updated_at = new Date();
      return repo.save(progress);
    });
  }

  /**
   * 开始新的一轮流程运行：重置全部步骤为 pending，生成新 run_id。
   */
  async startRun(projectId: string, roleId: string): Promise<FlowProgressEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FlowProgressEntity);
      let progress = await repo.findOneBy({ project_id: projectId, role_id: roleId });

      if (!progress) {
        progress = repo.create();
        progress.project_id = projectId;
        progress.role_id = roleId;
      }

      progress.run_id = randomUUID();
      progress.status = PROGRESS_RUNNING;
      progress.current_step = 0;
      progress.completed_steps = [];
      progress.steps = buildDefaultSteps();
      progress.context = {};
      progress.last_error = '';
      progress.started_at = new Date();
      progress.updated_at = new Date();
      return repo.save(progress);
    });
  }

  /**
   * 记录单个步骤的状态变更。
   * running → 首次开始时写 started_at；done/failed → 写 finished_at。
   * completed_steps 只在 done 时追加 step_order。
   */
  async recordStep(
    projectId: string,
    roleId: string,
    stepOrder: number,
    status: FlowStepStatus,
    output?: Record<string, unknown>,
    error?: string
  ): Promise<FlowProgressEntity> {
    if (stepOrder < 1 || stepOrder > TOTAL_STEPS) {
      throw new Error(`step_order must be between 1 and ${TOTAL_STEPS}, got ${stepOrder}`);
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FlowProgressEntity);
      const progress = await repo.findOneBy({ project_id: projectId, role_id: roleId });
      if (!progress) {
        throw new Error(`FlowProgress not found for project=${projectId}, role=${roleId}`);
      }

      const steps = [...(progress.steps ?? buildDefaultSteps())];
      const idx = steps.findIndex((s) => s.step_order === stepOrder);

      const now = new Date().toISOString();
      const stepRecord: FlowStepRecord = {
        step_order: stepOrder,
        status,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
        started_at: status === STEP_RUNNING ? now : (steps[idx]?.started_at ?? null),
        finished_at: status === STEP_DONE || status === STEP_FAILED ? now : null
      };

      if (idx >= 0) steps[idx] = stepRecord;
      else steps.push(stepRecord);

      progress.steps = steps;
      progress.updated_at = new Date();

      // running → 更新 current_step；done → 追加 completed_steps
      if (status === STEP_RUNNING) {
        progress.current_step = stepOrder;
      }
      if (status === STEP_DONE) {
        const completed = new Set(progress.completed_steps ?? []);
        completed.add(stepOrder);
        progress.completed_steps = [...completed];
        // 如果所有步骤都完成了，自动转为 done
        if (completed.size === TOTAL_STEPS) {
          progress.status = PROGRESS_DONE;
          progress.last_error = '';
        }
      }

      return repo.save(progress);
    });
  }

  /**
   * 结束流程运行。status 为 done 或 failed。
   */
  async finishRun(
    projectId: string,
    roleId: string,
    status: typeof PROGRESS_DONE | typeof PROGRESS_FAILED,
    error?: string
  ): Promise<FlowProgressEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FlowProgressEntity);
      const progress = await repo.findOneBy({ project_id: projectId, role_id: roleId });
      if (!progress) {
        throw new Error(`FlowProgress not found for project=${projectId}, role=${roleId}`);
      }

      progress.status = status;
      progress.last_error = error ?? '';
      progress.updated_at = new Date();
      return repo.save(progress);
    });
  }

  /**
   * 重置流程进度到 idle 初始状态（清空 steps/run_id/completed_steps）。
   */
  async resetProgress(projectId: string, roleId: string): Promise<FlowProgressEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(FlowProgressEntity);
      let progress = await repo.findOneBy({ project_id: projectId, role_id: roleId });

      if (!progress) {
        progress = repo.create();
        progress.project_id = projectId;
        progress.role_id = roleId;
      }

      progress.run_id = null;
      progress.status = PROGRESS_IDLE;
      progress.current_step = 0;
      progress.completed_steps = [];
      progress.steps = buildDefaultSteps();
      progress.context = {};
      progress.last_error = '';
      progress.started_at = null;
      progress.updated_at = new Date();
      return repo.save(progress);
    });
  }
}
