import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../revision/audit.service';
import { CharacterAvatarService } from './character-avatar.service';
import { CharacterAiService } from './character-ai.service';

export interface CharacterTaskContext {
  taskId: string;
  authorId: string;
  workId: string;
  tool: string;
  inputSummary: Record<string, unknown>;
}

/**
 * 角色域 AI 任务处理器（T30）。
 * - character_avatar_generate：生成头像资产（pending），返回 asset_id
 * - character_extract / character_growth_extract：本阶段无角色文本模型，
 *   只打通任务链路：草稿 pending → commitTaskResult([], 空结果)
 */
@Injectable()
export class CharacterTaskHandler {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CharacterAvatarService) private readonly avatars: CharacterAvatarService,
    @Inject(CharacterAiService) private readonly ai: CharacterAiService
  ) {}

  async handle(context: CharacterTaskContext): Promise<Record<string, unknown>> {
    switch (context.tool) {
      case 'character_avatar_generate': {
        const characterId = context.inputSummary['character_id'];
        if (typeof characterId !== 'string' || !characterId) {
          throw new Error(`Character avatar task ${context.taskId} missing character_id`);
        }
        const asset = await this.avatars.generate(context.authorId, context.workId, characterId, {
          task_id: context.taskId
        });
        return { asset_id: asset.id };
      }
      case 'character_extract':
      case 'character_growth_extract': {
        const draftId = context.inputSummary['draft_id'];
        if (typeof draftId !== 'string' || !draftId) {
          throw new Error(`Character draft task ${context.taskId} missing draft_id`);
        }
        const draft = await this.ai.getDraft(context.authorId, context.workId, draftId);
        if (draft.status === 'pending') {
          // 本阶段无角色文本模型，仅推进状态机（后续模型接入后替换为真实抽取结果）
          await this.ai.commitTaskResult(context.authorId, context.workId, draftId, []);
        }
        return { item_count: 0 };
      }
      default:
        throw new Error(`Unsupported character tool ${context.tool}`);
    }
  }

  /** 任务失败时同步把关联草稿置 failed（best-effort） */
  async failDraft(context: CharacterTaskContext, error: Record<string, unknown>): Promise<void> {
    const draftId = context.inputSummary['draft_id'];
    if (typeof draftId !== 'string' || !draftId) return;
    await this.ai
      .markFailed(draftId, error, { authorId: context.authorId, workId: context.workId })
      .catch(() => undefined);
  }
}
