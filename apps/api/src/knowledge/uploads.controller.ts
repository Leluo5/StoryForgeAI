// M3c-3 知识库 T24 上传端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5；03-任务规划.md T24
// 职责：POST /knowledge/uploads 的 controller + 权限（SessionGuard）+ CSRF + 参数校验 + 多文件组装。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 KnowledgeIngestService.uploadFiles（T12/T19 已实现），不写新业务逻辑。
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnprocessableEntityException,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  knowledgeEntryTypeSchema,
  knowledgeIdempotencyKeySchema,
  knowledgeScopeSchema,
  KNOWLEDGE_JOB_FILE_COUNT_MAX
} from '@storyforge/contracts';
import type {
  KnowledgeEntryType,
  KnowledgeScope
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeIngestService, type UploadedFile } from './knowledge-ingest.service';

/** multipart 表单体（multer 下经 @Body() 注入，字段为字符串） */
interface UploadFormBody {
  scope?: string;
  work_id?: string;
  entry_type?: string;
  idempotency_key?: string;
}

/**
 * 知识库上传接口层（M3c-3 v1.1 双层库口径）。
 * 路由：POST /api/v1/knowledge/uploads（挂 SessionGuard + CsrfGuard）。
 * 上传 1~10 个文件（multipart），每个文件建一个 ingest 作业，202 Accepted。
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeUploadsController {
  constructor(
    @Inject(KnowledgeIngestService) private readonly ingest: KnowledgeIngestService
  ) {}

  @Post('uploads')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  @UseInterceptors(FilesInterceptor('files', KNOWLEDGE_JOB_FILE_COUNT_MAX, { storage: memoryStorage() }))
  async upload(
    @Req() request: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: UploadFormBody
  ) {
    // ── 表单字段校验（scope 默认 global；work_id/entry_type/idempotency_key 可选） ──
    const scopeParsed = body?.scope !== undefined && body.scope !== ''
      ? knowledgeScopeSchema.safeParse(body.scope)
      : { success: true as const, data: 'global' as KnowledgeScope };
    if (!scopeParsed.success) {
      throw new UnprocessableEntityException({ message: 'Validation failed', details: { field_errors: { scope: ['Invalid scope'] } } });
    }
    const scope = scopeParsed.data;

    let entryType: KnowledgeEntryType | undefined;
    if (body?.entry_type !== undefined && body.entry_type !== '') {
      const et = knowledgeEntryTypeSchema.safeParse(body.entry_type);
      if (!et.success) {
        throw new UnprocessableEntityException({ message: 'Validation failed', details: { field_errors: { entry_type: ['Invalid entry_type'] } } });
      }
      entryType = et.data;
    }

    let workId: string | undefined;
    if (body?.work_id !== undefined && body.work_id !== '') {
      // work_id 仅 work 作用域有意义；统一按 uuid 格式校验
      if (!/^[0-9a-fA-F-]{36}$/.test(body.work_id)) {
        throw new UnprocessableEntityException({ message: 'Validation failed', details: { field_errors: { work_id: ['Invalid work_id'] } } });
      }
      workId = body.work_id;
    }

    let idempotencyKey: string | undefined;
    if (body?.idempotency_key !== undefined && body.idempotency_key !== '') {
      const ik = knowledgeIdempotencyKeySchema.safeParse(body.idempotency_key);
      if (!ik.success) {
        throw new UnprocessableEntityException({ message: 'Validation failed', details: { field_errors: { idempotency_key: ['Invalid idempotency_key'] } } });
      }
      idempotencyKey = ik.data;
    }

    // ── 组装 UploadedFile[]（buffer 已由 memoryStorage 提供） ──
    const uploaded: UploadedFile[] = (files ?? []).map((f) => {
      const item: UploadedFile = { originalname: f.originalname, buffer: f.buffer };
      if (f.mimetype) item.mimetype = f.mimetype;
      if (typeof f.size === 'number') item.size = f.size;
      return item;
    });

    // ── 组装 opts（exactOptionalPropertyTypes：undefined 不显式传） ──
    const opts: { scope: KnowledgeScope; work_id?: string; entry_type?: KnowledgeEntryType; idempotency_key?: string } = { scope };
    if (workId !== undefined) opts.work_id = workId;
    if (entryType !== undefined) opts.entry_type = entryType;
    if (idempotencyKey !== undefined) opts.idempotency_key = idempotencyKey;

    return ok(request, await this.ingest.uploadFiles(request.author.id, uploaded, opts));
  }
}
