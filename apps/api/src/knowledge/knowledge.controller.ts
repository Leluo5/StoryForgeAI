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
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import {
  commitKnowledgeEntryRequestSchema,
  createKnowledgeEntryRequestSchema,
  exportKnowledgeMarkdownRequestSchema,
  extractOutlineRequestSchema,
  importKnowledgePreviewRequestSchema,
  importKnowledgeRequestSchema,
  linkKnowledgeRequestSchema,
  searchKnowledgeRequestSchema,
  updateKnowledgeEntryRequestSchema
} from '@storyforge/contracts';
import type {
  CommitKnowledgeEntryRequest,
  CreateKnowledgeEntryRequest,
  ExportKnowledgeMarkdownRequest,
  ExtractOutlineRequest,
  ImportKnowledgePreviewRequest,
  ImportKnowledgeRequest,
  LinkKnowledgeRequest,
  SearchKnowledgeRequest,
  UpdateKnowledgeEntryRequest
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeParserService, TypeUncertainError } from './knowledge-parser.service';
import { KnowledgeOutlineService } from './knowledge-outline.service';
import { KnowledgeLinkerService } from './knowledge-linker.service';
import { KnowledgeMarkdownService } from './knowledge-markdown.service';
import type { KnowledgeLlmContext } from './knowledge-llm.provider';

// 构建 LLM 上下文：title 可选（exactOptionalPropertyTypes 下不可传 undefined）
function llmContext(rawContent: string, title: string | undefined, source: string): KnowledgeLlmContext {
  return title ? { rawContent, title, source } : { rawContent, source };
}

