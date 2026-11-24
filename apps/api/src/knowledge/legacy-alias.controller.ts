import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import {
  commitKnowledgeEntryRequestSchema,
  exportKnowledgeMarkdownRequestSchema,
  extractOutlineRequestSchema,
  importKnowledgePreviewRequestSchema,
  importKnowledgeRequestSchema,
  linkKnowledgeRequestSchema
} from '@storyforge/contracts';
import type {
  CommitKnowledgeEntryRequest,
  ExportKnowledgeMarkdownRequest,
  ExtractOutlineRequest,
  ImportKnowledgePreviewRequest,
  ImportKnowledgeRequest,
  LinkKnowledgeRequest
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeOutlineService } from './knowledge-outline.service';
import { KnowledgeMarkdownService } from './knowledge-markdown.service';
import { buildFilename, buildZip } from './knowledge-markdown.service';

/**
 * 旧一代知识库端点兼容别名（T27 · F4 编码实现 L3 收官）。
 *
 * 背景：旧 knowledge.controller.ts（@Controller('knowledge')）与新知识库模块
 * 控制器路由部分冲突。用户已决策：**新语义取代旧预览**——
 *   - 旧 POST /knowledge/entries（统一录入生成预览）与 GET /knowledge/entries（检索）
 *     被新 entries.controller 的 POST/GET /knowledge/entries 取代，不保留（同名同法无法并存）。
 *   - 其余旧端点保留为兼容别名：统一挂 @deprecated 标记 + 响应头
 *     `X-Knowledge-Deprecated: true`，供旧客户端平滑迁移。
 *
 * 本控制器只定义 7 条**非冲突**旧端点，逻辑复用旧一代 service（不改业务逻辑），
 * 与 T21-T26 新控制器路由不重复（静态分析已确认无同名同法）。
 *
 * @deprecated 旧一代端点，新客户端请迁移至新知识库接口（T21-T26）。
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeLegacyAliasController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(KnowledgeOutlineService) private readonly outline: KnowledgeOutlineService,
    @Inject(KnowledgeMarkdownService) private readonly markdown: KnowledgeMarkdownService
  ) {}

  /** 统一给兼容端点打上弃用响应头 */
  private markDeprecated(res: Response): void {
    res.setHeader('X-Knowledge-Deprecated', 'true');
  }

  // ── 旧 3.2 确认入库（幂等） ──

  /**
   * @deprecated 旧一代提交接口。新客户端请改用新知识库录入（POST /knowledge/entries）。
   */
  @Post('entries/:id/commit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async commitEntry(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(commitKnowledgeEntryRequestSchema)) input: CommitKnowledgeEntryRequest
  ) {
    this.markDeprecated(res);
    // 幂等入库：同 author + content_hash 已存在返回已有
    const result = await this.knowledge.commit(request.author.id, input);
    return ok(request, { id: result.id, status: result.status });
  }

  // ── 旧 3.7 建立关联 ──

  /**
   * @deprecated 旧一代关联接口。新客户端请改用新知识库关联（POST /knowledge/links）。
   */
  @Post('entries/:id/link')
  @UseGuards(CsrfGuard)
  async linkEntry(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(linkKnowledgeRequestSchema)) input: LinkKnowledgeRequest
  ) {
    this.markDeprecated(res);
    return ok(request, await this.knowledge.addLink(request.author.id, id, input));
  }

  // ── 旧 3.8 大纲自动提取 ──

  /**
   * @deprecated 旧一代大纲抽取接口。新客户端请改用新知识库结构化（POST /knowledge/entries/:id/restructure）。
   */
  @Post('outline/extract')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async extractOutline(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(extractOutlineRequestSchema)) input: ExtractOutlineRequest
  ) {
    this.markDeprecated(res);
    const entry = await this.knowledge.getById(request.author.id, input.novel_id);
    const result = await this.outline.extractOutline({
      rawContent: entry.raw_content,
      title: entry.title,
      source: entry.source
    });
    if (result.outline) {
      // 写回 structured.outline 并持久化
      const structured = { ...entry.structured, outline: result.outline };
      await this.knowledge.update(request.author.id, input.novel_id, { structured });
      return ok(request, { novel_id: input.novel_id, outline: result.outline });
    }
    return ok(request, { novel_id: input.novel_id, error: result.error });
  }

  // ── 旧 3.9a Markdown 导出 ──

  /**
   * @deprecated 旧一代 Markdown 导出接口。新客户端请改用新知识库导入导出（POST /knowledge/exports）。
   */
  @Post('markdown/export')
  @HttpCode(HttpStatus.OK)
  async exportMarkdown(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(exportKnowledgeMarkdownRequestSchema)) input: ExportKnowledgeMarkdownRequest
  ) {
    this.markDeprecated(res);
    const { mode } = input;
    // 解析条目集合（single：entry_ids[0]；batch：entry_ids；by_type/by_tag：检索）
    let ids: string[] = [];
    if (mode === 'single' || mode === 'batch') {
      ids = input.entry_ids ?? [];
    } else if (mode === 'by_type') {
      const r = await this.knowledge.searchEntries(request.author.id, { page: 1, page_size: 100, type: input.type });
      ids = r.items.map((i) => i.id);
    } else {
      const r = await this.knowledge.searchEntries(request.author.id, { page: 1, page_size: 100, tag: input.tag });
      ids = r.items.map((i) => i.id);
    }

    if (ids.length === 0) {
      return ok(request, { mode, total: 0 });
    }

    const entries = await Promise.all(ids.map((id) => this.knowledge.getById(request.author.id, id)));
    if (mode === 'single') {
      const e = entries[0]!;
      const content = this.markdown.renderExport([e], false)[0]!.content;
      const fileName = buildFilename(e.title);
      return ok(request, { mode, file_name: fileName, content, total: 1 });
    }

    // batch / by_type / by_tag：ZIP
    const files = this.markdown.renderExport(entries, true);
    const zip = await buildZip(files);
    const summary = entries.map((e) => e.title);
    return ok(request, {
      mode,
      zip_base64: zip.toString('base64'),
      total: entries.length,
      summary
    });
  }

  // ── 旧 3.9b 导入预览 ──

  /**
   * @deprecated 旧一代导入预览接口。新客户端请改用新知识库导入预览（POST /knowledge/imports/preview）。
   */
  @Post('markdown/import/preview')
  @HttpCode(HttpStatus.OK)
  async importPreview(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(importKnowledgePreviewRequestSchema)) input: ImportKnowledgePreviewRequest
  ) {
    this.markDeprecated(res);
    const all = await this.knowledge.searchEntries(request.author.id, { page: 1, page_size: 100 });
    const items = this.markdown.preview(
      input.files,
      input.target_type,
      all.items.map((i) => ({ id: i.id, title: i.title }))
    );
    return ok(request, { items });
  }

  // ── 旧 3.9c 确认导入 ──

  /**
   * @deprecated 旧一代确认导入接口。新客户端请改用新知识库导入提交（POST /knowledge/imports/commit）。
   */
  @Post('markdown/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async importMarkdown(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(importKnowledgeRequestSchema)) input: ImportKnowledgeRequest
  ) {
    this.markDeprecated(res);
    const all = await this.knowledge.searchEntries(request.author.id, { page: 1, page_size: 100 });
    const entries = all.items.map((i) => ({ id: i.id, title: i.title }));
    const result = await this.markdown.execute(
      input,
      entries,
      async (item, mode, targetId) => {
        if (mode === 'update' && targetId) {
          await this.knowledge.update(request.author.id, targetId, {
            title: item.title,
            structured: { raw: item.content },
            tags: []
          });
        } else {
          await this.knowledge.commit(request.author.id, {
            type: input.target_type,
            title: item.title,
            source: 'import',
            raw_content: item.content,
            structured: { raw: item.content },
            tags: [],
            links: []
          });
        }
      }
    );
    return ok(request, result);
  }

  // ── 旧 3.9d 单文件格式校验 ──

  /**
   * @deprecated 旧一代单文件格式校验接口。新客户端请改用新知识库导入预览（POST /knowledge/imports/preview）。
   */
  @Post('markdown/import/validate')
  @HttpCode(HttpStatus.OK)
  async validateMarkdown(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { file_name?: string; content?: string }
  ) {
    this.markDeprecated(res);
    if (!body?.file_name || typeof body.content !== 'string') {
      return ok(request, { valid: false, reason: 'bad_request' });
    }
    return ok(request, this.markdown.validate(body.file_name, body.content));
  }
}
