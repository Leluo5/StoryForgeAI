// M3c-3 知识库 T23 作品引用与副本 5 端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.4；03-任务规划.md T23
// 职责：作品引用端点的 controller + 权限（SessionGuard）+ CSRF 防护（写操作）+ 参数校验。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 service（T16 已实现），不写新业务逻辑。
// 审计在 service 层注入调用，controller 层不写审计。
// 注意：引用详情不提供 PATCH（§4.4），引用只读由 entries.controller 处理（409 KNOWLEDGE_REF_READONLY）。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards
} from '@nestjs/common';
import {
  knowledgeFlagsRequestSchema,
  knowledgeRefCopyRequestSchema,
  knowledgeRefCreateRequestSchema
} from '@storyforge/contracts';
import type {
  KnowledgeFlagsRequest,
  KnowledgeRefCopyRequest,
  KnowledgeRefCreateRequest
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeRefsService } from './refs.service';

/**
 * 知识库作品引用与副本接口层（M3c-3 v1.1 双层库口径）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard），前缀 /api/v1/works/:workId/knowledge：
 * - GET    /refs                            本作品引用列表（含状态与收藏置顶）
 * - POST   /refs                            批量引用全局条目（{ entry_ids: uuid[] ≤50 }）
 * - DELETE /refs/:refId                     移除引用（不删全局条目，幂等）
 * - PUT    /refs/:refId/flags               引用在当前作品库的收藏/置顶
 * - POST   /refs/:refId/copy                另存为作品副本（可保留引用）
 */
@Controller('works/:workId/knowledge')
@UseGuards(SessionGuard)
export class KnowledgeWorkRefsController {
  constructor(
    @Inject(KnowledgeRefsService) private readonly refs: KnowledgeRefsService
  ) {}

  // ── 4.4 本作品引用列表 ──

  @Get('refs')
  @HttpCode(HttpStatus.OK)
  async listRefs(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string
  ) {
    return ok(request, await this.refs.listRefs(request.author.id, workId));
  }

  // ── 4.4 批量引用全局条目 ──

  @Post('refs')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createRefs(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(knowledgeRefCreateRequestSchema)) input: KnowledgeRefCreateRequest
  ) {
    return ok(request, await this.refs.createRefs(request.author.id, workId, input.entry_ids));
  }

  // ── 4.4 移除引用（不删全局条目，幂等） ──

  @Delete('refs/:refId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async removeRef(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('refId') refId: string
  ) {
    return ok(request, await this.refs.removeRef(request.author.id, workId, refId));
  }

  // ── 4.4 引用在当前作品库的收藏/置顶 ──

  @Put('refs/:refId/flags')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async setRefFlags(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('refId') refId: string,
    @Body(new ZodValidationPipe(knowledgeFlagsRequestSchema)) body: KnowledgeFlagsRequest
  ) {
    // exactOptionalPropertyTypes：过滤 undefined，避免显式 undefined 传入
    const flags: { favorite?: boolean; pinned?: boolean } = {};
    if (body.favorite !== undefined) flags.favorite = body.favorite;
    if (body.pinned !== undefined) flags.pinned = body.pinned;
    return ok(request, await this.refs.setRefFlags(request.author.id, workId, refId, flags));
  }

  // ── 4.4 另存为作品副本 ──

  @Post('refs/:refId/copy')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async copyRef(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('refId') refId: string,
    @Body(new ZodValidationPipe(knowledgeRefCopyRequestSchema)) input: KnowledgeRefCopyRequest
  ) {
    // exactOptionalPropertyTypes：过滤 undefined，避免显式 undefined 传入
    const copyInput: { keep_ref?: boolean; title?: string } = {};
    if (input.keep_ref !== undefined) copyInput.keep_ref = input.keep_ref;
    if (input.title !== undefined) copyInput.title = input.title;
    return ok(request, await this.refs.copyRef(request.author.id, workId, refId, copyInput));
  }
}
