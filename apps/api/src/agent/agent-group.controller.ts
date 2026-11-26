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
import type {
  CreateManualGroupRequest,
  DeleteOverrideRequest,
  SetAgentGroupRequest,
  UpsertOverrideRequest
} from '@storyforge/contracts';
import {
  createManualGroupSchema,
  deleteOverrideSchema,
  setAgentGroupSchema,
  upsertOverrideSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { AgentGroupService } from './agent-group.service';
import { AgentService } from './agent.service';

/**
 * Agent 分组管理入口（M4-T4）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - GET    /ai-agent-groups/tree?project_id=:projectId    分组树
 * - POST   /ai-agent-groups/override                      覆盖 upsert
 * - DELETE /ai-agent-groups/override?project_id=&key=     覆盖删除
 * - POST   /ai-agent-groups/manual                        手动分组创建
 * - DELETE /ai-agent-groups/manual/:groupId?project_id=   手动分组删除
 * - PUT    /ai-agents/:agentId/group                      设 Agent 分组（经 updateAgentV2 承载）
 *
 * 偏差 3（用户裁决）：tree/override/manual 删除均从 query 带 project_id。
 * setAgentGroup（偏差 2，用户裁决）：用 AgentService.updateAgentV2 的 manual_group_key 承载。
 */
@Controller()
@UseGuards(SessionGuard)
export class AgentGroupController {
  constructor(
    @Inject(AgentGroupService) private readonly groupService: AgentGroupService,
    @Inject(AgentService) private readonly agentService: AgentService
  ) {}

  // ── 分组树 ──

  @Get('ai-agent-groups/tree')
  async getTree(
    @Req() request: AuthenticatedRequest,
    @Query('project_id') projectId: string
  ) {
    return ok(request, await this.groupService.getTreeData(request.author.id, projectId));
  }

  // ── 覆盖 upsert ──

  @Post('ai-agent-groups/override')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async upsertOverride(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(upsertOverrideSchema)) input: UpsertOverrideRequest
  ) {
    const { project_id: projectId, key, name, sort_order: sortOrder, hidden } = input;
    // exactOptionalPropertyTypes：显式剔除 undefined，避免 string|undefined 传给 string
    const fields: { name?: string; sort_order?: number; hidden?: boolean } = {};
    if (name !== undefined) fields.name = name;
    if (sortOrder !== undefined) fields.sort_order = sortOrder;
    if (hidden !== undefined) fields.hidden = hidden;
    return ok(request, await this.groupService.upsertOverride(projectId, key, fields));
  }

  // ── 覆盖删除 ──

  @Delete('ai-agent-groups/override')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async deleteOverride(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(deleteOverrideSchema)) query: DeleteOverrideRequest
  ) {
    const okFlag = await this.groupService.deleteOverride(query.project_id, query.key);
    return ok(request, { success: okFlag });
  }

  // ── 手动分组创建 ──

  @Post('ai-agent-groups/manual')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createManualGroup(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createManualGroupSchema)) input: CreateManualGroupRequest
  ) {
    const { project_id: projectId, parent_key: parentKey, name, sort_order: sortOrder } = input;
    return ok(request, await this.groupService.createManualGroup(projectId, parentKey, name, sortOrder));
  }

  // ── 手动分组删除 ──

  @Delete('ai-agent-groups/manual/:groupId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async deleteManualGroup(
    @Req() request: AuthenticatedRequest,
    @Param('groupId') groupId: string,
    @Query('project_id') projectId: string
  ) {
    const okFlag = await this.groupService.deleteManualGroup(projectId, groupId);
    return ok(request, { success: okFlag });
  }

  // ── 设 Agent 分组（经 updateAgentV2 承载） ──

  @Put('ai-agents/:agentId/group')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async setAgentGroup(
    @Req() request: AuthenticatedRequest,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(setAgentGroupSchema)) body: SetAgentGroupRequest
  ) {
    const manualGroupKey = body.manual_group_key;
    const agent = await this.agentService.updateAgentV2(
      request.author.id,
      agentId,
      { manual_group_key: manualGroupKey ?? null }
    );
    return ok(request, agent);
  }
}
