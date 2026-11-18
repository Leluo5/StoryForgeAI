import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';
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
}
