// M3c-3 知识库 T25 导入导出 4 端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.6；03-任务规划.md T25
// 职责：POST /knowledge/exports、GET /knowledge/exports/:jobId/download、
//       POST /knowledge/imports/preview、POST /knowledge/imports/commit 的
//       controller + 权限（SessionGuard）+ CSRF（写操作）+ 参数校验 + 文件下载流。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 KnowledgePortabilityService（T25 已实现）
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
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import {
  knowledgeExportRequestSchema,
  knowledgeImportCommitRequestSchema,
  KNOWLEDGE_JOB_FILE_COUNT_MAX
} from '@storyforge/contracts';
import type {
  KnowledgeConflictPolicy,
  KnowledgeExportRequest,
  KnowledgeImportCommitRequest,
  KnowledgeScope
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgePortabilityService, type ImportFile } from './knowledge-portability.service';
import { KnowledgeJobService } from './jobs.processor';

/** 导出作业 kind（与技术方案 §3.2 枚举一致） */
const EXPORT_MARKDOWN_KIND = 'export_markdown';
/** 下载文件名兜底（result.file_name 缺失/非法时） */
const DEFAULT_EXPORT_NAME = 'knowledge-export.md';

/**
 * 知识库导入导出接口层（M3c-3 v1.1 双层库口径）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard），前缀 /api/v1/knowledge：
 * - POST /knowledge/exports                       导出 Markdown（202）
 * - GET  /knowledge/exports/:jobId/download       下载导出产物（200，流式）
 * - POST /knowledge/imports/preview               导入预览（200）
 * - POST /knowledge/imports/commit                导入提交（202）
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgePortabilityController {
  constructor(
    @Inject(KnowledgePortabilityService) private readonly portability: KnowledgePortabilityService,
    @Inject(KnowledgeJobService) private readonly jobs: KnowledgeJobService
  ) {}

  // ── §4.6 导出 Markdown（202 Accepted） ──

  @Post('exports')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async exportMarkdown(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeExportRequestSchema)) input: KnowledgeExportRequest
  ) {
    // exactOptionalPropertyTypes：work_id 未提供时不显式传 undefined
    const opts: { scope: KnowledgeScope; work_id?: string } = { scope: input.scope };
    if (input.work_id !== undefined) opts.work_id = input.work_id;

    return ok(request, await this.portability.exportMarkdown(request.author.id, opts));
  }

  // ── §4.6 下载导出产物（200，流式） ──

  @Get('exports/:jobId/download')
  @HttpCode(HttpStatus.OK)
  async downloadExport(
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
    // 类型校验：非导出作业不可下载（409 语义更贴近「冲突」）
    if (job.kind !== EXPORT_MARKDOWN_KIND) {
      throw new ConflictException({
        code: 'KNOWLEDGE_JOB_KIND_MISMATCH',
        message: '作业类型不支持下载'
      });
    }

    // 导出内容：staging_path / artifact_path 均存 content（字符串），兜底空串
    const content: string = job.staging_path ?? job.artifact_path ?? '';
    const size = Buffer.byteLength(content, 'utf8');

    // 文件名：优先 result.file_name（jsonb 安全取值），非法则兜底
    const result = (job.result as Record<string, unknown> | null | undefined) ?? {};
    const fileName = typeof result.file_name === 'string' && result.file_name.length > 0
      ? result.file_name
      : DEFAULT_EXPORT_NAME;

    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    // 中文文件名经 encodeURIComponent 编码，避免 header 非法字符
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    response.setHeader('Content-Length', String(size));
    response.send(content);
  }

  // ── §4.6 导入预览（200） ──

  @Post('imports/preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  @UseInterceptors(FilesInterceptor('files', KNOWLEDGE_JOB_FILE_COUNT_MAX, { storage: memoryStorage() }))
  async previewImport(
    @Req() request: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[]
  ) {
    // 空文件：previewImport 内部抛 404 KNOWLEDGE_FILE_MISSING，直接透传
    const importFiles: ImportFile[] = (files ?? []).map((f) => {
      const item: ImportFile = { originalname: f.originalname, buffer: f.buffer };
      if (f.mimetype) item.mimetype = f.mimetype;
      return item;
    });

    return ok(request, await this.portability.previewImport(request.author.id, importFiles));
  }

  // ── §4.6 导入提交（202 Accepted） ──

  @Post('imports/commit')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async commitImport(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeImportCommitRequestSchema)) input: KnowledgeImportCommitRequest
  ) {
    // exactOptionalPropertyTypes：resolutions 未提供时不显式传 undefined
    const body: { preview_id: string; policy: KnowledgeConflictPolicy; resolutions?: KnowledgeImportCommitRequest['resolutions'] } = {
      preview_id: input.preview_id,
      policy: input.policy
    };
    if (input.resolutions !== undefined) body.resolutions = input.resolutions;

    return ok(request, await this.portability.commitImport(request.author.id, body));
  }
}
