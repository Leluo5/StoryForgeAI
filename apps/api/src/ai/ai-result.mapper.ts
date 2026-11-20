import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { ProseMirrorNode } from '@storyforge/contracts';
import { canonicalizeContent, replaceDocumentOperations } from '@storyforge/editor-schema';
import { ChapterEntity } from '../database/chapter.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { AuditService } from '../revision/audit.service';
import type { AiResultMapperPort, AiRevisionSetResult } from './ai-task.processor';

/**
 * 将 baseDocument → candidateDocument 的差异转为有序 ProseMirror 操作集。
 * 策略（对齐技术方案 §4.3，M3a 用整文档替换单步）：
 * - 规范化校验两文档（canonicalizeDocument，非法结构抛错）
 * - 无差异 → 返回空数组（调用方不落地修订集）
 * - 有差异 → 生成单个 ReplaceStep(0, content.size, 候选内容)（editor-schema replaceDocumentOperations 已验证）
 *
 * 说明：整文档替换是合法 ProseMirror step，可被 M2 applyOperations 正确应用、可逆、可预览；
 * 对 AI 续写/重写/扩写/润色（整章候选输出）精度足够。M3b 接 Coze 若需文本级细粒度 diff 再增强。
 */
export function toRevisionOperations(baseDocument: ProseMirrorNode, candidateDocument: ProseMirrorNode): Array<Record<string, unknown>> {
  // 内容比较忽略 pid：候选与基准仅在 pid 上不同不算差异，避免无意义的整篇替换
  const baseJson = canonicalizeContent(baseDocument);
  const candidateJson = canonicalizeContent(candidateDocument);
  if (baseJson === candidateJson) return [];
  // replaceDocumentOperations 内部校验：应用后 canonicalize 与候选一致，否则抛错（防错位）
  return replaceDocumentOperations(baseDocument, candidateDocument);
}

/**
 * 候选输出转 AI 修订集（实现 A5 定义的 AiResultMapperPort）。
 * - 校验章节归属 + 基准版本（chapter.version === baseVersion，否则 stale 标记，不直接套用）
 * - 创建 revision_sets(actor_type='ai', ai_set=true, base_version, operations)
 * - 无差异（候选==基准）→ 返回 { revision_set_id: null, stale: false }（调用方按成功处理，但无修订集）
 */
@Injectable()
export class AiResultMapper implements AiResultMapperPort {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  async toAiRevisionSet(
    manager: EntityManager,
    ctx: { authorId: string; workId: string; chapterId: string; baseVersion: number; candidateDocument: ProseMirrorNode }
  ): Promise<AiRevisionSetResult> {
    // 1. 读章节（事务内，无锁——调用方已持任务锁；仅需基准版本比对）
    const chapter = await manager.getRepository(ChapterEntity).findOneBy({ id: ctx.chapterId });
    if (!chapter) {
      throw new Error(`Chapter ${ctx.chapterId} not found during AI result mapping`);
    }

    // 2. 基准版本校验：已变化 → stale（候选基于旧版本生成，不直接套用，提示重新生成）
    const stale = chapter.version !== ctx.baseVersion;
    const operations = toRevisionOperations(chapter.document, ctx.candidateDocument);
    if (operations.length === 0) {
      // 候选与基准无差异：无修订集可落地
      return { revision_set_id: null, stale };
    }

    // 3. 创建 AI 修订集（对齐 M2 createRevisionSet 的 aiSet 分支）
    const entity = manager.getRepository(RevisionSetEntity).create();
    entity.id = randomUUID();
    entity.chapter_id = ctx.chapterId;
    entity.base_version = ctx.baseVersion;
    entity.actor_type = 'ai';
    entity.actor_id = null;
    entity.operations = operations.map((step, index) => ({ index, step, status: 'pending' }));
    entity.status = 'pending';
    entity.ai_set = true;
    await manager.save(entity);

    await this.auditService.record(ctx.authorId, 'revision_create', 'revision_set', entity.id, {
      chapter_id: ctx.chapterId,
      actor_type: 'ai',
      base_version: ctx.baseVersion,
      operation_count: operations.length,
      ai_set: true,
      stale
    }, ctx.workId);

    return { revision_set_id: entity.id, stale };
  }
}
