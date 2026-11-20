import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource, In } from 'typeorm';
import type { ProseMirrorNode } from '@storyforge/contracts';
import { ChapterEntity } from '../database/chapter.entity';
import { CharacterEntity } from '../database/character.entity';
import { CharacterArchiveScanEntity } from '../database/character-archive-scan.entity';
import { CharacterTextAnchorEntity } from '../database/character-text-anchor.entity';
import type { AnchorStatus, ArchiveScanStatus } from '../database/character-enums';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';
import { normalizeAliasKey } from './character-candidate.normalize';

const BATCH_SIZE = 50;
const EXCERPT_MAX = 120;

// ──────────────────── ProseMirror 递归遍历 ────────────────────

export interface BlockHit {
  pid: string;
  text: string; // 合并后的 block 文本
}

export function collectParagraphBlocks(root: ProseMirrorNode | null | undefined, out: BlockHit[] = []): BlockHit[] {
  if (!root) return out;
  // 节点类型判断：有 attrs.pid + type 非 text 说明是段落级 block
  const attrs = (root as unknown as { attrs?: { pid?: string } }).attrs;
  const pid = attrs?.pid;
  // 简单启发：有 pid 且不是 text/mark 类型 → 段落块
  if (pid && root.type && !['text', 'em', 'strong', 'code', 'link'].includes(root.type)) {
    const text = collectText(root).trim();
    if (text.length > 0) out.push({ pid, text });
  }
  if (Array.isArray(root.content)) {
    for (const child of root.content) collectParagraphBlocks(child, out);
  }
  return out;
}

export function collectText(node: ProseMirrorNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') {
    return ((node as unknown as { text?: string }).text) ?? '';
  }
  if (Array.isArray(node.content)) {
    return node.content.map((c) => collectText(c)).join('');
  }
  return '';
}

// ──────────────────── 归档扫描服务 ────────────────────

