// M3c-3 知识库 T22 关联 3 端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.2；03-任务规划.md T22
// 职责：关联端点的 controller + 权限（SessionGuard）+ CSRF 防护（写操作）+ 参数校验。
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
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import { knowledgeLinkCreateRequestSchema } from '@storyforge/contracts';
import type { KnowledgeLinkCreateRequest } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeLinksService } from './links.service';

/**
 * 知识库跨条目关联接口层（M3c-3 v1.1 双层库口径）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard），前缀 /api/v1/knowledge：
 * - GET    /entries/:entryId/links   条目的双向关联列表
 * - POST   /links                    手动建立关联
 * - DELETE /links/:linkId            解除关联（幂等）
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeLinksController {
  constructor(
    @Inject(KnowledgeLinksService) private readonly links: KnowledgeLinksService
  ) {}

  // ── 4.2 条目双向关联列表 ──

  @Get('entries/:entryId/links')
  @HttpCode(HttpStatus.OK)
  async listLinks(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string
  ) {
    return ok(request, await this.links.listLinks(request.author.id, entryId));
  }

  // ── 4.2 手动建立关联 ──

  @Post('links')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createLink(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeLinkCreateRequestSchema)) input: KnowledgeLinkCreateRequest
  ) {
    return ok(request, await this.links.createLink(request.author.id, input));
  }

  // ── 4.2 解除关联（幂等） ──

  @Delete('links/:linkId')
  @UseGuards(CsrfGuard)
  async deleteLink(
    @Req() request: AuthenticatedRequest,
    @Param('linkId') linkId: string
  ) {
    return ok(request, await this.links.deleteLink(request.author.id, linkId));
  }
}
