// M3c-3 知识库 · Markdown 导入导出编排 service（F2 §1.4、§4.6、§5.9）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §1.4、§4.6、§5.9
//
// 职责：
//  1. exportMarkdown：条目库 → 逐条 serializeMarkdown → 生成 export_markdown 作业（artifact 存文件）。
//  2. previewImport：Markdown 文件 → parseMarkdown → classifyMarkdownImport → 返回 preview（暂存 preview_id）。
//  3. commitImport：按 conflict policy 写入条目（overwrite/rename/skip）。
//
// 边界：
//  - preview 暂存用 knowledge_jobs（kind='import_markdown'，status='pending'，staging_path 存 JSON）。
//  - 建条目绕过 createEntry（origin='markdown_import'），直接 DataSource repo 插入。
//  - 不执行结构化管线（由 structure 作业异步完成）。
import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  KnowledgeImportPreviewResponse,
  KnowledgeImportCommitRequest,
  KnowledgeConflictPolicy,
  KnowledgeScope,
  KnowledgeEntryType
} from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { hashContent } from './entries.service';
import { parseMarkdown, serializeMarkdown, classifyMarkdownImport } from './portability.markdown';
import type { ParsedMarkdownEntry, MarkdownImportCandidate } from './portability.markdown';

function normalizeTitleKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .slice(0, 120);
}

export interface ExportMarkdownOptions {
  scope: KnowledgeScope;
  work_id?: string | null;
}

export interface ImportFile {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}

interface StagedPreview {
  file_name: string;
  candidates: Array<{ title: string; original_text: string; content_hash: string }>;
  existing: Array<{ title: string; content_hash: string }>;
}

