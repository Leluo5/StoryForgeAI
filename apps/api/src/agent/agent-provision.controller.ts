import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import type { ResetRoleDefaultFlowRequest, SwitchToolRequest } from '@storyforge/contracts';
import {
  resetRoleDefaultFlowSchema,
  switchToolSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { AgentProvisionService } from './agent-provision.service';
import { FlowProgressService } from './flow-progress.service';

/**
 * Agent provision / 工具开关 / 进度追踪入口（M4-T4）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - POST /ai-projects/:projectId/provision                  provision 默认流
 * - POST /ai-projects/:projectId/bind-roles                绑定角色
 * - POST /ai-roles/:roleId/reset-default                   重置角色默认流
 * - GET  /ai-roles/:roleId/progress                        角色流程进度（R2：authorId+roleId 反查）
 * - POST /ai-roles/:roleId/progress/reset                  进度重置（R2）
 * - POST /ai-projects/:projectId/tools/:toolName/switch    工具开关（R1：路径带 projectId）
 *
 * 评审 R1/R2 修正：进度与工具开关的 projectId 来源已对齐服务签名。
 */
@Controller()
@UseGuards(SessionGuard)
export class AgentProvisionController {
  constructor(
    @Inject(AgentProvisionService) private readonly provisionService: AgentProvisionService,
    @Inject(FlowProgressService) private readonly progressService: FlowProgressService
  ) {}

  // ── provision 默认流 ──

  @Post('ai-projects/:projectId/provision')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async provision(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string
  ) {
    return ok(request, await this.provisionService.provisionProjectDefaults(
      request.author.id,
      projectId
    ));
  }

  // ── 绑定角色 ──

  @Post('ai-projects/:projectId/bind-roles')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async bindRoles(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string
  ) {
    const count = await this.provisionService.bindRoles(request.author.id, projectId);
    return ok(request, { created: count });
  }

  // ── 重置角色默认流 ──

  @Post('ai-roles/:roleId/reset-default')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async resetRoleDefaultFlow(
    @Req() request: AuthenticatedRequest,
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(resetRoleDefaultFlowSchema)) input: ResetRoleDefaultFlowRequest
  ) {
    const created = await this.provisionService.resetRoleDefaultFlow(
      request.author.id,
      roleId,
      input.mode
    );
    return ok(request, { created });
  }

  // ── 角色流程进度（R2：authorId 反查） ──

  @Get('ai-roles/:roleId/progress')
  async getProgress(
    @Req() request: AuthenticatedRequest,
    @Param('roleId') roleId: string
  ) {
    return ok(request, await this.progressService.getProgress(request.author.id, roleId));
  }

  // ── 进度重置（R2） ──

  @Post('ai-roles/:roleId/progress/reset')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async resetProgress(
    @Req() request: AuthenticatedRequest,
    @Param('roleId') roleId: string
  ) {
    return ok(request, await this.progressService.resetProgress(request.author.id, roleId));
  }

  // ── 工具开关（R1：路径带 projectId） ──

  @Post('ai-projects/:projectId/tools/:toolName/switch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async switchTool(
    @Req() request: AuthenticatedRequest,
    @Param('projectId') projectId: string,
    @Param('toolName') toolName: string,
    @Body(new ZodValidationPipe(switchToolSchema)) input: SwitchToolRequest
  ) {
    return ok(request, await this.provisionService.switchToolDefault(
      request.author.id,
      projectId,
      toolName,
      input.agent_id
    ));
  }
}
