import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { CozeImportRequest, CozeListResourcesRequest } from '@storyforge/contracts';
import {
  cozeImportRequestSchema,
  cozeListResourcesRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CozeImportService } from './coze-import.service';

// F1 Coze 资源拉取与批量导入。
// 落点：Coze 智能体 → AgentEntity，Coze 知识库 → KnowledgeEntryEntity，Coze 工作流 → WorkflowEntity（M4-T10）。
// 全部挂 SessionGuard（作者登录），写操作挂 CsrfGuard + ZodValidationPipe。
// - POST /admin/coze/test              测试 Coze 连接（PAT/workspace 可选）
// - POST /admin/coze/list              拉取 bot+dataset 资源列表
// - POST /admin/coze/import            批量导入所选资源
// - POST /admin/coze/workflows         拉取工作流资源列表（M4-T10）
// - POST /admin/coze/import-workflow   导入所选工作流（M4-T10）
@Controller('admin/coze')
@UseGuards(SessionGuard)
export class CozeImportController {
  constructor(@Inject(CozeImportService) private readonly service: CozeImportService) {}

  @Post('test')
  @UseGuards(CsrfGuard)
  async test(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(cozeListResourcesRequestSchema)) input: CozeListResourcesRequest
  ) {
    return ok(request, await this.service.testConnection(request.author.id, input.pat_token, input.workspace_id));
  }

  @Post('list')
  @UseGuards(CsrfGuard)
  async list(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(cozeListResourcesRequestSchema)) input: CozeListResourcesRequest
  ) {
    return ok(request, await this.service.listResources(request.author.id, input.pat_token, input.workspace_id));
  }

  @Post('import')
  @UseGuards(CsrfGuard)
  async importResources(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(cozeImportRequestSchema)) input: CozeImportRequest
  ) {
    return ok(request, await this.service.importResources(request.author.id, input));
  }

  // ── M4-T10 · Coze 工作流导入补齐 ──────────────────────────────────────

  /** 拉取工作流资源列表（M4-T10：仅触发 /v1/workflows，不调用 bot/dataset） */
  @Post('workflows')
  @UseGuards(CsrfGuard)
  async listWorkflows(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(cozeListResourcesRequestSchema)) input: CozeListResourcesRequest
  ) {
    return ok(request, await this.service.listWorkflowResources(request.author.id, input.pat_token, input.workspace_id));
  }

  /** 导入所选工作流（复用 importResources，仅处理 type=workflow 项） */
  @Post('import-workflow')
  @UseGuards(CsrfGuard)
  async importWorkflows(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(cozeImportRequestSchema)) input: CozeImportRequest
  ) {
    const workflowOnly: CozeImportRequest = {
      ...input,
      items: input.items.filter((i) => i.type === 'workflow')
    };
    return ok(request, await this.service.importResources(request.author.id, workflowOnly));
  }
}