@Injectable()
export class KnowledgePortabilityService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // 导出 Markdown（T25：POST /knowledge/exports）
  // ═══════════════════════════════════════════════════════════════════

  async exportMarkdown(
    authorId: string,
    opts: ExportMarkdownOptions
  ): Promise<{ job_id: string; status: string; file_name: string; entry_count: number }> {
    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const qb = repo.createQueryBuilder('e')
      .where('e.owner_id = :authorId', { authorId })
      .andWhere('e.deleted_at IS NULL')
      .orderBy('e.updated_at', 'DESC');
    if (opts.scope === 'work') {
      qb.andWhere('e.library_scope = :scope AND e.work_id = :workId', {
        scope: opts.scope,
        workId: opts.work_id ?? null
      });
    } else {
      qb.andWhere('e.library_scope = :scope', { scope: 'global' });
    }
    const entries = await qb.getMany();

    // 序列化 Markdown 内容
    const files = entries.map((e) => serializeMarkdown({
      title: e.title,
      type: e.entry_type as KnowledgeEntryType,
      tags: [],
      favorite: e.favorite,
      pinned: e.pinned,
      original_text: e.original_text,
      created_at: e.created_at.toISOString()
    }));
    const content = files.join('\n\n---\n\n');

    // 生成 export_markdown 作业（succeeded，artifact 存内容）
    const jobRepo = this.dataSource.getRepository(KnowledgeJobEntity);
    const job = await jobRepo.save(jobRepo.create({
      id: randomUUID(),
      owner_id: authorId,
      library_scope: opts.scope,
      work_id: opts.scope === 'work' ? (opts.work_id ?? null) : null,
      entry_id: null,
      kind: 'export_markdown',
      status: 'succeeded',
      progress: { stage: 'done', processed: entries.length, total: entries.length, percent: 100 },
      input: { scope: opts.scope, work_id: opts.scope === 'work' ? (opts.work_id ?? null) : null },
      result: { entry_count: entries.length, file_name: this.defaultExportName(opts) },
      error: null,
      staging_path: content,
      artifact_path: content,
      artifact_size: Buffer.byteLength(content),
      artifact_hash: hashContent(content),
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
      file_name: this.defaultExportName(opts),
      entry_count: entries.length
    };
  }

  private defaultExportName(opts: ExportMarkdownOptions): string {
    const prefix = opts.scope === 'work' ? `work-${(opts.work_id ?? 'unknown').slice(0, 8)}` : 'global';
    const date = new Date().toISOString().slice(0, 10);
    return `knowledge-${prefix}-${date}.md`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 导入 preview（T25：POST /knowledge/imports/preview）
  // ═══════════════════════════════════════════════════════════════════

  async previewImport(authorId: string, files: ImportFile[]): Promise<KnowledgeImportPreviewResponse> {
    if (files.length === 0) {
      throw new NotFoundException({ code: 'KNOWLEDGE_FILE_MISSING', message: '未收到任何文件' });
    }

    const candidates: MarkdownImportCandidate[] = [];
    const previewFiles: KnowledgeImportPreviewResponse['files'] = [];
    const conflicts: KnowledgeImportPreviewResponse['conflicts'] = [];

    for (const [index, file] of files.entries()) {
      try {
        const fileName = file.originalname;
        const text = file.buffer.toString('utf8');
        const parsed = parseMarkdown(text, fileName);
        const contentHash = hashContent(parsed.original_text);
        candidates.push({
          title: parsed.title,
          original_text: parsed.original_text,
          content_hash: contentHash
        });
        previewFiles.push({
          file_name: fileName,
          title: parsed.title,
          entry_type: parsed.type,
          excerpt: parsed.original_text.slice(0, 160),
          size: file.buffer.length,
          conflict: 'new'
        });
      } catch (err) {
        const e = err as { response?: { code?: string; message?: string } };
        conflicts.push({
          file_index: index,
          file_name: file.originalname,
          reason: 'duplicate'
        });
        // 保留占位，保证 index 对齐
        void e;
      }
    }

    // 判重：用解析成功候选 + 现有库
    const existing = await this.loadExisting(authorId, 'global');
    const classification = classifyMarkdownImport(candidates, existing);

    // 回填 previewFiles 的 conflict + conflicts 列表
    const finalPreviewFiles: KnowledgeImportPreviewResponse['files'] = [];
    const finalConflicts: KnowledgeImportPreviewResponse['conflicts'] = [];
    for (const [i, cand] of candidates.entries()) {
      const cls = classification[i]!;
      if (cls.conflict_type === 'new') {
        finalPreviewFiles.push({
          file_name: previewFiles[i]!.file_name,
          title: cand.title,
          entry_type: previewFiles[i]!.entry_type,
          excerpt: previewFiles[i]!.excerpt,
          size: previewFiles[i]!.size,
          conflict: 'new'
        });
      } else {
        finalConflicts.push({
          file_index: i,
          file_name: previewFiles[i]!.file_name,
          reason: cls.conflict_type === 'same_content' ? 'duplicate' : 'name_collision'
        });
      }
    }
    // 解析失败的冲突也加入
    for (const c of conflicts) finalConflicts.push(c);

    const duplicate = finalConflicts.filter((c) => c.reason === 'duplicate').length;
    const nameCollision = finalConflicts.filter((c) => c.reason === 'name_collision').length;
    const newCount = finalPreviewFiles.filter((f) => f.conflict === 'new').length;

    // 暂存 preview
    const previewId = await this.stagePreview(authorId, {
      file_name: files[0]!.originalname,
      candidates: candidates.map((c) => ({
        title: c.title,
        original_text: c.original_text,
        content_hash: c.content_hash
      })),
      existing
    });

    return {
      preview_id: previewId,
      files: finalPreviewFiles,
      conflicts: finalConflicts,
      summary: {
        total: files.length,
        duplicate,
        name_collision: nameCollision,
        new: newCount,
        failed: conflicts.length
      }
    };
  }

  private async loadExisting(authorId: string, scope: KnowledgeScope): Promise<Array<{ title: string; content_hash: string }>> {
    const rows = await this.dataSource.getRepository(KnowledgeEntryEntity).createQueryBuilder('e')
      .select(['e.title', 'e.content_hash'])
      .where('e.owner_id = :authorId', { authorId })
      .andWhere('e.deleted_at IS NULL')
      .andWhere('e.library_scope = :scope', { scope })
      .getMany();
    return rows.map((r) => ({ title: r.title, content_hash: r.content_hash }));
  }

  private async stagePreview(authorId: string, staged: StagedPreview): Promise<string> {
    const previewId = randomUUID();
    const jobRepo = this.dataSource.getRepository(KnowledgeJobEntity);
    await jobRepo.save(jobRepo.create({
      id: previewId,
      owner_id: authorId,
      library_scope: 'global',
      work_id: null,
      entry_id: null,
      kind: 'import_markdown',
      status: 'queued',
      progress: { stage: 'preview', processed: 0, total: 0, percent: 0 },
      input: { preview: true },
      result: staged as unknown as Record<string, unknown>,
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
  // 导入 commit（T25：POST /knowledge/imports/commit）
  // ═══════════════════════════════════════════════════════════════════

  async commitImport(
    authorId: string,
    body: Pick<KnowledgeImportCommitRequest, 'preview_id' | 'policy' | 'resolutions'>
  ): Promise<{ job_id: string; status: string; result: { created: number; skipped: number; overwritten: number } }> {
    const preview = await this.dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: body.preview_id });
    if (!preview || preview.owner_id !== authorId || preview.status !== 'queued') {
      throw new NotFoundException({ code: 'KNOWLEDGE_PREVIEW_NOT_FOUND', message: '导入预览不存在或已失效' });
    }

    const staged = preview.result as unknown as StagedPreview;
    if (!staged || !Array.isArray(staged.candidates)) {
      throw new NotFoundException({ code: 'KNOWLEDGE_PREVIEW_NOT_FOUND', message: '导入预览数据无效' });
    }
    const resolutionMap = new Map<number, KnowledgeConflictPolicy>();
    for (const r of body.resolutions ?? []) {
      resolutionMap.set(r.file_index, r.action);
    }

    let created = 0;
    let skipped = 0;
    let overwritten = 0;
    const entryRepo = this.dataSource.getRepository(KnowledgeEntryEntity);

    for (const [index, cand] of staged.candidates.entries()) {
      const policy = resolutionMap.get(index) ?? body.policy;
      const cls = classifyMarkdownImport(
        [cand],
        staged.existing
      )[0]!;

      if (cls.conflict_type === 'same_content') {
        skipped++;
        continue;
      }

      if (cls.conflict_type === 'same_title_diff_content' && policy === 'skip') {
        skipped++;
        continue;
      }

      if (cls.conflict_type === 'same_title_diff_content' && policy === 'rename') {
        // 改名（-2 后缀），按 new 处理
        const newTitle = this.renameTitle(cand.title, staged.existing.map((e) => e.title));
        await this.insertEntry(authorId, { ...cand, title: newTitle });
        created++;
        continue;
      }

      if (cls.conflict_type === 'same_title_diff_content' && policy === 'overwrite') {
        // 覆盖：更新已存在同名条目的内容
        const matched = staged.existing.find((e) => e.title === cand.title);
        if (matched) {
          await entryRepo.update(
            { owner_id: authorId, title: cand.title, deleted_at: null as never },
            { original_text: cand.original_text, content_hash: cand.content_hash, search_text: `${cand.title} ${cand.original_text.slice(0, 2000)}` }
          );
          overwritten++;
          continue;
        }
      }

      // new
      await this.insertEntry(authorId, cand);
      created++;
    }

    // 标记 preview 已完成
    await this.dataSource.getRepository(KnowledgeJobEntity).update(preview.id, { status: 'succeeded' });

    return {
      job_id: preview.id,
      status: 'succeeded',
      result: { created, skipped, overwritten }
    };
  }

  private renameTitle(title: string, existingTitles: string[]): string {
    const set = new Set(existingTitles);
    if (!set.has(title)) return title;
    let n = 2;
    while (set.has(`${title}-${n}`)) n++;
    return `${title}-${n}`;
  }

  private async insertEntry(
    authorId: string,
    cand: { title: string; original_text: string; content_hash: string }
  ): Promise<void> {
    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
    await repo.save(repo.create({
      id: randomUUID(),
      owner_id: authorId,
      library_scope: 'global',
      work_id: null,
      entry_type: 'article',
      title: cand.title.slice(0, 200),
      title_key: normalizeTitleKey(cand.title).slice(0, 120),
      original_text: cand.original_text,
      content_hash: cand.content_hash,
      search_text: `${cand.title} ${cand.original_text.slice(0, 2000)}`,
      structured: null,
      structure_status: 'pending',
      structure_error: null,
      outline_status: null,
      outline: null,
      favorite: false,
      pinned: false,
      pinned_at: null,
      origin: 'markdown_import',
      source_entry_id: null,
      version: 1,
      deleted_at: null,
      deleted_by: null
    }));
  }
}