/**
 * 知识库管理接口层（F5 重构版，全局作用域，不按作品）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard），前缀 /api/v1/knowledge：
 * - POST   /entries                 统一录入（生成预览，不落库）
 * - POST   /entries/:id/commit      确认入库（幂等去重）
 * - GET    /entries                 统一检索（四维 + 分页）
 * - GET    /entries/:id             详情
 * - PUT    /entries/:id             编辑（重建关联）
 * - DELETE /entries/:id             删除（清理引用）
 * - POST   /entries/:id/link        建立关联
 * - POST   /outline/extract         大纲自动提取
 * - POST   /markdown/export         Markdown 导出（single/batch/by_type/by_tag）
 * - POST   /markdown/import/preview 导入预览
 * - POST   /markdown/import         确认导入
 * - POST   /markdown/import/validate 单文件格式校验
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(KnowledgeParserService) private readonly parser: KnowledgeParserService,
    @Inject(KnowledgeOutlineService) private readonly outline: KnowledgeOutlineService,
    @Inject(KnowledgeLinkerService) private readonly linker: KnowledgeLinkerService,
    @Inject(KnowledgeMarkdownService) private readonly markdown: KnowledgeMarkdownService
  ) {}

  // ── 3.1 统一录入（生成预览，不落库） ──

  @Post('entries')
  @HttpCode(HttpStatus.OK)
  async createEntry(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createKnowledgeEntryRequestSchema)) input: CreateKnowledgeEntryRequest
  ) {
    try {
      // 类型识别：manual 优先，否则 LLM；不确定抛 TypeUncertainError
      const type = await this.parser.detectType(
        llmContext(input.raw_content, input.title, input.source),
        input.type === 'auto' ? undefined : input.type
      );
      // 拆分引擎：按类型分派；失败降级原文
      const parsed = await this.parser.parseEntry(
        llmContext(input.raw_content, input.title, input.source),
        type
      );
      // 灵感：自动关联（前 3 名）并补充上下文
      let structured = parsed.structured;
      if (type === 'inspiration') {
        const existing = await this.knowledge.searchEntries(request.author.id, { page: 1, page_size: 50 });
        const linked = await this.linker.linkInspiration(input.raw_content, existing.items);
        structured = { ...structured, related_ids: linked.related_ids, enriched_text: linked.enriched_text };
      }
      // 生成预览（去重：同内容已存在 → status: saved）
      const preview = await this.knowledge.createPreview(
        request.author.id,
        input.title
          ? { source: input.source, type, title: input.title, raw_content: input.raw_content }
          : { source: input.source, type, raw_content: input.raw_content }
      );
      return ok(request, {
        status: preview.status,
        id: preview.id,
        type,
        title: preview.title || input.title,
        structured: structured ?? preview.structured,
        tags: preview.tags,
        degraded: parsed.degraded
      });
    } catch (err) {
      if (err instanceof TypeUncertainError) {
        return ok(request, { status: 'type_uncertain' });
      }
      throw err;
    }
  }

  // ── 3.2 确认入库（幂等） ──

  @Post('entries/:id/commit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async commitEntry(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(commitKnowledgeEntryRequestSchema)) input: CommitKnowledgeEntryRequest
  ) {
    // 幂等入库：同 author + content_hash 已存在返回已有
    const result = await this.knowledge.commit(request.author.id, input);
    return ok(request, { id: result.id, status: result.status });
  }

  // ── 3.3 统一检索（四维 + 分页） ──

  @Get('entries')
  @HttpCode(HttpStatus.OK)
  async searchEntries(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(searchKnowledgeRequestSchema)) query: SearchKnowledgeRequest
  ) {
    return ok(request, await this.knowledge.searchEntries(request.author.id, query));
  }

  // ── 3.4 详情 ──

  @Get('entries/:id')
  @HttpCode(HttpStatus.OK)
  async getEntry(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return ok(request, await this.knowledge.getById(request.author.id, id));
  }

  // ── 3.5 编辑 ──

  @Put('entries/:id')
  @UseGuards(CsrfGuard)
  async updateEntry(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateKnowledgeEntryRequestSchema)) input: UpdateKnowledgeEntryRequest
  ) {
    return ok(request, await this.knowledge.update(request.author.id, id, input));
  }

  // ── 3.6 删除 ──

  @Delete('entries/:id')
  @UseGuards(CsrfGuard)
  async deleteEntry(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return ok(request, await this.knowledge.delete(request.author.id, id));
  }

  // ── 3.7 建立关联 ──

  @Post('entries/:id/link')
  @UseGuards(CsrfGuard)
  async linkEntry(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(linkKnowledgeRequestSchema)) input: LinkKnowledgeRequest
  ) {
    return ok(request, await this.knowledge.addLink(request.author.id, id, input));
  }

  // ── 3.8 大纲自动提取 ──

  @Post('outline/extract')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async extractOutline(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(extractOutlineRequestSchema)) input: ExtractOutlineRequest
  ) {
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

  // ── 3.9a Markdown 导出 ──

  @Post('markdown/export')
  @HttpCode(HttpStatus.OK)
  async exportMarkdown(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(exportKnowledgeMarkdownRequestSchema)) input: ExportKnowledgeMarkdownRequest
  ) {
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

  // ── 3.9b 导入预览 ──

  @Post('markdown/import/preview')
  @HttpCode(HttpStatus.OK)
  async importPreview(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(importKnowledgePreviewRequestSchema)) input: ImportKnowledgePreviewRequest
  ) {
    const all = await this.knowledge.searchEntries(request.author.id, { page: 1, page_size: 100 });
    const items = this.markdown.preview(
      input.files,
      input.target_type,
      all.items.map((i) => ({ id: i.id, title: i.title }))
    );
    return ok(request, { items });
  }

  // ── 3.9c 确认导入 ──

  @Post('markdown/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async importMarkdown(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(importKnowledgeRequestSchema)) input: ImportKnowledgeRequest
  ) {
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

  // ── 3.9d 单文件格式校验 ──

  @Post('markdown/import/validate')
  @HttpCode(HttpStatus.OK)
  async validateMarkdown(
    @Req() request: AuthenticatedRequest,
    @Body() body: { file_name?: string; content?: string }
  ) {
    if (!body?.file_name || typeof body.content !== 'string') {
      return ok(request, { valid: false, reason: 'bad_request' });
    }
    return ok(request, this.markdown.validate(body.file_name, body.content));
  }
}

// 复用 Markdown 引擎的导出函数（避免循环依赖）
import { buildFilename, buildZip } from './knowledge-markdown.service';
