import type { CreateWorkRequest, UpdateWorkRequest } from '@storyforge/contracts';
import { createWorkRequestSchema, updateWorkRequestSchema } from '@storyforge/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { WorkService } from './work.service';
import { WorkUploadService } from './work-upload.service';

/** 作品文件上传单批上限（对齐 knowledge 上传 1~10 的口径） */
const WORK_UPLOAD_FILE_COUNT_MAX = 10;

@Controller('works')
@UseGuards(SessionGuard)
export class WorkController {
  constructor(
    @Inject(WorkService) private readonly service: WorkService,
    @Inject(WorkUploadService) private readonly uploadService: WorkUploadService
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query('q') query = '') {
    return ok(request, await this.service.list(request.author.id, query));
  }

  @Post()
  @UseGuards(CsrfGuard)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createWorkRequestSchema)) input: CreateWorkRequest
  ) {
    return ok(request, await this.service.create(request.author.id, input));
  }

  @Patch(':workId')
  @UseGuards(CsrfGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(updateWorkRequestSchema)) input: UpdateWorkRequest
  ) {
    return ok(request, await this.service.update(request.author.id, workId, input));
  }

  // M4-T7 作品文件上传（multipart，1~10 个文件；类型 400 / 超限 413）
  @Post(':workId/upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  @UseInterceptors(FilesInterceptor('files', WORK_UPLOAD_FILE_COUNT_MAX, { storage: memoryStorage() }))
  async upload(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @UploadedFiles() files: Express.Multer.File[]
  ) {
    const uploaded = (files ?? []).map((f) => ({
      originalname: f.originalname,
      buffer: f.buffer
    }));
    return ok(request, await this.uploadService.uploadFiles(request.author.id, workId, uploaded));
  }
}
