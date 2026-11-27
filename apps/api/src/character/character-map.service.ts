import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AiTask } from '@storyforge/contracts';
import { WorkEntity } from '../database/work.entity';
import { AiTaskService } from '../ai/ai-task.service';

/** AI 建图工具标识（ai_tools 权威注册；建图仅基于已入库角色生成关系边） */
export const CHARACTER_MAP_TOOL = 'character_map_generate';

/**
 * M4-T8 AI 建图服务。
 * 职责：作者归属校验 → 创建 ai-task（scope='character_map'）→ 入队；
 * 建图进度经 ai-task SSE / getTask 查询获取。
 * 落点：character_relation（origin='ai'），不新建角色（缺失对端角色跳过该边）。
 */
@Injectable()
export class CharacterMapService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AiTaskService) private readonly aiTaskService: AiTaskService
  ) {}

  /** 发起一次 AI 建图，返回 aiTaskId（幂等键按作品固定，重复发起返回既有任务）。 */
  async generate(authorId: string, workId: string): Promise<{ aiTaskId: string }> {
    await this.assertOwnedWork(authorId, workId);
    const { task } = await this.aiTaskService.createCharacterMapTask(authorId, workId, {
      tool: CHARACTER_MAP_TOOL,
      inputSummary: { work_id: workId },
      idempotencyKey: `character_map:generate:${workId}`
    });
    return { aiTaskId: task.id };
  }

  /** 查询建图任务状态（作品归属校验）。 */
  async getTask(authorId: string, workId: string, taskId: string): Promise<AiTask> {
    await this.assertOwnedWork(authorId, workId);
    const { task } = await this.aiTaskService.getTask(authorId, workId, taskId);
    return task;
  }

  private async assertOwnedWork(authorId: string, workId: string): Promise<void> {
    const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }
}
