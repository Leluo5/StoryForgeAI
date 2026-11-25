import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type {
  CozeImportRequest,
  CozeImportResponse,
  CozeListResourcesRequest,
  CozeListResourcesResponse
} from '@storyforge/contracts';
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
// 落点：Coze 智能体 → AgentEntity，Coze 知识库 → KnowledgeEntryEntity；工作流本次不做。
// 全部挂 SessionGuard（作者登录），写操作挂 CsrfGuard + ZodValidationPipe。
// - POST /admin/coze/test   测试 Coze 连接（PAT/workspace 可选）
// - POST /admin/coze/list   拉取 bot+dataset 资源列表
// - POST /admin/coze/import 批量导入所选资源
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
  ): Promise<CozeListResourcesResponse> {
    return this.service.listResources(request.author.id, input.pat_token, input.workspace_id);
  }

  @Post('import')
  @UseGuards(CsrfGuard)
  async importResources(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(cozeImportRequestSchema)) input: CozeImportRequest
  ): Promise<CozeImportResponse> {
    return this.service.importResources(request.author.id, input);
  }
}
