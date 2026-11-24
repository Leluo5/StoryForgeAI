// M3c-3 知识库 · 上传编排 + restructure 编排 service（F2 §1.4、§4.5、§5.3）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §1.4、§4.5、§5.3
//
// 职责：
//  1. 上传编排 uploadFiles：多文件 → 解析 → 建条目（origin='upload'）→ 入队 structure/outline 作业 → 返回 KnowledgeUploadResponse。
//  2. restructure 编排 enqueueRestructure：单条目重新结构化 → 入队 structure 作业（复用同一管线，D07）。
//
// 边界（L3 接口层只消费）：
//  - 建条目绕过 createEntry（createEntry 硬编码 origin='manual'），直接 DataSource repo 插入设置 origin='upload'。
//  - 结构化作业由 worker 消费（knowledge-job.worker.ts）；本 service 只建作业入队，不执行管线。
import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  KnowledgeUploadResponse,
  KnowledgeJobKind,
  KnowledgeEntryType,
  KnowledgeScope
} from '@storyforge/contracts';
import { KNOWLEDGE_JOB_FILE_COUNT_MAX } from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { KnowledgeJobService, computeRequestFingerprint } from './jobs.processor';
import { hashContent } from './entries.service';
import { extractUploadText, cleanUploadFileName } from './upload.parser';

// 归一化标题 key（对齐 entries.service 内部 normalizeTitleKey）
function normalizeTitleKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .slice(0, 120);
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
  size?: number;
}

export interface UploadOptions {
  scope: KnowledgeScope;
  work_id?: string | null;
  entry_type?: KnowledgeEntryType;
  idempotency_key?: string;
}

@Injectable()
export class KnowledgeIngestService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    private readonly jobService: KnowledgeJobService
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // 上传编排（T24：POST /knowledge/uploads multipart）
  // ═══════════════════════════════════════════════════════════════════

  async uploadFiles(
    authorId: string,
    files: UploadedFile[],
    opts: UploadOptions
  ): Promise<KnowledgeUploadResponse> {
    if (files.length === 0) {
      throw new NotFoundException({ code: 'KNOWLEDGE_FILE_MISSING', message: '未收到任何文件' });
    }
    if (files.length > KNOWLEDGE_JOB_FILE_COUNT_MAX) {
      throw new ConflictException({
        code: 'KNOWLEDGE_FILE_COUNT_EXCEEDED',
        message: `单次上传最多 ${KNOWLEDGE_JOB_FILE_COUNT_MAX} 个文件`
      });
    }

    const jobs: KnowledgeUploadResponse['jobs'] = [];
    const rejected: KnowledgeUploadResponse['rejected'] = [];

    for (const file of files) {
      try {
        const fileName = cleanUploadFileName(file.originalname);
        const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
        const parsed = await extractUploadText(ext, file.buffer, fileName, file.mimetype);

        // 建条目（origin='upload'）
        const entry = await this.createUploadedEntry(
          authorId,
          opts,
          fileName,
          parsed.text,
          opts.entry_type
        );

        // 入队结构化作业务
        const job = await this.jobService.createJob({
          ownerId: authorId,
          scope: opts.scope,
          workId: opts.scope === 'work' ? (opts.work_id ?? null) : null,
          entryId: entry.id,
          kind: 'structure' as KnowledgeJobKind,
          input: { entry_id: entry.id, source: 'upload', file_name: fileName },
          ...(opts.idempotency_key
            ? { idempotencyKey: `${opts.idempotency_key}:${entry.id}` }
            : {}),
          requestFingerprint: computeRequestFingerprint({
            kind: 'structure',
            scope: opts.scope,
            workId: opts.scope === 'work' ? (opts.work_id ?? null) : null,
            entryId: entry.id,
            input: { entry_id: entry.id, source: 'upload', file_name: fileName }
          })
        });
        jobs.push({ job_id: job.id, file_name: fileName, status: 'queued' });
      } catch (err) {
        // 单个文件失败不阻塞整批：记录 rejected
        const e = err as { code?: string; message?: string; response?: { code?: string; message?: string } };
        const code = e?.response?.code ?? e?.code ?? 'KNOWLEDGE_PARSE_FAILED';
        const message = e?.response?.message ?? e?.message ?? '解析失败';
        rejected.push({ file_name: cleanUploadFileName(file.originalname), code, message });
      }
    }

    return { jobs, rejected };
  }

  private async createUploadedEntry(
    authorId: string,
    opts: UploadOptions,
    fileName: string,
    text: string,
    entryType?: KnowledgeEntryType
  ): Promise<KnowledgeEntryEntity> {
    const workId = opts.scope === 'work' ? (opts.work_id ?? null) : null;
    const title = (fileName.replace(/\.[^.]+$/, '') || '未命名条目').slice(0, 200);
    const contentHash = hashContent(text);
    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);

    const entity = repo.create({
      id: randomUUID(),
      owner_id: authorId,
      library_scope: opts.scope,
      work_id: workId,
      entry_type: entryType ?? 'article',
      title,
      title_key: normalizeTitleKey(title),
      original_text: text,
      content_hash: contentHash,
      search_text: `${title} ${text.slice(0, 2000)}`,
      structured: null,
      structure_status: 'pending',
      structure_error: null,
      outline_status: null,
      outline: null,
      favorite: false,
      pinned: false,
      pinned_at: null,
      origin: 'upload',
      source_entry_id: null,
      version: 1,
      deleted_at: null,
      deleted_by: null
    });
    return repo.save(entity);
  }

  // ═══════════════════════════════════════════════════════════════════
  // restructure 编排（T21：POST /knowledge/entries/:entryId/restructure）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 重新结构化：校验条目归属 → 检查无运行中 structure 作业 → 入队新作业。
   * 返回作业实体（status='queued'）。
   */
  async enqueueRestructure(authorId: string, entryId: string, opts: { scope: KnowledgeScope }): Promise<{
    job_id: string;
    status: string;
  }> {
    const entry = await this.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: entryId });
    if (!entry || entry.owner_id !== authorId || entry.deleted_at) {
      throw new NotFoundException({ code: 'KNOWLEDGE_ENTRY_NOT_FOUND', message: '知识条目不存在' });
    }

    // 检查该条目是否已有运行中 structure 作业（F2 §5.3：重复触发 409）
    const running = await this.dataSource.getRepository(KnowledgeJobEntity).findOneBy({
      entry_id: entryId,
      kind: 'structure' as const,
      status: 'running' as const
    });
    if (running) {
      throw new ConflictException({ code: 'KNOWLEDGE_JOB_RUNNING', message: '该条目已有运行中的结构化作业' });
    }

    const job = await this.jobService.createJob({
      ownerId: authorId,
      scope: entry.library_scope as KnowledgeScope,
      workId: entry.work_id,
      entryId: entry.id,
      kind: 'structure' as KnowledgeJobKind,
      input: { entry_id: entry.id, source: 'restructure' },
      requestFingerprint: computeRequestFingerprint({
        kind: 'structure',
        scope: entry.library_scope as KnowledgeScope,
        workId: entry.work_id,
        entryId: entry.id,
        input: { entry_id: entry.id, source: 'restructure' }
      })
    });
    return { job_id: job.id, status: job.status };
  }
}
