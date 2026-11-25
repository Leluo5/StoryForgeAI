// M3c-3 知识库 T24 作业列表/详情端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5；03-任务规划.md T24
// 职责：GET /knowledge/jobs、GET /knowledge/jobs/:jobId 的 controller + 权限（SessionGuard）+ 参数校验 + 视图映射。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 KnowledgeJobService.getJob/listJobs（T12 已实现），不写新业务逻辑。
// 注：技术方案 §4.5 无「取消作业」端点，故不暴露 cancelJob（任务规划 T24 提到的取消幂等以方案为准）。
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { knowledgeJobListQuerySchema } from '@storyforge/contracts';
import type {
  KnowledgeJob,
  KnowledgeJobListQuery,
  KnowledgeJobKind,
  KnowledgeJobStatus,
  KnowledgeScope
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeJobService } from './jobs.processor';
import type { KnowledgeJobEntity } from '../database/knowledge-job.entity';

/** 进度归一化：空对象 → 契约默认值（queued 基线），保证通过 knowledgeJobSchema 校验 */
const DEFAULT_PROGRESS = { stage: 'queued', processed: 0, total: 0, percent: 0 } as const;

/**
 * 知识库作业接口层（M3c-3 v1.1 双层库口径）。
 * 路由体系（均挂 SessionGuard），前缀 /api/v1/knowledge：
 * - GET /jobs              作业列表（scope/work_id/kind/status 过滤 + 游标分页）
 * - GET /jobs/:jobId       作业详情与进度
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeJobsController {
  constructor(
    @Inject(KnowledgeJobService) private readonly jobs: KnowledgeJobService
  ) {}

  // ── §4.5 作业列表 ──

  @Get('jobs')
  @HttpCode(HttpStatus.OK)
  async listJobs(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(knowledgeJobListQuerySchema)) query: KnowledgeJobListQuery
  ) {
    // exactOptionalPropertyTypes：过滤 undefined，避免显式 undefined 传入
    const filter: { scope?: KnowledgeScope; work_id?: string; kind?: string; status?: string } = {};
    if (query.scope !== undefined) filter.scope = query.scope;
    if (query.work_id !== undefined) filter.work_id = query.work_id;
    if (query.kind !== undefined) filter.kind = query.kind;
    if (query.status !== undefined) filter.status = query.status;

    const { items, total, next_cursor } = await this.jobs.listJobs(request.author.id, filter);
    return ok(request, {
      items: items.map((entity) => this.toJobView(entity)),
      total,
      next_cursor
    });
  }

  // ── §4.5 作业详情 ──

  @Get('jobs/:jobId')
  @HttpCode(HttpStatus.OK)
  async getJob(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') jobId: string
  ) {
    const entity = await this.jobs.getJob(jobId);
    // 归属校验：非本人作业一律 404（避免泄露存在性），与 SSE / 下载端点保持一致
    if (entity.owner_id !== request.author.id) {
      throw new NotFoundException({ code: 'KNOWLEDGE_JOB_NOT_FOUND', message: '作业不存在' });
    }
    return ok(request, this.toJobView(entity));
  }

  /**
   * 实体 → 契约视图（KnowledgeJob）。
   * 契约要求 progress 为结构化进度、work_id/entry_id 可选（不接受 null）、created_at ISO。
   */
  private toJobView(entity: KnowledgeJobEntity): KnowledgeJob {
    const progress = entity.progress && Object.keys(entity.progress).length > 0
      ? (entity.progress as KnowledgeJob['progress'])
      : DEFAULT_PROGRESS;
    const view: KnowledgeJob = {
      id: entity.id,
      kind: entity.kind as KnowledgeJobKind,
      status: entity.status as KnowledgeJobStatus,
      library_scope: entity.library_scope as KnowledgeScope,
      progress,
      result: (entity.result as Record<string, unknown>) ?? {},
      error: (entity.error as KnowledgeJob['error']) ?? null,
      created_at: entity.created_at.toISOString(),
      finished_at: entity.finished_at ? entity.finished_at.toISOString() : null
    };
    if (entity.work_id) view.work_id = entity.work_id;
    if (entity.entry_id) view.entry_id = entity.entry_id;
    return view;
  }
}
