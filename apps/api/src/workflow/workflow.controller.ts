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
import type {
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  ArchiveWorkflowRequest,
  RollbackWorkflowRequest
} from '@storyforge/contracts';
import {
  createWorkflowRequestSchema,
  updateWorkflowRequestSchema,
  archiveWorkflowRequestSchema,
  rollbackWorkflowRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { WorkflowService } from './workflow.service';
import { WorkflowRunService } from './workflow-run.service';

/**
 * F12 工作流管理：创作工作流配置管理接口层。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - GET    /ai-workflows                     列出作者全部工作流（keyword/status 过滤 + 分页）
 * - POST   /ai-workflows                     创建工作流
 * - GET    /ai-workflows/:workflowId         工作流详情（含版本快照）
 * - PATCH  /ai-workflows/:workflowId         更新工作流（白名单 + 版本快照）
 * - DELETE /ai-workflows/:workflowId         删除工作流（已归档硬删，未归档需 force）
 * - POST   /ai-workflows/:workflowId/archive   归档工作流
 * - POST   /ai-workflows/:workflowId/restore  恢复工作流
 * - GET    /ai-workflows/:workflowId/versions  版本历史摘要
 * - POST   /ai-workflows/:workflowId/versions/:versionNo/rollback  回滚到指定版本
 * - POST   /ai-workflows/:workflowId/run     运行工作流（M4-T7，入队返回 aiTaskId）
 * - GET    /ai-workflows/:workflowId/runs/:aiTaskId  查询运行状态（M4-T7）
 */
@Controller()
@UseGuards(SessionGuard)
export class WorkflowController {
  constructor(
    @Inject(WorkflowService) private readonly workflowService: WorkflowService,
    @Inject(WorkflowRunService) private readonly runService: WorkflowRunService
  ) {}

  // ── 列出工作流 ──

  @Get('ai-workflows')
  async listWorkflows(
    @Req() request: AuthenticatedRequest,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string
  ) {
    return ok(
      request,
      await this.workflowService.listWorkflows(request.author.id, {
        ...(keyword ? { keyword } : {}),
        ...(status ? { status } : {}),
        ...(page ? { page: Number(page) } : {}),
        ...(pageSize ? { page_size: Number(pageSize) } : {})
      })
    );
  }

  // ── 工作流详情 ──

  @Get('ai-workflows/:workflowId')
  async getWorkflow(@Req() request: AuthenticatedRequest, @Param('workflowId') workflowId: string) {
    return ok(request, await this.workflowService.getWorkflow(request.author.id, workflowId));
  }

  // ── 创建工作流 ──

  @Post('ai-workflows')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createWorkflow(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createWorkflowRequestSchema)) input: CreateWorkflowRequest
  ) {
    return ok(request, await this.workflowService.createWorkflow(request.author.id, input));
  }

  // ── 更新工作流 ──

  @Patch('ai-workflows/:workflowId')
  @UseGuards(CsrfGuard)
  async updateWorkflow(
    @Req() request: AuthenticatedRequest,
    @Param('workflowId') workflowId: string,
    @Body(new ZodValidationPipe(updateWorkflowRequestSchema)) input: UpdateWorkflowRequest
  ) {
    return ok(request, await this.workflowService.updateWorkflow(request.author.id, workflowId, input));
  }

  // ── 删除工作流 ──

  @Delete('ai-workflows/:workflowId')
  @UseGuards(CsrfGuard)
  async deleteWorkflow(
    @Req() request: AuthenticatedRequest,
    @Param('workflowId') workflowId: string,
    @Query('force') force?: string
  ) {
    return ok(
      request,
      await this.workflowService.deleteWorkflow(request.author.id, workflowId, force === 'true')
    );
  }

  // ── 归档 ──

  @Post('ai-workflows/:workflowId/archive')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async archiveWorkflow(
    @Req() request: AuthenticatedRequest,
    @Param('workflowId') workflowId: string,
    @Body(new ZodValidationPipe(archiveWorkflowRequestSchema)) input: ArchiveWorkflowRequest
  ) {
    return ok(request, await this.workflowService.archiveWorkflow(request.author.id, workflowId, input.note));
  }

  // ── 恢复 ──

  @Post('ai-workflows/:workflowId/restore')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async restoreWorkflow(@Req() request: AuthenticatedRequest, @Param('workflowId') workflowId: string) {
    return ok(request, await this.workflowService.restoreWorkflow(request.author.id, workflowId));
  }

  // ── 版本历史 ──

  @Get('ai-workflows/:workflowId/versions')
  async listVersions(@Req() request: AuthenticatedRequest, @Param('workflowId') workflowId: string) {
    return ok(request, await this.workflowService.listVersions(request.author.id, workflowId));
  }

  // ── 回滚到指定版本 ──

  @Post('ai-workflows/:workflowId/versions/:versionNo/rollback')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async rollbackWorkflow(
    @Req() request: AuthenticatedRequest,
    @Param('workflowId') workflowId: string,
    @Param('versionNo') versionNo: string,
    @Body(new ZodValidationPipe(rollbackWorkflowRequestSchema)) input: RollbackWorkflowRequest
  ) {
    return ok(
      request,
      await this.workflowService.rollbackWorkflow(request.author.id, workflowId, Number(versionNo))
    );
  }

  // ── 运行工作流（M4-T7）：创建 ai-task（scope=workflow_run）并入队，202 返回 aiTaskId ──

  @Post('ai-workflows/:workflowId/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async runWorkflow(@Req() request: AuthenticatedRequest, @Param('workflowId') workflowId: string) {
    return ok(request, await this.runService.runWorkflow(request.author.id, workflowId));
  }

  // ── 查询运行状态（M4-T7） ──

  @Get('ai-workflows/:workflowId/runs/:aiTaskId')
  async getRunStatus(
    @Req() request: AuthenticatedRequest,
    @Param('workflowId') workflowId: string,
    @Param('aiTaskId') aiTaskId: string
  ) {
    return ok(request, await this.runService.getRunStatus(request.author.id, workflowId, aiTaskId));
  }
}
