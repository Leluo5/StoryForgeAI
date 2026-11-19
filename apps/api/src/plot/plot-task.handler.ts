import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';
import { PlotGenerationDraftEntity } from '../database/plot-generation-draft.entity';
import { plotTreeDraftPayloadSchema, type PlotTreeDraftPayload } from '@storyforge/contracts';
import type { PlotStepCandidate } from './plot-model.provider';

export type { PlotStepCandidate } from './plot-model.provider';

export interface PlotStepWriteInput {
  taskId: string;
  sessionId: string;
  workId: string;
  stepNo: number;
  candidate: PlotStepCandidate;
}

export interface PlotStepWriteResult {
  step_id: string;
  step_no: number;
  created: boolean;
}

export interface PlotGenerationWriteInput {
  taskId: string;
  draftId: string;
  workId: string;
  payload: PlotTreeDraftPayload;
}

/**
 * 剧情任务结果落库：由处理器在「任务推进事务」内调用，保证步骤写入与任务状态原子。
 * 幂等：同一步号已存在时直接返回既有步骤，不重复插入。
 */
@Injectable()
export class PlotTaskHandler {
  async writeStep(manager: EntityManager, input: PlotStepWriteInput): Promise<PlotStepWriteResult> {
    const sessionRepository = manager.getRepository(DerivationSessionEntity);
    const session = await sessionRepository
      .createQueryBuilder('session')
      .setLock('pessimistic_write')
      .where('session.id = :sessionId', { sessionId: input.sessionId })
      .andWhere('session.work_id = :workId', { workId: input.workId })
      .getOne();
    if (!session) throw new Error(`Derivation session ${input.sessionId} not found`);

    const stepRepository = manager.getRepository(DerivationStepEntity);
    const existing = await stepRepository.findOneBy({ session_id: session.id, step_no: input.stepNo });
    if (existing) {
      return { step_id: existing.id, step_no: existing.step_no, created: false };
    }

    const step = await stepRepository.save(
      stepRepository.create({
        id: randomUUID(),
        session_id: session.id,
        step_no: input.stepNo,
        content: input.candidate.content,
        event: input.candidate.event,
        new_characters: input.candidate.new_characters,
        branches: input.candidate.branches,
        chosen_branch_id: null,
        task_id: input.taskId
      })
    );

    session.status = 'paused';
    session.step_index = Math.max(session.step_index, input.stepNo);
    await sessionRepository.save(session);

    return { step_id: step.id, step_no: step.step_no, created: true };
  }

  async writeGeneration(
    manager: EntityManager,
    input: PlotGenerationWriteInput
  ): Promise<{ draft_id: string; created: boolean }> {
    const repository = manager.getRepository(PlotGenerationDraftEntity);
    const draft = await repository.createQueryBuilder('draft')
      .setLock('pessimistic_write')
      .where('draft.id = :draftId', { draftId: input.draftId })
      .andWhere('draft.work_id = :workId', { workId: input.workId })
      .getOne();
    if (!draft || draft.task_id !== input.taskId) {
      throw new Error(`Plot generation draft ${input.draftId} not found for task ${input.taskId}`);
    }
    if (draft.status === 'succeeded') return { draft_id: draft.id, created: false };
    if (draft.status !== 'pending' && draft.status !== 'failed') {
      throw new Error(`Plot generation draft ${draft.id} cannot accept a task result`);
    }

    draft.payload = plotTreeDraftPayloadSchema.parse(input.payload) as unknown as Record<string, unknown>;
    draft.status = 'succeeded';
    draft.error = null;
    await repository.save(draft);
    return { draft_id: draft.id, created: true };
  }

  async failGeneration(
    manager: EntityManager,
    input: { taskId: string; workId: string; error: Record<string, unknown> }
  ): Promise<void> {
    const repository = manager.getRepository(PlotGenerationDraftEntity);
    const draft = await repository.createQueryBuilder('draft')
      .setLock('pessimistic_write')
      .where('draft.task_id = :taskId', { taskId: input.taskId })
      .andWhere('draft.work_id = :workId', { workId: input.workId })
      .getOne();
    if (!draft || (draft.status !== 'pending' && draft.status !== 'failed')) return;
    draft.status = 'failed';
    draft.error = input.error;
    await repository.save(draft);
  }
}
