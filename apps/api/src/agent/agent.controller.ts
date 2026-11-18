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
  Req,
  UseGuards
} from '@nestjs/common';
import type { CreateAgentRequest, UpdateAgentRequest, UpdateToolRequest } from '@storyforge/contracts';
import {
  createAgentRequestSchema,
  updateAgentRequestSchema,
  updateToolRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { AgentService } from './agent.service';

/**
 * Agent 配置与管理接口层（M3b-B5）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - GET    /ai-agents                    列出作者全部 Agent（含绑定工具数）
 * - POST   /ai-agents                    创建 Agent（默认互斥）
 * - PATCH  /ai-agents/:agentId           更新 Agent（默认互斥 + 软删状态机）
 * - DELETE /ai-agents/:agentId           删除 Agent（软删=disabled，解绑工具）
 * - GET    /ai-tools                     列出全部工具（含绑定 Agent 概要）
 * - PATCH  /ai-tools/:toolId             更新工具（绑定 Agent / 启停 / 改名）
 */
@Controller()
@UseGuards(SessionGuard)
export class AgentController {
  constructor(@Inject(AgentService) private readonly agentService: AgentService) {}

  // ── 列出 Agent ──

  @Get('ai-agents')
  async listAgents(@Req() request: AuthenticatedRequest) {
    return ok(request, await this.agentService.listAgents(request.author.id));
  }

  // ── 创建 Agent ──

  @Post('ai-agents')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createAgent(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createAgentRequestSchema)) input: CreateAgentRequest
  ) {
    return ok(request, await this.agentService.createAgent(request.author.id, input));
  }

  // ── 更新 Agent ──

  @Patch('ai-agents/:agentId')
  @UseGuards(CsrfGuard)
  async updateAgent(
    @Req() request: AuthenticatedRequest,
    @Param('agentId') agentId: string,
    @Body(new ZodValidationPipe(updateAgentRequestSchema)) input: UpdateAgentRequest
  ) {
    return ok(request, await this.agentService.updateAgent(request.author.id, agentId, input));
  }

  // ── 删除 Agent（软删） ──

  @Delete('ai-agents/:agentId')
  @UseGuards(CsrfGuard)
  async deleteAgent(@Req() request: AuthenticatedRequest, @Param('agentId') agentId: string) {
    return ok(request, await this.agentService.deleteAgent(request.author.id, agentId));
  }

  // ── 列出工具 ──

  @Get('ai-tools')
  async listTools(@Req() request: AuthenticatedRequest) {
    return ok(request, await this.agentService.listTools(request.author.id));
  }

  // ── 更新工具 ──

  @Patch('ai-tools/:toolId')
  @UseGuards(CsrfGuard)
  async updateTool(
    @Req() request: AuthenticatedRequest,
    @Param('toolId') toolId: string,
    @Body(new ZodValidationPipe(updateToolRequestSchema)) input: UpdateToolRequest
  ) {
    return ok(request, await this.agentService.updateTool(request.author.id, toolId, input));
  }
}
