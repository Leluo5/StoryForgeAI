// M3c-3 知识库 T21 条目与库 10 端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.1、§7、§8.1；03-任务规划.md T21
// 职责：条目与库级端点的 controller + 权限（SessionGuard）+ CSRF 防护（写操作）+ 参数校验。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 service（T11/T17/T18 已实现），不写新业务逻辑。
// 审计在 service 层注入调用，controller 层不写审计。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import {
  knowledgeEntryCreateRequestSchema,
  knowledgeEntryPatchRequestSchema,
  knowledgeEntryPurgeRequestSchema,
  knowledgeFlagsRequestSchema,
  knowledgeRestructureRequestSchema,
  knowledgeSearchQuerySchema,
  knowledgeSummaryQuerySchema
} from '@storyforge/contracts';
import type {
  KnowledgeEntryCreateRequest,
  KnowledgeEntryPatchRequest,
  KnowledgeEntryPurgeRequest,
  KnowledgeFlagsRequest,
  KnowledgeRestructureRequest,
  KnowledgeSearchQuery,
  KnowledgeSummaryQuery
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeEntriesService } from './entries.service';
import { KnowledgeTrashService } from './trash.service';
import { KnowledgeIngestService } from './knowledge-ingest.service';
import { KnowledgeRefsService } from './refs.service';

/**
 * 知识库条目与库级接口层（M3c-3 v1.1 双层库口径）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard），前缀 /api/v1/knowledge：
 * - GET    /summary                          库摘要（全局 + 指定作品库）
 * - GET    /entries                          列表/检索（四维 + 时间字段切换 + 收藏置顶 + 回收站 + 游标分页）
 * - POST   /entries                          粘贴录入（同步建条目 + 入队结构化）
 * - GET    /entries/:entryId                 详情（含原文、结构化、大纲、版本）
 * - PATCH  /entries/:entryId                 编辑标题/结构化/大纲/类型/标签（乐观锁）
 * - DELETE /entries/:entryId                 软删除（返回引用作品列表）
 * - POST   /entries/:entryId/restore         从回收站恢复（幂等）
 * - DELETE /entries/:entryId/permanent       彻底删除（confirm=true）
 * - POST   /entries/:entryId/restructure     重试结构化/改判类型后重建
 * - PUT    /entries/:entryId/flags           收藏/置顶
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeEntriesController {
  constructor(
    @Inject(KnowledgeEntriesService) private readonly entries: KnowledgeEntriesService,
    @Inject(KnowledgeTrashService) private readonly trash: KnowledgeTrashService,
    @Inject(KnowledgeIngestService) private readonly ingest: KnowledgeIngestService,
    @Inject(KnowledgeRefsService) private readonly refs: KnowledgeRefsService
  ) {}

  // ── 4.1.1 库摘要 ──

  @Get('summary')
  @HttpCode(HttpStatus.OK)
  async summary(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(knowledgeSummaryQuerySchema)) query: KnowledgeSummaryQuery
  ) {
    const opts: { work_id?: string } = {};
    if (query.work_id !== undefined) opts.work_id = query.work_id;
    return ok(request, await this.entries.summary(request.author.id, opts));
  }

  // ── 4.1.2 列表/检索 ──

  @Get('entries')
  @HttpCode(HttpStatus.OK)
  async listEntries(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(knowledgeSearchQuerySchema)) query: KnowledgeSearchQuery
  ) {
    return ok(request, await this.entries.listEntries(request.author.id, query));
  }

  // ── 4.1.3 粘贴录入（同步建条目 + 入队结构化） ──

  @Post('entries')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createEntry(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeEntryCreateRequestSchema)) input: KnowledgeEntryCreateRequest
  ) {
    const entry = await this.entries.createEntry(request.author.id, input);
    // 入队结构化（allow_structure !== false 时；默认入队，D07）
    if (input.allow_structure !== false) {
      await this.ingest.enqueueRestructure(request.author.id, entry.id, { scope: input.scope });
    }
    return ok(request, entry);
  }

  // ── 4.1.4 详情 ──

  // 详情支持 ?work_id=：带 work_id 从作品库打开（scope='work'），否则按全局库（scope='global'）。
  // 条目维度详情（含原文、结构化、大纲、版本）；引用维度（ref_id/ref_status/favorite/pinned）走作品引用接口（§4.4）。
  @Get('entries/:entryId')
  @HttpCode(HttpStatus.OK)
  async getEntry(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
    @Query('work_id') workId?: string
  ) {
    const scope = workId ? 'work' : 'global';
    return ok(request, await this.entries.getEntry(request.author.id, entryId, { scope }));
  }

  // ── 4.1.5 编辑（乐观锁；引用上下文 409） ──

  @Patch('entries/:entryId')
  @UseGuards(CsrfGuard)
  async updateEntry(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(knowledgeEntryPatchRequestSchema)) patch: KnowledgeEntryPatchRequest
  ) {
    // 引用上下文：若该作品存在指向本条目的引用 → 409 KNOWLEDGE_REF_READONLY
    if (patch.context_work_id) {
      await this.refs.assertNotReadonly(request.author.id, patch.context_work_id, entryId);
    }
    return ok(request, await this.entries.updateEntry(request.author.id, entryId, patch));
  }

  // ── 4.1.6 软删除（返回引用作品列表） ──

  @Delete('entries/:entryId')
  @UseGuards(CsrfGuard)
  async deleteEntry(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string
  ) {
    return ok(request, await this.entries.softDelete(request.author.id, entryId));
  }

  // ── 4.1.7 从回收站恢复（幂等） ──

  @Post('entries/:entryId/restore')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async restoreEntry(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string
  ) {
    return ok(request, await this.trash.restore(request.author.id, entryId));
  }

  // ── 4.1.8 彻底删除（confirm=true） ──

  @Delete('entries/:entryId/permanent')
  @UseGuards(CsrfGuard)
  async purgeEntry(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(knowledgeEntryPurgeRequestSchema)) body: KnowledgeEntryPurgeRequest
  ) {
    return ok(request, await this.trash.purge(request.author.id, entryId, body));
  }

  // ── 4.1.9 重试结构化/改判类型后重建 ──

  @Post('entries/:entryId/restructure')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async restructureEntry(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(knowledgeRestructureRequestSchema)) body: KnowledgeRestructureRequest
  ) {
    // 改判类型（可选）→ 更新条目 entry_type；再入队重建
    if (body.entry_type) {
      await this.entries.updateEntry(request.author.id, entryId, { entry_type: body.entry_type });
    }
    return ok(request, await this.ingest.enqueueRestructure(request.author.id, entryId, { scope: 'global' }));
  }

  // ── 4.1.10 收藏/置顶 ──

  // 注意：引用上下文的收藏/置顶走引用专用接口（refs controller），本端点仅处理条目自身标志。
  @Put('entries/:entryId/flags')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async setFlags(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(knowledgeFlagsRequestSchema)) body: KnowledgeFlagsRequest
  ) {
    // exactOptionalPropertyTypes：过滤 undefined，避免显式 undefined 传入
    const flags: { favorite?: boolean; pinned?: boolean } = {};
    if (body.favorite !== undefined) flags.favorite = body.favorite;
    if (body.pinned !== undefined) flags.pinned = body.pinned;
    return ok(request, await this.entries.setFlags(request.author.id, entryId, flags));
  }
}
