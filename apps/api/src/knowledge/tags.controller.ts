// M3c-3 知识库 T22 标签 4 端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.2；03-任务规划.md T22
// 职责：标签端点的 controller + 权限（SessionGuard）+ CSRF 防护（写操作）+ 参数校验。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 service（T15 已实现），不写新业务逻辑。
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
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import {
  knowledgeTagListQuerySchema,
  knowledgeTagRenameRequestSchema,
  knowledgeTagRequestSchema
} from '@storyforge/contracts';
import type {
  KnowledgeTagListQuery,
  KnowledgeTagRenameRequest,
  KnowledgeTagRequest
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeTagsService } from './tags.service';

/**
 * 知识库标签接口层（M3c-3 v1.1 双层库口径）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard），前缀 /api/v1/knowledge：
 * - GET    /tags                标签列表（含各标签条目数）
 * - POST   /tags                新建标签
 * - PATCH  /tags/:tagId         重命名（刷新相关条目 search_text）
 * - DELETE /tags/:tagId         删除标签（级联解除条目关联）
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeTagsController {
  constructor(
    @Inject(KnowledgeTagsService) private readonly tags: KnowledgeTagsService
  ) {}

  // ── 4.2 标签列表（含条目数） ──

  @Get('tags')
  @HttpCode(HttpStatus.OK)
  async listTags(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(knowledgeTagListQuerySchema)) query: KnowledgeTagListQuery
  ) {
    return ok(request, await this.tags.listTags(request.author.id, query.scope, query.work_id));
  }

  // ── 4.2 新建标签 ──

  @Post('tags')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createTag(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeTagRequestSchema)) input: KnowledgeTagRequest
  ) {
    // exactOptionalPropertyTypes：过滤 undefined，避免显式 undefined 传入
    const tagInput: { scope: 'global' | 'work'; work_id?: string; name: string } = {
      scope: input.scope,
      name: input.name
    };
    if (input.work_id !== undefined) tagInput.work_id = input.work_id;
    return ok(request, await this.tags.createTag(request.author.id, tagInput));
  }

  // ── 4.2 重命名（刷新相关条目 search_text） ──

  @Patch('tags/:tagId')
  @UseGuards(CsrfGuard)
  async renameTag(
    @Req() request: AuthenticatedRequest,
    @Param('tagId') tagId: string,
    @Body(new ZodValidationPipe(knowledgeTagRenameRequestSchema)) body: KnowledgeTagRenameRequest
  ) {
    return ok(request, await this.tags.renameTag(request.author.id, tagId, body.name));
  }

  // ── 4.2 删除标签（级联解除条目关联） ──

  @Delete('tags/:tagId')
  @UseGuards(CsrfGuard)
  async deleteTag(
    @Req() request: AuthenticatedRequest,
    @Param('tagId') tagId: string
  ) {
    return ok(request, await this.tags.deleteTag(request.author.id, tagId));
  }
}
