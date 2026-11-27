// M4-T9 知识库旧端点迁移：detect-type / similar / markdown-render
// 依据：docs/04-功能交付档案/M4-迁移切换/11-迁移切换技术方案.md §4.3~§4.5
// 职责：三个旧端点的 controller + 权限（SessionGuard）+ CSRF（POST）+ 参数校验。
// 边界（L3 接口层）：只做编排与校验，业务逻辑全在 KnowledgeToolsService，不写新业务逻辑。

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import {
  knowledgeDetectTypeRequestSchema,
  knowledgeMarkdownRenderRequestSchema,
  knowledgeSimilarQuerySchema
} from '@storyforge/contracts';
import type {
  KnowledgeDetectTypeRequest,
  KnowledgeMarkdownRenderRequest,
  KnowledgeSimilarQuery
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeToolsService } from './knowledge-tools.service';

/**
 * 知识库工具接口层（M4-T9，旧端点迁移）。前缀 /api/v1/knowledge：
 * - POST /knowledge/detect-type                  类型判定（复用 classify.ts，含 manual 显式指定）
 * - GET  /knowledge/entries/:entryId/similar      相似条目检索（embedding 余弦 Top-N）
 * - POST /knowledge/markdown/render               正文 Markdown → HTML 预览（纯渲染，不落库）
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeToolsController {
  constructor(
    @Inject(KnowledgeToolsService) private readonly tools: KnowledgeToolsService
  ) {}

  // ── detect-type：类型判定（旧 POST /knowledge/detect-type） ──

  @Post('detect-type')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async detectType(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeDetectTypeRequestSchema)) input: KnowledgeDetectTypeRequest
  ) {
    return ok(request, await this.tools.detectType(input));
  }

  // ── similar：相似条目检索（旧 GET /entries/:id/similar） ──

  @Get('entries/:entryId/similar')
  @HttpCode(HttpStatus.OK)
  async similar(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
    @Query(new ZodValidationPipe(knowledgeSimilarQuerySchema)) query: KnowledgeSimilarQuery
  ) {
    return ok(
      request,
      await this.tools.similar(request.author.id, entryId, { limit: query.limit })
    );
  }

  // ── markdown-render：正文→HTML 预览（旧 POST /markdown/render） ──

  @Post('markdown/render')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async markdownRender(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(knowledgeMarkdownRenderRequestSchema)) input: KnowledgeMarkdownRenderRequest
  ) {
    return ok(request, this.tools.markdownRender(input.text));
  }
}
