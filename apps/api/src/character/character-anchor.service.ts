import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource, In } from 'typeorm';
import type { AnchorInvalidReason, AnchorStatus } from '../database/character-enums';
import { ChapterEntity } from '../database/chapter.entity';
import { CharacterArchiveScanEntity } from '../database/character-archive-scan.entity';
import { CharacterEntity } from '../database/character.entity';
import { CharacterTextAnchorEntity } from '../database/character-text-anchor.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';
import { collectParagraphBlocks } from './character-scan.service';

// 对外返回的段落标记（不含 excerpt_hash）
export interface ParagraphMark {
  anchor_id: string;
  chapter_id: string;
  paragraph_pid: string;
  matched_name: string;
  excerpt: string;
  status: AnchorStatus;
  invalid_reason: AnchorInvalidReason | null;
}

export interface ChapterMark {
  chapter_id: string;
  has_invalid: boolean;
  reason_code: 'character_restored' | 'text_changed' | 'pid_missing' | null;
  message: string;
}

export interface AnchorReadResult {
  paragraph_marks: ParagraphMark[];
  chapter_marks: ChapterMark[];
}

export interface ChapterParagraphMarkView {
  id: string;
  character_id: string;
  character_name: string;
  paragraph_pid: string;
  matched_name: string;
  status: AnchorStatus;
  excerpt: string;
}

export interface ChapterMarkView {
  character_id: string;
  character_name: string;
  reason: 'pid_missing' | 'text_changed';
  label: string;
}

export interface ChapterRoleMarksResult {
  paragraph_marks: ChapterParagraphMarkView[];
  chapter_marks: ChapterMarkView[];
  scan: {
    scan_id?: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    scanned_chapters: number;
    total_chapters: number;
  };
}

