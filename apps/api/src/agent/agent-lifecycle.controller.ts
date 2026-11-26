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
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { AgentService } from './agent.service';

/**
 * Agent 生命周期与版本管理入口（M4-T4）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - POST /ai-agents/:agentId/archive            归档 Agent
 * - POST /ai-agents/:agentId/restore            恢复 Agent
 * - GET  /ai-agents/:agentId/versions           版本摘要列表
 * - POST /ai-agents/:agentId/versions/:versionNo/rollback  版本回滚（写新版本，保留最近 50）
 */
@Controller()
@UseGuards(SessionGuard)
export class AgentLifecycleController {
  constructor(@Inject(AgentService) private readonly agentService: AgentService) {}

  // ── 归档 ──

  @Post('ai-agents/:agentId/archive')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async archiveAgent(
    @Req() request: AuthenticatedRequest,
    @Param('agentId') agentId: string
  ) {
    return ok(request, await this.agentService.archiveAgent(request.author.id, agentId));
  }

  // ── 恢复 ──

  @Post('ai-agents/:agentId/restore')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async restoreAgent(
    @Req() request: AuthenticatedRequest,
    @Param('agentId') agentId: string
  ) {
    return ok(request, await this.agentService.restoreAgent(request.author.id, agentId));
  }

  // ── 版本摘要列表 ──

  @Get('ai-agents/:agentId/versions')
  async listVersions(
    @Req() request: AuthenticatedRequest,
    @Param('agentId') agentId: string
  ) {
    return ok(request, await this.agentService.listVersions(request.author.id, agentId));
  }

  // ── 版本回滚 ──

  @Post('ai-agents/:agentId/versions/:versionNo/rollback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async rollback(
    @Req() request: AuthenticatedRequest,
    @Param('agentId') agentId: string,
    @Param('versionNo') versionNo: string
  ) {
    const target = Number(versionNo);
    return ok(request, await this.agentService.rollbackVersion(
      request.author.id,
      agentId,
      target
    ));
  }
}
