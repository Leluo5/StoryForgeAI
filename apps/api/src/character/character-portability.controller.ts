import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  characterExportQuerySchema,
  characterImportCommitRequestSchema,
  characterImportFileSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CharacterPortabilityService } from './character-portability.service';

type ExportQuery = z.infer<typeof characterExportQuerySchema>;
type ImportFile = z.infer<typeof characterImportFileSchema>;
type ImportCommitRequest = z.infer<typeof characterImportCommitRequestSchema>;

/**
 * M3c-2 角色域导入导出接口（T28，4 个端点）。
 * 导出附带 Content-Disposition；preview 零写业务表；commit 单事务。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterPortabilityController {
  constructor(
    @Inject(CharacterPortabilityService) private readonly portability: CharacterPortabilityService
  ) {}

  @Get('works/:workId/character-portability/export')
  async exportFile(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('workId') workId: string,
    @Query(new ZodValidationPipe(characterExportQuerySchema)) query: ExportQuery
  ) {
    const file = await this.portability.export(request.author.id, workId, {
      include_archived: query.include_archived,
      include_anchors: query.include_anchors
    });
    response.setHeader('Content-Disposition', `attachment; filename="characters-${workId}.json"`);
    return ok(request, file);
  }

  @Post('works/:workId/character-portability/import/preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async preview(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(characterImportFileSchema)) file: ImportFile,
    @Headers('idempotency-key') idempotencyKey?: string
  ) {
    const key = (idempotencyKey ?? '').trim();
    return ok(
      request,
      await this.portability.previewImport(request.author.id, workId, {
        file,
        ...(key ? { idempotency_key: key } : {})
      })
    );
  }

  @Post('works/:workId/character-portability/import/commit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async commit(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(characterImportCommitRequestSchema)) input: ImportCommitRequest
  ) {
    const summary = await this.portability.commitImport(request.author.id, workId, {
      preview_job_id: input.preview_job_id,
      file: input.file,
      idempotency_key: input.idempotency_key,
      mode: input.mode,
      confirm_overwrite: input.confirm_overwrite,
      resolutions: input.resolutions.map((resolution) => ({
        local_id: resolution.local_id,
        action: resolution.action,
        ...(resolution.target_character_id !== undefined
          ? { target_character_id: resolution.target_character_id }
          : {})
      }))
    });
    return ok(request, summary);
  }

  @Get('works/:workId/character-portability/jobs/:jobId')
  async job(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('jobId') jobId: string
  ) {
    const job = await this.portability.getJob(request.author.id, workId, jobId);
    return ok(request, {
      id: job.id,
      work_id: job.work_id,
      kind: job.kind,
      status: job.status,
      schema_version: job.schema_version,
      mode: job.mode,
      idempotency_key: job.idempotency_key,
      summary: job.summary,
      conflicts: job.conflicts,
      error: job.error,
      created_at: job.created_at.toISOString(),
      finished_at: job.finished_at ? job.finished_at.toISOString() : null
    });
  }
}