// F2 §2.2.12、§4.7、§5.5 锚点读取、失效判定与剔除
// - 查询走 (work_id, chapter_id, status) 索引
// - 惰性失效判定三原因：pid_missing / text_changed / character_restored
// - 短事务 best-effort：失效锚点异步批量置 invalid，不阻塞主查询
// - active 剔除 → dismissed 幂等；invalid 剔除 409
// - 角色恢复时：同 work 下此角色的 active 锚点批量置 invalid(character_restored)
@Injectable()
export class CharacterAnchorService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  // ──────────────────── 1. 读取：走索引 + 惰性失效判定 ────────────────────

  async readMarks(
    authorId: string,
    workId: string,
    characterId: string
  ): Promise<AnchorReadResult> {
    const manager = this.dataSource.manager;
    await this.assertOwnedWork(manager, authorId, workId);
    const char = await manager.getRepository(CharacterEntity).findOneBy({ id: characterId, work_id: workId });
    if (!char) throw new NotFoundException('角色不存在');

    // 走索引：(work_id, character_id, status) 全部 active + invalid（含 dismissed 保持）
    const anchors = await manager
      .getRepository(CharacterTextAnchorEntity)
      .find({
        where: {
          work_id: workId,
          character_id: characterId,
          status: In(['active', 'invalid', 'dismissed'] as AnchorStatus[])
        },
        order: { chapter_id: 'ASC', created_at: 'ASC' }
      });

    // 惰性失效判定（best-effort，短事务，不阻塞响应）
    const invalidated: { id: string; reason: AnchorInvalidReason }[] = [];
    const chapterIds = Array.from(new Set(anchors.map((a) => a.chapter_id)));
    const chapters = chapterIds.length
      ? await manager
          .getRepository(ChapterEntity)
          .find({ where: { id: In([...chapterIds]), work_id: workId } })
      : [];
    const chapterMap = new Map(chapters.map((c) => [c.id, c]));

    for (const a of anchors) {
      if (a.status === 'dismissed') continue; // 人工 dismiss 不动
      if (a.status === 'invalid') continue;   // 已是 invalid 不再判定

      const chapter = chapterMap.get(a.chapter_id);
      if (!chapter) {
        invalidated.push({ id: a.id, reason: 'pid_missing' });
        continue;
      }
      const blocks = collectParagraphBlocks(chapter.document as never);
      const block = blocks.find((b) => b.pid === a.paragraph_pid);
      if (!block) {
        invalidated.push({ id: a.id, reason: 'pid_missing' });
        continue;
      }
      const h = createHash('sha256').update(block.text).digest('hex').slice(0, 64);
      if (h !== a.excerpt_hash) {
        invalidated.push({ id: a.id, reason: 'text_changed' });
      }
    }

    if (char.status !== 'archived' && anchors.some((a) => a.status === 'active')) {
      // 角色已恢复 → 所有 active 锚点应失效
      for (const a of anchors) {
        if (a.status === 'active') invalidated.push({ id: a.id, reason: 'character_restored' });
      }
    }

    // 批量落库 invalid（短事务，best-effort）
    if (invalidated.length) {
      try {
        await this.dataSource.transaction(async (m) => {
          const repo = m.getRepository(CharacterTextAnchorEntity);
          for (const it of invalidated) {
            await repo
              .createQueryBuilder()
              .update({ status: 'invalid', invalid_reason: it.reason })
              .where('id = :id', { id: it.id })
              .execute();
          }
        });
      } catch {
        // 失效落库失败不阻塞返回
      }
    }

    // 重新读锚点（让 status/invalid_reason 最新）
    const refreshed = await manager
      .getRepository(CharacterTextAnchorEntity)
      .find({
        where: {
          work_id: workId,
          character_id: characterId,
          status: In(['active', 'invalid', 'dismissed'] as AnchorStatus[])
        },
        order: { chapter_id: 'ASC', created_at: 'ASC' }
      });

    const paragraphMarks: ParagraphMark[] = refreshed.map((a) => ({
      anchor_id: a.id,
      chapter_id: a.chapter_id,
      paragraph_pid: a.paragraph_pid,
      matched_name: a.matched_name,
      excerpt: a.excerpt,
      status: a.status,
      invalid_reason: a.invalid_reason
    }));

    // 同 chapter 下有 invalid → chapter_marks 兜底提示
    const byChapter = new Map<string, CharacterTextAnchorEntity[]>();
    for (const a of refreshed) {
      const arr = byChapter.get(a.chapter_id) ?? [];
      arr.push(a);
      byChapter.set(a.chapter_id, arr);
    }
    const chapterMarks: ChapterMark[] = [];
    for (const [chapterId, list] of byChapter) {
      const invalids = list.filter((a) => a.status === 'invalid');
      if (!invalids.length) continue;
      // 取出现频率最高的 reason_code
      const reasonCount = new Map<AnchorInvalidReason, number>();
      for (const i of invalids) reasonCount.set(i.invalid_reason!, (reasonCount.get(i.invalid_reason!) ?? 0) + 1);
      let topReason: AnchorInvalidReason | null = null;
      let topCount = -1;
      for (const [r, c] of reasonCount) {
        if (c > topCount) {
          topCount = c;
          topReason = r;
        }
      }
      chapterMarks.push({
        chapter_id: chapterId,
        has_invalid: true,
        reason_code: topReason,
        message: this.reasonMessage(topReason!)
      });
    }

    return { paragraph_marks: paragraphMarks, chapter_marks: chapterMarks };
  }

  private reasonMessage(r: AnchorInvalidReason): string {
    switch (r) {
      case 'pid_missing':
        return '原段落已删除';
      case 'text_changed':
        return '原文已被修改';
      case 'character_restored':
        return '关联角色已归档恢复，原文已修改';
    }
  }

  // ──────────────────── 2. 剔除：active → dismissed；invalid 剔除 409 ────────────────────

  async dismissAnchor(
    authorId: string,
    workId: string,
    anchorId: string
  ): Promise<CharacterTextAnchorEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterTextAnchorEntity);
      const a = await repo.findOneBy({ id: anchorId, work_id: workId });
      if (!a) throw new NotFoundException('锚点不存在');
      if (a.status === 'dismissed') return a; // 幂等
      if (a.status === 'invalid') {
        throw new ConflictException({
          code: 'ANCHOR_INVALID_TENTATIVE',
          message: '锚点已失效（非人工 dismiss），不可手动剔除；如需移除请恢复角色后重新扫描'
        });
      }
      if (a.status !== 'active') {
        throw new BadRequestException('只有 active 锚点才能剔除');
      }
      a.status = 'dismissed';
      a.dismissed_at = new Date();
      a.dismissed_by = authorId;
      const saved = await repo.save(a);
      await this.audit.record(
        authorId, 'character_anchor_dismiss', 'character_text_anchor', saved.id,
        { chapter_id: saved.chapter_id }, workId, manager
      );
      return saved;
    });
  }

  // ──────────────────── 3. 角色恢复时批量置 invalid(character_restored) ────────────────────

  async markAnchorsRestored(
    authorId: string,
    workId: string,
    characterId: string
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterTextAnchorEntity);
      const result = await repo
        .createQueryBuilder()
        .update({ status: 'invalid', invalid_reason: 'character_restored' })
        .where('work_id = :workId AND character_id = :cid AND status = :status', {
          workId,
          cid: characterId,
          status: 'active'
        })
        .execute();
      const updated = result.affected ?? 0;
      if (updated > 0) {
        await this.audit.record(
          authorId, 'character_anchor_restored_bulk', 'character_text_anchor', characterId,
          { updated }, workId, manager
        );
      }
      return updated;
    });
  }

  // ──────────────────── 4. 整章角色标记（F2 §4.7） ────────────────────

  async readChapterMarks(
    authorId: string,
    workId: string,
    chapterId: string
  ): Promise<ChapterRoleMarksResult> {
    const manager = this.dataSource.manager;
    await this.assertOwnedWork(manager, authorId, workId);
    const chapter = await manager
      .getRepository(ChapterEntity)
      .findOneBy({ id: chapterId, work_id: workId });
    if (!chapter) throw new NotFoundException('章节不存在');

    const anchors = await manager.getRepository(CharacterTextAnchorEntity).find({
      where: { work_id: workId, chapter_id: chapterId },
      order: { created_at: 'ASC' }
    });

    const characterIds = Array.from(new Set(anchors.map((a) => a.character_id)));
    const characters = characterIds.length
      ? await manager.getRepository(CharacterEntity).find({ where: { id: In(characterIds) } })
      : [];
    const characterMap = new Map(characters.map((c) => [c.id, c]));

    const blocks = collectParagraphBlocks(chapter.document as never);
    const blockByPid = new Map(blocks.map((b) => [b.pid, b]));
    const corrections: Array<{ id: string; reason: AnchorInvalidReason }> = [];
    const latestStatus = new Map<string, { status: AnchorStatus; reason: AnchorInvalidReason | null }>();

    for (const anchor of anchors) {
      if (anchor.status !== 'active') {
        latestStatus.set(anchor.id, { status: anchor.status, reason: anchor.invalid_reason });
        continue;
      }
      const block = blockByPid.get(anchor.paragraph_pid);
      if (!block) {
        corrections.push({ id: anchor.id, reason: 'pid_missing' });
        latestStatus.set(anchor.id, { status: 'invalid', reason: 'pid_missing' });
        continue;
      }
      const hash = createHash('sha256').update(block.text).digest('hex').slice(0, 64);
      if (hash !== anchor.excerpt_hash) {
        corrections.push({ id: anchor.id, reason: 'text_changed' });
        latestStatus.set(anchor.id, { status: 'invalid', reason: 'text_changed' });
        continue;
      }
      const character = characterMap.get(anchor.character_id);
      if (!character || character.status !== 'archived') {
        corrections.push({ id: anchor.id, reason: 'character_restored' });
        latestStatus.set(anchor.id, { status: 'invalid', reason: 'character_restored' });
        continue;
      }
      latestStatus.set(anchor.id, { status: 'active', reason: null });
    }

    if (corrections.length) {
      try {
        await this.dataSource.transaction(async (m) => {
          const repo = m.getRepository(CharacterTextAnchorEntity);
          for (const fix of corrections) {
            await repo
              .createQueryBuilder()
              .update({ status: 'invalid', invalid_reason: fix.reason })
              .where('id = :id', { id: fix.id })
              .execute();
          }
        });
      } catch {
        // best-effort：判定落库失败不阻塞读取
      }
    }

    const paragraph_marks: ChapterParagraphMarkView[] = [];
    for (const anchor of anchors) {
      const state = latestStatus.get(anchor.id)!;
      if (state.status !== 'active') continue;
      paragraph_marks.push({
        id: anchor.id,
        character_id: anchor.character_id,
        character_name: characterMap.get(anchor.character_id)?.name ?? anchor.matched_name,
        paragraph_pid: anchor.paragraph_pid,
        matched_name: anchor.matched_name,
        status: 'active',
        excerpt: anchor.excerpt.slice(0, 120)
      });
    }

    // 同角色在本章存在 invalid 锚点 → 聚合为章节级提示
    // 角色已恢复（非 archived）时整章提示必须消失（D26），不再聚合
    const invalidByCharacter = new Map<string, AnchorInvalidReason>();
    const invalidCount = new Map<string, number>();
    for (const anchor of anchors) {
      const state = latestStatus.get(anchor.id)!;
      if (state.status !== 'invalid') continue;
      if (characterMap.get(anchor.character_id)?.status !== 'archived') continue;
      const reason: AnchorInvalidReason = state.reason ?? 'text_changed';
      const current = invalidByCharacter.get(anchor.character_id);
      const count = (invalidCount.get(anchor.character_id) ?? 0) + 1;
      invalidCount.set(anchor.character_id, count);
      if (!current || (current !== 'pid_missing' && reason === 'pid_missing')) {
        invalidByCharacter.set(anchor.character_id, reason);
      }
    }
    const chapter_marks: ChapterMarkView[] = [];
    for (const [characterId, reason] of invalidByCharacter) {
      const name = characterMap.get(characterId)?.name ?? '未知角色';
      chapter_marks.push({
        character_id: characterId,
        character_name: name,
        reason: reason === 'pid_missing' ? 'pid_missing' : 'text_changed',
        label: this.chapterMarkLabel(reason).slice(0, 80)
      });
    }

    // scan：最近一次归档扫描；无则视为已完成（0 扫描）
    const latestScan = await manager.getRepository(CharacterArchiveScanEntity).findOne({
      where: { work_id: workId },
      order: { created_at: 'DESC' }
    });
    const totalChapters = await manager.getRepository(ChapterEntity).count({ where: { work_id: workId } });
    const scan = latestScan
      ? {
          scan_id: latestScan.id,
          status: latestScan.status,
          scanned_chapters: latestScan.scanned_chapters,
          total_chapters: latestScan.total_chapters
        }
      : { status: 'succeeded' as const, scanned_chapters: 0, total_chapters: totalChapters };

    return { paragraph_marks, chapter_marks, scan };
  }

  private chapterMarkLabel(reason: AnchorInvalidReason): string {
    switch (reason) {
      case 'pid_missing':
        return '原段落已删除';
      case 'character_restored':
        return '关联角色已归档（原文已修改）';
      case 'text_changed':
      default:
        return '原文已被修改';
    }
  }

  // ──────────────────── 5. 批量剔除 ────────────────────

  async dismissBatch(
    authorId: string,
    workId: string,
    chapterId: string,
    anchorIds: string[]
  ): Promise<{ dismissed: number; skipped: number }> {
    const ids = Array.from(new Set(anchorIds));
    if (ids.length > 100) throw new BadRequestException('单次最多剔除 100 条');
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const chapter = await manager
        .getRepository(ChapterEntity)
        .findOneBy({ id: chapterId, work_id: workId });
      if (!chapter) throw new NotFoundException('章节不存在');

      const repo = manager.getRepository(CharacterTextAnchorEntity);
      const anchors = await repo.find({ where: { id: In(ids), work_id: workId, chapter_id: chapterId } });
      if (anchors.length !== ids.length) throw new NotFoundException('锚点不存在或不属于该章节');
      const invalid = anchors.filter((a) => a.status === 'invalid');
      if (invalid.length > 0) {
        throw new ConflictException({
          code: 'CHARACTER_ANCHOR_NOT_DISMISSABLE',
          anchor_ids: invalid.map((a) => a.id)
        });
      }

      let dismissed = 0;
      let skipped = 0;
      for (const anchor of anchors) {
        if (anchor.status === 'dismissed') {
          skipped += 1;
          continue;
        }
        if (anchor.status === 'active') {
          anchor.status = 'dismissed';
          anchor.dismissed_at = new Date();
          anchor.dismissed_by = authorId;
          await repo.save(anchor);
          dismissed += 1;
        } else {
          skipped += 1;
        }
      }
      if (dismissed > 0) {
        await this.audit.record(
          authorId, 'character_anchor_dismiss_batch', 'character_text_anchor', null,
          { chapter_id: chapterId, dismissed, skipped }, workId, manager
        );
      }
      return { dismissed, skipped };
    });
  }
}