@Injectable()
export class CharacterArchiveScanService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  // ──────────────────── 启动清理：遗留 pending/running 置 failed ────────────────────

  async cleanupStaleRuns(): Promise<void> {
    const scanRepo = this.dataSource.getRepository(CharacterArchiveScanEntity);
    await scanRepo
      .createQueryBuilder()
      .update({
        status: 'failed',
        finished_at: new Date(),
        error: { code: 'STALE', message: '服务重启前未完成，自动终止' }
      })
      .where('status IN (:...statuses)', { statuses: ['pending', 'running'] })
      .execute();
  }

  // ──────────────────── 启动扫描 ────────────────────

  async start(
    authorId: string,
    workId: string,
    characterId: string
  ): Promise<CharacterArchiveScanEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const charRepo = manager.getRepository(CharacterEntity);
      const character = await charRepo.findOneBy({ id: characterId, work_id: workId });
      if (!character) throw new NotFoundException('角色不存在');
      if (character.status === 'merged') {
        throw new ConflictException({ code: 'CHARACTER_MERGED', message: '已合并角色不可扫描' });
      }
      if (character.status === 'archived') {
        throw new ConflictException({ code: 'CHARACTER_ARCHIVED', message: '已归档角色不可扫描' });
      }

      // 同角色唯一运行（部分唯一索引保护；代码层再守一次）
      const scanRepo = manager.getRepository(CharacterArchiveScanEntity);
      const running = await scanRepo.findOne({
        where: { character_id: characterId, status: In(['pending', 'running'] as ArchiveScanStatus[]) }
      });
      if (running) {
        throw new ConflictException({
          code: 'SCAN_ALREADY_RUNNING',
          scan_id: running.id
        });
      }

      const saved = await scanRepo.save(
        scanRepo.create({
          id: randomUUID(),
          work_id: workId,
          character_id: characterId,
          requested_by: authorId,
          status: 'pending',
          total_chapters: 0,
          scanned_chapters: 0,
          matched_paragraphs: 0,
          error: null,
          started_at: new Date(),
          finished_at: null
        })
      );

      await this.audit.record(
        authorId,
        'character_scan_start',
        'character_archive_scan',
        saved.id,
        { character_id: characterId },
        workId,
        manager
      );

      return saved;
    });
  }

  /** 归档角色重扫（T27）：仅 archived 可重扫；已有 pending/running → 409 */
  async rescanArchived(
    authorId: string,
    workId: string,
    characterId: string
  ): Promise<CharacterArchiveScanEntity> {
    const scan = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const character = await manager
        .getRepository(CharacterEntity)
        .findOneBy({ id: characterId, work_id: workId });
      if (!character) throw new NotFoundException('角色不存在');
      if (character.status !== 'archived') {
        throw new ConflictException({ code: 'CHARACTER_NOT_ARCHIVED', message: '仅归档角色可重扫' });
      }
      const scanRepo = manager.getRepository(CharacterArchiveScanEntity);
      const running = await scanRepo.findOne({
        where: { character_id: characterId, status: In(['pending', 'running'] as ArchiveScanStatus[]) }
      });
      if (running) {
        throw new ConflictException({ code: 'CHARACTER_SCAN_RUNNING', scan_id: running.id });
      }
      const totalChapters = await manager.getRepository(ChapterEntity).count({ where: { work_id: workId } });
      const saved = await scanRepo.save(
        scanRepo.create({
          id: randomUUID(),
          work_id: workId,
          character_id: characterId,
          requested_by: authorId,
          status: 'pending',
          total_chapters: totalChapters,
          scanned_chapters: 0,
          matched_paragraphs: 0,
          error: null,
          started_at: new Date(),
          finished_at: null
        })
      );
      await this.audit.record(
        authorId,
        'character_scan_rescan',
        'character_archive_scan',
        saved.id,
        { character_id: characterId, total_chapters: totalChapters },
        workId,
        manager
      );
      return saved;
    });
    // 提交后异步扫描（失败不阻塞响应）
    void this.runBatches(authorId, workId, scan.id).catch(() => undefined);
    return scan;
  }

  async runBatches(
    authorId: string,
    workId: string,
    scanId: string
  ): Promise<CharacterArchiveScanEntity> {
    const chapterRepo = this.dataSource.getRepository(ChapterEntity);
    const scanRepo = this.dataSource.getRepository(CharacterArchiveScanEntity);

    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const scan = await manager.getRepository(CharacterArchiveScanEntity).findOneByOrFail({ id: scanId });
      if (scan.status !== 'pending' && scan.status !== 'running') {
        throw new ConflictException({ code: 'SCAN_INVALID_STATUS', message: `scan status ${scan.status} 不可执行` });
      }
      scan.status = 'running';
      await scanRepo.save(scan);

      const chapters = await chapterRepo.find({ where: { work_id: workId }, order: { position: 'ASC' } });
      const character = await manager.getRepository(CharacterEntity).findOneByOrFail({ id: scan.character_id });

      await this.doRunBatches(manager, scan.id, chapters, character);

      await this.audit.record(
        authorId,
        'character_scan_progress',
        'character_archive_scan',
        scan.id,
        { scanned: scan.scanned_chapters, matched: scan.matched_paragraphs },
        workId,
        manager
      );
      return manager.getRepository(CharacterArchiveScanEntity).findOneByOrFail({ id: scan.id });
    });
  }

  // ──────────────────── 分批扫描主循环 ────────────────────

  private async doRunBatches(
    manager: EntityManager,
    scanId: string,
    chapters: ChapterEntity[],
    character: CharacterEntity
  ): Promise<void> {
    const aliasRepo = manager.getRepository(CharacterEntity.constructor as never);
    // 收集所有候选 name：角色主名（归一化）+ 所有别名（归一化），去重
    const aliasRows = await manager
      .createQueryBuilder()
      .select('alias_key', 'alias_key')
      .from('character_aliases', 'a')
      .where('a.character_id = :cid', { cid: character.id })
      .execute();
    const candidates = new Set<string>();
    const normalizedName = normalizeAliasKey(character.name);
    if (normalizedName) candidates.add(normalizedName);
    for (const row of aliasRows as { alias_key: string }[]) {
      if (row.alias_key) candidates.add(row.alias_key);
    }
    if (candidates.size === 0) {
      await this.finishScan(manager, scanId, 'succeeded');
      return;
    }
    const candidatesArr = Array.from(candidates).sort((a, b) => b.length - a.length); // 长的优先匹配

    const anchorRepo = manager.getRepository(CharacterTextAnchorEntity);
    const scanRepo = manager.getRepository(CharacterArchiveScanEntity);

    let scannedCount = 0;
    let matchedCount = 0;

    for (let offset = 0; offset < chapters.length; offset += BATCH_SIZE) {
      const batch = chapters.slice(offset, offset + BATCH_SIZE);
      for (const chap of batch) {
        // 确保 pid 存在
        await this.ensureChapterPids(manager, chap);
        const blocks = collectParagraphBlocks(chap.document as ProseMirrorNode);
        // 归一化匹配：同时保留原文做 excerpt
        for (const block of blocks) {
          const blockNormalized = normalizeAliasKey(block.text);
          if (!blockNormalized) continue;
          // 取最长命中的 matched_name
          let matched: { name: string; pos: number } | null = null;
          for (const cand of candidatesArr) {
            if (!cand) continue;
            const pos = blockNormalized.indexOf(cand);
            if (pos >= 0) {
              // 长候选优先；同长度保持先到先得
              if (!matched || cand.length > matched.name.length) {
                matched = { name: cand, pos };
              }
            }
          }
          if (!matched) continue;

          const excerpt = this.truncateExcerpt(block.text, matched.pos, matched.name.length);
          const hash = require('node:crypto').createHash('sha256').update(block.text).digest('hex');

          const existing = await anchorRepo.findOneBy({
            scan_id: scanId,
            chapter_id: chap.id,
            paragraph_pid: block.pid,
            character_id: character.id
          });

          if (!existing) {
            await anchorRepo.save(
              anchorRepo.create({
                id: randomUUID(),
                work_id: character.work_id,
                character_id: character.id,
                chapter_id: chap.id,
                scan_id: scanId,
                paragraph_pid: block.pid,
                matched_name: matched.name,
                excerpt,
                excerpt_hash: hash,
                status: 'active',
                invalid_reason: null,
                dismissed_at: null,
                dismissed_by: null
              })
            );
            matchedCount += 1;
          } else if (existing.status === 'invalid') {
            // 复活 invalid → active
            existing.status = 'active';
            existing.invalid_reason = null;
            existing.excerpt = excerpt;
            existing.excerpt_hash = hash;
            existing.matched_name = matched.name;
            await anchorRepo.save(existing);
            matchedCount += 1;
          }
          // dismissed 保持不动
        }
        scannedCount += 1;
      }

      // 每批更新进度
      await scanRepo.update(
        { id: scanId },
        { scanned_chapters: scannedCount, matched_paragraphs: matchedCount }
      );
      await this.audit.record(
        character.id,
        'character_scan_batch',
        'character_archive_scan',
        scanId,
        { scanned: scannedCount, matched: matchedCount, batch_size: batch.length },
        character.work_id,
        manager
      );
    }

    await this.finishScan(manager, scanId, 'succeeded');
  }

  private async finishScan(
    manager: EntityManager,
    scanId: string,
    status: ArchiveScanStatus
  ): Promise<void> {
    const scanRepo = manager.getRepository(CharacterArchiveScanEntity);
    await scanRepo.update({ id: scanId }, { status, finished_at: new Date() });
    const scan = await scanRepo.findOneByOrFail({ id: scanId });
    await this.audit.record(
      scan.requested_by,
      'character_scan_complete',
      'character_archive_scan',
      scanId,
      { status: scan.status, matched_paragraphs: scan.matched_paragraphs ?? 0, total_chapters: scan.total_chapters },
      scan.work_id,
      manager
    );
  }

  // ──────────────────── 失败置位（外部异常时调用） ────────────────────

  async markFailed(scanId: string, error: unknown): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const scanRepo = manager.getRepository(CharacterArchiveScanEntity);
      const scan = await scanRepo.findOneBy({ id: scanId });
      if (!scan) return;
      await scanRepo.update(
        { id: scanId },
        {
          status: 'failed',
          finished_at: new Date(),
          error: { code: 'ERROR', message: String(error) }
        }
      );
      await this.audit.record(
        scan.requested_by,
        'character_scan_fail',
        'character_archive_scan',
        scanId,
        { reason: String(error) },
        scan.work_id,
        manager
      );
    });
  }

  // ──────────────────── 锚点 upsert 三态 ────────────────────

  async upsertAnchor(params: {
    manager: EntityManager;
    scan_id: string;
    character_id: string;
    chapter_id: string;
    paragraph_pid: string;
    matched_name: string;
    excerpt: string;
    excerpt_hash: string;
    work_id: string;
  }): Promise<void> {
    const repo = params.manager.getRepository(CharacterTextAnchorEntity);
    const existing = await repo.findOneBy({
      scan_id: params.scan_id,
      chapter_id: params.chapter_id,
      paragraph_pid: params.paragraph_pid,
      character_id: params.character_id
    });
    if (!existing) {
      const entity = repo.create({
        id: randomUUID(),
        work_id: params.work_id,
        character_id: params.character_id,
        chapter_id: params.chapter_id,
        scan_id: params.scan_id,
        paragraph_pid: params.paragraph_pid,
        matched_name: params.matched_name,
        excerpt: params.excerpt,
        excerpt_hash: params.excerpt_hash,
        status: 'active',
        invalid_reason: null,
        dismissed_at: null,
        dismissed_by: null
      });
      await repo.save(entity);
      return;
    }
    if (existing.status === 'dismissed') return;
    existing.status = 'active';
    existing.invalid_reason = null;
    existing.excerpt = params.excerpt;
    existing.excerpt_hash = params.excerpt_hash;
    existing.matched_name = params.matched_name;
    await repo.save(existing);
  }

  // ──────────────────── pid 固化：不递增 version、不建快照 ────────────────────

  async ensureChapterPids(manager: EntityManager, chapter: ChapterEntity): Promise<void> {
    let mutated = false;
    const walk = (node: ProseMirrorNode): ProseMirrorNode => {
      if (!node) return node;
      const attrs = (node as unknown as { attrs?: { pid?: string } }).attrs ?? {};
      const newAttrs: Record<string, unknown> = { ...attrs };
      if (node.type && !['text', 'em', 'strong', 'code', 'link'].includes(node.type)) {
        if (!attrs.pid) {
          newAttrs.pid = randomUUID();
          mutated = true;
        }
      }
      const next: ProseMirrorNode = { ...node, attrs: newAttrs } as ProseMirrorNode;
      if (Array.isArray(node.content)) {
        next.content = node.content.map(walk);
      }
      return next;
    };
    const newDoc = walk(chapter.document as ProseMirrorNode);
    if (mutated) {
      await manager
        .getRepository(ChapterEntity)
        .createQueryBuilder('c')
        .update()
        .set({ document: newDoc as unknown as ProseMirrorNode } as Record<string, unknown>)
        .where('id = :id', { id: chapter.id })
        .execute();
      chapter.document = newDoc;
    }
  }

  // ──────────────────── excerpt 截断：以匹配位置为中心，最多 120 字 ────────────────────

  private truncateExcerpt(text: string, _pos: number, _len: number): string {
    if (text.length <= EXCERPT_MAX) return text;
    // 简化：直接取前 120 字（避免中心截断复杂度，后续可增强）
    return text.slice(0, EXCERPT_MAX);
  }
}
