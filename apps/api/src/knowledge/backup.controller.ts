// M3c-3 知识库 T26 整库备份恢复 4 端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.7；03-任务规划.md T26
// 职责：POST /knowledge/backups、GET /knowledge/backups/:jobId/download、
//       POST /knowledge/backups/restore/preview、POST /knowledge/backups/restore/commit 的
//       controller + 权限（SessionGuard）+ CSRF（写操作）+ 参数校验 + 产物下载。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 KnowledgeBackupService（已实现）
//       与 KnowledgeJobService.getJob（T12 已实现），不写新业务逻辑。
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { readFile } from 'node:fs/promises';
import type { Response } from 'express';
import {
  knowledgeBackupCreateRequestSchema,
  knowledgeRestoreCommitRequestSchema
} from '@storyforge/contracts';
import type {
  KnowledgeBackupCreateRequest,
  KnowledgeConflictPolicy,
  KnowledgeRestoreCommitRequest
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeBackupService, type BackupFile } from './knowledge-backup.service';
import { KnowledgeJobService } from './jobs.processor';

/** 备份导出作业 kind（与技术方案 §3.2 枚举一致） */
const EXPORT_BACKUP_KIND = 'export_backup';
/** 下载文件名兜底（result.file_name 缺失/非法时） */
const DEFAULT_BACKUP_NAME = 'knowledge-backup.kb.gz';

/**
 * 知识库整库备份恢复接口层（M3c-3 v1.1 双层库口径）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard），前缀 /api/v1/knowledge：
 * - POST /knowledge/backups                       创建备份（202）
 * - GET  /knowledge/backups/:jobId/download       下载备份产物（200，Buffer 流）
 * - POST /knowledge/backups/restore/preview       恢复预览（200）
 * - POST /knowledge/backups/restore/commit        恢复提交（202）
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeBackupController {
  constructor(
    @Inject(KnowledgeBackupService) private readonly backup: KnowledgeBackupService,
    @Inject(KnowledgeJobService) private readonly jobs: KnowledgeJobService
  ) {}

  // ── §4.7 创建备份（202 Accepted） ──

  @Post('backups')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async createBackup(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeBackupCreateRequestSchema)) input: KnowledgeBackupCreateRequest
  ) {
    return ok(request, await this.backup.createBackup(request.author.id, input));
  }

  // ── §4.7 下载备份产物（200，Buffer 流） ──

  @Get('backups/:jobId/download')
  @HttpCode(HttpStatus.OK)
  async downloadBackup(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') jobId: string,
    @Res() response: Response
  ): Promise<void> {
    const job = await this.jobs.getJob(jobId);
    // 归属校验：非本人作业一律 404（避免泄露存在性）
    if (job.owner_id !== request.author.id) {
      throw new NotFoundException({
        code: 'KNOWLEDGE_JOB_NOT_FOUND',
        message: '作业不存在'
      });
    }
    // 类型校验：非备份导出作业不可下载（409 语义更贴近「冲突」）
    if (job.kind !== EXPORT_BACKUP_KIND) {
      throw new ConflictException({
        code: 'KNOWLEDGE_JOB_KIND_MISMATCH',
        message: '作业类型不支持下载'
      });
    }

    // 产物路径：artifact_path 为磁盘绝对路径；无产物 → 404
    const filePath = job.artifact_path;
    if (!filePath) {
      throw new NotFoundException({
        code: 'KNOWLEDGE_ARTIFACT_NOT_FOUND',
        message: '备份产物不存在'
      });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      throw new NotFoundException({
        code: 'KNOWLEDGE_ARTIFACT_NOT_FOUND',
        message: '备份产物不存在'
      });
    }

    // 文件名：优先 result.file_name（jsonb 安全取值），非法则兜底
    const result = (job.result as Record<string, unknown> | null | undefined) ?? {};
    const fileName = typeof result.file_name === 'string' && result.file_name.length > 0
      ? result.file_name
      : DEFAULT_BACKUP_NAME;

    response.setHeader('Content-Type', 'application/gzip');
    // 中文文件名经 encodeURIComponent 编码，避免 header 非法字符
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    response.setHeader('Content-Length', String(bytes.length));
    response.send(bytes);
  }

  // ── §4.7 恢复预览（200） ──

  @Post('backups/restore/preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  @UseInterceptors(FilesInterceptor('file', 1, { storage: memoryStorage() }))
  async previewRestore(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file?: Express.Multer.File
  ) {
    // 空文件 → 422（KNOWLEDGE_FILE_MISSING）
    if (!file) {
      throw new UnprocessableEntityException({
        code: 'KNOWLEDGE_FILE_MISSING',
        message: '未收到任何文件'
      });
    }
    const mapped: BackupFile = { originalname: file.originalname, buffer: file.buffer };
    if (file.mimetype) mapped.mimetype = file.mimetype;

    return ok(request, await this.backup.restorePreview(request.author.id, mapped));
  }

  // ── §4.7 恢复提交（202 Accepted） ──

  @Post('backups/restore/commit')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async commitRestore(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeRestoreCommitRequestSchema)) input: KnowledgeRestoreCommitRequest
  ) {
    // exactOptionalPropertyTypes：resolutions 未提供时不显式传 undefined
    const body: { preview_id: string; policy: KnowledgeConflictPolicy; resolutions?: KnowledgeRestoreCommitRequest['resolutions'] } = {
      preview_id: input.preview_id,
      policy: input.policy
    };
    if (input.resolutions !== undefined) body.resolutions = input.resolutions;

    return ok(request, await this.backup.restoreCommit(request.author.id, body));
  }
}
