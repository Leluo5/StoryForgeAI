import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CharacterMapService } from './character-map.service';

/**
 * M4-T8 AI 建图：角色关系图谱自动生成接口层。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - POST /works/:workId/character-map/generate    发起 AI 建图（入队，202 返回 aiTaskId）
 * - GET  /works/:workId/character-map/tasks/:taskId  查询建图任务状态
 * 建图落点：character_relation（origin='ai'），仅基于已入库角色生成关系边。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterMapController {
  constructor(@Inject(CharacterMapService) private readonly mapService: CharacterMapService) {}

  // ── 发起 AI 建图 ──

  @Post('works/:workId/character-map/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async generate(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.mapService.generate(request.author.id, workId));
  }

  // ── 查询建图任务状态 ──

  @Get('works/:workId/character-map/tasks/:taskId')
  async getTask(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('taskId') taskId: string
  ) {
    return ok(request, await this.mapService.getTask(request.author.id, workId, taskId));
  }
}
