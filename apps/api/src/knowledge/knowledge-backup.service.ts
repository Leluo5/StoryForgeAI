// M3c-3 知识库 · 整库备份恢复编排 service（F2 §1.4、§4.7、§5.9）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §1.4、§4.7、§5.9
//
// 职责：
//  1. createBackup：条目/标签/关联/引用 → serializeBackupV1 → export_backup 作业（artifact 存产物）。
//  2. restorePreview：备份文件 → parseBackupV1 → classifyBackupRestore → 返回 preview（暂存 preview_id）。
//  3. restoreCommit：按 conflict policy 分批写入（每批 ≤50，失败回滚并累计统计）。
//
// 边界：
//  - preview 暂存用 knowledge_jobs（kind='restore_backup'，status='queued'，result 存暂存，staging_path 置 null）。
//  - 建条目绕过 createEntry（origin='backup'），直接 DataSource repo 插入。
//  - 标签按名称复用或新建；关联仅在两端都成功写入时恢复；引用按 content_hash 尝试重连全局条目。
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  KnowledgeBackup,
  KnowledgeBackupCreateRequest,
  KnowledgeRestorePreviewResponse,
  KnowledgeRestoreCommitRequest,
  KnowledgeConflictPolicy,
  KnowledgeScope
} from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeEntryLinkEntity } from '../database/knowledge-entry-link.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { serializeBackupV1, parseBackupV1, classifyBackupRestore } from './portability.backup';

function normalizeTitleKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .slice(0, 120);
}

export interface BackupFile {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}

interface StagedBackup {
  file_name: string;
  backup: KnowledgeBackup;
  existing: Array<{ title: string; content_hash: string }>;
  classification: Array<{ entry_index: number; conflict_type: 'same_content' | 'same_title_diff_content' | 'new' }>;
}

const BATCH_SIZE = 50;

// 备份产物落盘目录（参照 character-avatar.service L19 的 STORYFORGE_AVATAR_DIR 范式）
// 技术方案 §4.7 + A8：导出产物写入 KNOWLEDGE_BACKUP_DIR，文件名含作业 id 与哈希
const BACKUP_STORAGE_DIR = process.env.STORYFORGE_BACKUP_DIR ?? 'data/knowledge-backups';

@Injectable()
export class KnowledgeBackupService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // 创建备份（T26：POST /knowledge/backups）
  // ═══════════════════════════════════════════════════════════════════

  async createBackup(
    authorId: string,
    body: KnowledgeBackupCreateRequest
  ): Promise<{ job_id: string; status: string; file_name: string; entry_count: number }> {
    const backup = await this.collectBackup(authorId, body.scope, body.work_id ?? null);
    const artifact = serializeBackupV1(backup);

    const jobRepo = this.dataSource.getRepository(KnowledgeJobEntity);
    const fileName = this.defaultBackupName(body.scope);

    // 补漏：gzip 产物落盘（技术方案 §4.7 + A8）。文件名含作业 id 与内容哈希。
    // 写盘失败不阻塞创建（try/catch），失败时 artifact_path=null（下载端点 404）。
    let artifactPath: string | null = null;
    let artifactHash: string | null = null;
    try {
      const fileId = randomUUID();
      const contentHash = createHash('sha256').update(artifact).digest('hex');
      artifactHash = contentHash;
      artifactPath = resolve(BACKUP_STORAGE_DIR, `${fileId}-${contentHash.slice(0, 12)}.kb.gz`);
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, artifact);
    } catch {
      artifactPath = null;
      artifactHash = null;
    }

    const job = await jobRepo.save(jobRepo.create({
      id: randomUUID(),
      owner_id: authorId,
      library_scope: body.scope,
      work_id: body.scope === 'work' ? (body.work_id ?? null) : null,
      entry_id: null,
      kind: 'export_backup',
      status: 'succeeded',
      progress: { stage: 'done', processed: backup.entries.length, total: backup.entries.length, percent: 100 },
      input: { scope: body.scope, work_id: body.scope === 'work' ? (body.work_id ?? null) : null },
      result: { entry_count: backup.entries.length, file_name: fileName, uncompressed_bytes: artifact.length },
      error: null,
      staging_path: null,
      artifact_path: artifactPath,
      artifact_size: artifact.length,
      artifact_hash: artifactHash,
      idempotency_key: null,
      event_seq: 0,
      created_by: authorId,
      created_at: new Date(),
      started_at: new Date(),
      finished_at: new Date()
    }));

    return {
      job_id: job.id,
      status: job.status,
      file_name: fileName,
      entry_count: backup.entries.length
    };
  }

  private async collectBackup(authorId: string, scope: KnowledgeScope, workId: string | null): Promise<KnowledgeBackup> {
    const entryRepo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const qb = entryRepo.createQueryBuilder('e')
      .where('e.owner_id = :authorId', { authorId })
      .andWhere('e.deleted_at IS NULL')
      .orderBy('e.created_at', 'ASC');
    if (scope === 'work') {
      qb.andWhere('e.library_scope = :scope AND e.work_id = :workId', { scope, workId });
    } else {
      qb.andWhere('e.library_scope = :scope', { scope: 'global' });
    }
    const entries = await qb.getMany();

    // 标签
    const tagRepo = this.dataSource.getRepository(KnowledgeTagEntity);
    const tagQb = tagRepo.createQueryBuilder('t').where('t.owner_id = :authorId', { authorId });
    if (scope === 'work') {
      tagQb.andWhere('t.library_scope = :scope AND t.work_id = :workId', { scope, workId });
    } else {
      tagQb.andWhere('t.library_scope = :scope', { scope: 'global' });
    }
    const tags = await tagQb.orderBy('t.name', 'ASC').getMany();
    const tagNameById = new Map(tags.map((t) => [t.id, t.name]));

    // 条目-标签关联
    const entryIds = entries.map((e) => e.id);
    const linkTagRepo = this.dataSource.getRepository(KnowledgeEntryTagEntity);
    const entryTags = entryIds.length > 0
      ? await linkTagRepo.createQueryBuilder('et').where('et.entry_id IN (:...ids)', { ids: entryIds }).getMany()
      : [];
    const tagNamesByEntry = new Map<string, string[]>();
    for (const et of entryTags) {
      const name = tagNameById.get(et.tag_id);
      if (!name) continue;
      const list = tagNamesByEntry.get(et.entry_id) ?? [];
      list.push(name);
      tagNamesByEntry.set(et.entry_id, list);
    }

    // 关联（两端都在条目内）
    const linkRepo = this.dataSource.getRepository(KnowledgeEntryLinkEntity);
    const linkQb = linkRepo.createQueryBuilder('l').where('l.owner_id = :authorId', { authorId });
    if (scope === 'work') {
      linkQb.andWhere('l.library_scope = :scope AND l.work_id = :workId', { scope, workId });
    } else {
      linkQb.andWhere('l.library_scope = :scope', { scope: 'global' });
    }
    const links = await linkQb.getMany();
    const entryIdSet = new Set(entryIds);
    const localIdByEntryId = new Map(entries.map((e, i) => [e.id, `e${i + 1}`]));

    // 引用（仅作品库）
    const refRepo = this.dataSource.getRepository(KnowledgeWorkRefEntity);
    const refs = scope === 'work'
      ? await refRepo.find({ where: { owner_id: authorId, work_id: workId ?? '' } as never })
      : [];

    const backup: KnowledgeBackup = {
      schema_version: 1,
      kind: 'knowledge-backup',
      exported_at: new Date().toISOString(),
      library: { scope, work_id: workId, work_title: null },
      entries: entries.map((e, i) => ({
        local_id: `e${i + 1}`,
        entry_type: e.entry_type as KnowledgeBackup['entries'][number]['entry_type'],
        title: e.title,
        original_text: e.original_text,
        content_hash: e.content_hash.trim(),
        structured: (e.structured ?? null) as KnowledgeBackup['entries'][number]['structured'],
        outline: (e.outline ?? null) as KnowledgeBackup['entries'][number]['outline'],
        structure_status: e.structure_status as KnowledgeBackup['entries'][number]['structure_status'],
        outline_status: (e.outline_status ?? null) as KnowledgeBackup['entries'][number]['outline_status'],
        origin: e.origin as KnowledgeBackup['entries'][number]['origin'],
        favorite: e.favorite,
        pinned: e.pinned,
        tags: tagNamesByEntry.get(e.id) ?? [],
        created_at: e.created_at.toISOString()
      })),
      tags: tags.map((t) => ({ name: t.name })),
      links: links
        .filter((l) => entryIdSet.has(l.source_entry_id) && entryIdSet.has(l.target_entry_id))
        .map((l) => ({
          source_local_id: localIdByEntryId.get(l.source_entry_id)!,
          target_local_id: localIdByEntryId.get(l.target_entry_id)!,
          kind: l.kind as KnowledgeBackup['links'][number]['kind'],
          ...(l.score != null ? { score: Number(l.score) } : {})
        })),
      refs: refs.map((r) => ({
        entry_content_hash: r.entry_id ? this.hashOf(entries, r.entry_id) : '',
        snapshot_title: r.snapshot_title,
        favorite: r.favorite,
        pinned: r.pinned
      }))
    };
    return backup;
  }

  private hashOf(entries: KnowledgeEntryEntity[], entryId: string): string {
    return entries.find((e) => e.id === entryId)?.content_hash ?? '';
  }

  private defaultBackupName(scope: KnowledgeScope): string {
    const prefix = scope === 'work' ? 'work' : 'global';
    const date = new Date().toISOString().slice(0, 10);
    return `knowledge-${prefix}-${date}.kb.gz`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 恢复 preview（T26：POST /knowledge/backups/restore/preview）
  // ═══════════════════════════════════════════════════════════════════

  async restorePreview(authorId: string, file: BackupFile): Promise<KnowledgeRestorePreviewResponse> {
    const backup = parseBackupV1(file.buffer);

    const existing = await this.loadExisting(authorId, backup.library.scope, backup.library.work_id);
    const classification = classifyBackupRestore(backup.entries, existing);

    const conflicts: KnowledgeRestorePreviewResponse['conflicts'] = [];
    const summary = { total: backup.entries.length, same_content: 0, same_title_diff_content: 0, new: 0 };
    for (const c of classification) {
      const entry = backup.entries[c.entry_index]!;
      if (c.conflict_type === 'same_content') {
        summary.same_content++;
        conflicts.push({
          entry_index: c.entry_index,
          local_id: entry.local_id,
          title: entry.title,
          type: 'same_content',
          existing_entry_id: existing.find((e) => e.content_hash === entry.content_hash)?.entry_id,
          existing_title: existing.find((e) => e.content_hash === entry.content_hash)?.title
        });
      } else if (c.conflict_type === 'same_title_diff_content') {
        summary.same_title_diff_content++;
        conflicts.push({
          entry_index: c.entry_index,
          local_id: entry.local_id,
          title: entry.title,
          type: 'same_title_diff_content',
          existing_entry_id: existing.find((e) => e.title === entry.title)?.entry_id,
          existing_title: existing.find((e) => e.title === entry.title)?.title
        });
      } else {
        summary.new++;
      }
    }

    const previewId = await this.stagePreview(authorId, file.originalname, backup, existing, classification);

    return {
      preview_id: previewId,
      file_name: file.originalname,
      uncompressed_bytes: file.buffer.length,
      summary,
      conflicts
    };
  }

  private async loadExisting(authorId: string, scope: KnowledgeScope, workId: string | null) {
    const qb = this.dataSource.getRepository(KnowledgeEntryEntity).createQueryBuilder('e')
      .select(['e.id', 'e.title', 'e.content_hash'])
      .where('e.owner_id = :authorId', { authorId })
      .andWhere('e.deleted_at IS NULL');
    if (scope === 'work') {
      qb.andWhere('e.library_scope = :scope AND e.work_id = :workId', { scope, workId });
    } else {
      qb.andWhere('e.library_scope = :scope', { scope: 'global' });
    }
    const rows = await qb.getMany();
    // char(64) 列 Postgres 右填充空格，需 trim 才能与 schema trim 后的哈希一致
    return rows.map((r) => ({ entry_id: r.id, title: r.title, content_hash: r.content_hash.trim() }));
  }

  private async stagePreview(
    authorId: string,
    fileName: string,
    backup: KnowledgeBackup,
    existing: Array<{ entry_id: string; title: string; content_hash: string }>,
    classification: StagedBackup['classification']
  ): Promise<string> {
    const previewId = randomUUID();
    const jobRepo = this.dataSource.getRepository(KnowledgeJobEntity);
    await jobRepo.save(jobRepo.create({
      id: previewId,
      owner_id: authorId,
      library_scope: backup.library.scope,
      work_id: backup.library.work_id,
      entry_id: null,
      kind: 'restore_backup',
      status: 'queued',
      progress: { stage: 'preview', processed: 0, total: backup.entries.length, percent: 0 },
      input: { preview: true },
      result: { file_name: fileName, backup, existing, classification } as unknown as Record<string, unknown>,
      error: null,
      staging_path: null,
      artifact_path: null,
      artifact_size: 0,
      artifact_hash: null,
      idempotency_key: null,
      event_seq: 0,
      created_by: authorId,
      created_at: new Date(),
      started_at: null,
      finished_at: null
    }));
    return previewId;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 恢复 commit（T26：POST /knowledge/backups/restore/commit）
  // ═══════════════════════════════════════════════════════════════════

  async restoreCommit(
    authorId: string,
    body: Pick<KnowledgeRestoreCommitRequest, 'preview_id' | 'policy' | 'resolutions'>
  ): Promise<{ job_id: string; status: string; result: { succeeded: number; failed: number; skipped: number } }> {
    const preview = await this.dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: body.preview_id });
    if (!preview || preview.owner_id !== authorId || preview.status !== 'queued') {
      throw new NotFoundException({ code: 'KNOWLEDGE_PREVIEW_NOT_FOUND', message: '恢复预览不存在或已失效' });
    }

    const staged = preview.result as unknown as StagedBackup;
    if (!staged || !Array.isArray(staged.backup?.entries)) {
      throw new NotFoundException({ code: 'KNOWLEDGE_PREVIEW_NOT_FOUND', message: '恢复预览数据无效' });
    }

    const resolutionMap = new Map<number, KnowledgeConflictPolicy>();
    for (const r of body.resolutions ?? []) {
      resolutionMap.set(r.entry_index, r.action);
    }

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    const backup = staged.backup;
    const existing = staged.existing;
    const entryRepo = this.dataSource.getRepository(KnowledgeEntryEntity);

    // 分批事务，每批 ≤50；失败批次回滚并累计统计
    const entries = backup.entries;
    for (let start = 0; start < entries.length; start += BATCH_SIZE) {
      const batch = entries.slice(start, start + BATCH_SIZE);
      try {
        await this.dataSource.transaction(async (manager) => {
          const entryIdByLocalId = new Map<string, string>();
          for (const entry of batch) {
            const policy = resolutionMap.get(start + batch.indexOf(entry)) ?? body.policy;
            const cls = classifyBackupRestore([entry], existing)[0]!;

            if (cls.conflict_type === 'same_content') {
              skipped++;
              continue;
            }
            if (cls.conflict_type === 'same_title_diff_content' && policy === 'skip') {
              skipped++;
              continue;
            }

            // 写入条目（绕过 createEntry，origin='backup'）
            const entryRepoM = manager.getRepository(KnowledgeEntryEntity);
            const id = randomUUID();
            const title = cls.conflict_type === 'same_title_diff_content' && policy === 'rename'
              ? this.renameTitle(entry.title, existing.map((e) => e.title))
              : entry.title;
            await entryRepoM.save(entryRepoM.create({
              id,
              owner_id: authorId,
              library_scope: backup.library.scope,
              work_id: backup.library.scope === 'work' ? backup.library.work_id : null,
              entry_type: entry.entry_type,
              title: title.slice(0, 200),
              title_key: normalizeTitleKey(title).slice(0, 120),
              original_text: entry.original_text,
              content_hash: entry.content_hash,
              search_text: `${title} ${entry.original_text.slice(0, 2000)}`,
              structured: entry.structured,
              structure_status: entry.structure_status,
              structure_error: null,
              outline_status: entry.outline_status,
              outline: entry.outline,
              favorite: entry.favorite,
              pinned: entry.pinned,
              pinned_at: entry.pinned ? new Date() : null,
              origin: 'backup',
              source_entry_id: null,
              version: 1,
              deleted_at: null,
              deleted_by: null
            }));
            entryIdByLocalId.set(entry.local_id, id);

            // 标签复用或新建
            await this.attachTags(manager, authorId, id, entry.tags, backup.library.scope, backup.library.work_id);
            succeeded++;
          }

          // 关联恢复（仅两端都成功写入）
          const linkRepoM = manager.getRepository(KnowledgeEntryLinkEntity);
          for (const link of backup.links) {
            const sourceId = entryIdByLocalId.get(link.source_local_id);
            const targetId = entryIdByLocalId.get(link.target_local_id);
            if (!sourceId || !targetId) continue;
            await linkRepoM.save(linkRepoM.create({
              id: randomUUID(),
              owner_id: authorId,
              library_scope: backup.library.scope,
              work_id: backup.library.scope === 'work' ? backup.library.work_id : null,
              source_entry_id: sourceId,
              target_entry_id: targetId,
              kind: link.kind,
              score: link.score != null ? String(link.score) : null,
              created_by: authorId
            }));
          }
        });
      } catch (err) {
        // 批次失败回滚，计入 failed，不整体回滚已成功批次
        failed += batch.length;
        void err;
      }
    }

    // 标记 preview 已完成
    await this.dataSource.getRepository(KnowledgeJobEntity).update(preview.id, { status: 'succeeded' });

    return {
      job_id: preview.id,
      status: 'succeeded',
      result: { succeeded, failed, skipped }
    };
  }

  private async attachTags(
    manager: import('typeorm').EntityManager,
    authorId: string,
    entryId: string,
    tagNames: string[],
    scope: KnowledgeScope,
    workId: string | null
  ): Promise<void> {
    const tagRepo = manager.getRepository(KnowledgeTagEntity);
    const linkRepo = manager.getRepository(KnowledgeEntryTagEntity);
    for (const name of tagNames.slice(0, 20)) {
      const nameKey = normalizeTitleKey(name).slice(0, 40) || name.trim().slice(0, 40);
      let tag = await tagRepo.findOneBy({ owner_id: authorId, library_scope: scope, name_key: nameKey, work_id: workId ?? null } as never);
      if (!tag) {
        tag = await tagRepo.save(tagRepo.create({
          id: randomUUID(),
          owner_id: authorId,
          library_scope: scope,
          work_id: scope === 'work' ? workId : null,
          name: name.trim().slice(0, 40),
          name_key: nameKey
        }));
      }
      // 防重复关联
      const exists = await linkRepo.findOneBy({ entry_id: entryId, tag_id: tag.id } as never);
      if (!exists) {
        await linkRepo.save(linkRepo.create({ entry_id: entryId, tag_id: tag.id }));
      }
    }
  }

  private renameTitle(title: string, existingTitles: string[]): string {
    const set = new Set(existingTitles);
    if (!set.has(title)) return title;
    let n = 2;
    while (set.has(`${title}-${n}`)) n++;
    return `${title}-${n}`;
  }
}
