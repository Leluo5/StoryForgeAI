import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import type { CreateRoleProfileTaskRequest } from '@storyforge/contracts';
import { createRoleProfileTaskRequestSchema } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CollabTaskService } from './collab-task.service';

/**
 * F11 多平台 Agent 协同 · 角色资料任务接口层。
 * 全部挂 SessionGuard，写操作追加 CsrfGuard；成功响应 ok(request, data)。
 * - POST /works/:workId/role-profile/tasks            创建角色资料协同任务（202）
 * - GET  /works/:workId/role-profile/tasks/:taskId    查询任务详情（200）
 * - GET  /works/:workId/role-profile/writebacks       按角色列写回历史（200）
 */
@Controller()
@UseGuards(SessionGuard)
export class CollabTaskController {
  constructor(
    @Inject(CollabTaskService) private readonly taskService: CollabTaskService
  ) {}

  @Post('works/:workId/role-profile/tasks')
  @UseGuards(CsrfGuard)
  async create(
    @Req() req: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createRoleProfileTaskRequestSchema)) body: CreateRoleProfileTaskRequest,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<unknown> {
    try {
      const result = await this.taskService.createRoleProfileTask(req.author.id, workId, {
        ...body,
        ...(idempotencyKey ? { idempotencyKey } : {})
      });
      return ok(req, { task: result.task });
    } catch (cause) {
      if (cause instanceof HttpException) throw cause;
      throw new HttpException(
        { code: 'COLLAB_UPSTREAM_ERROR', message: cause instanceof Error ? cause.message : '协同任务创建失败' },
        HttpStatus.BAD_REQUEST
      );
    }
  }

  @Get('works/:workId/role-profile/writebacks')
  async listWritebacks(
    @Req() req: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Query('character_id') characterId?: string
  ): Promise<unknown> {
    try {
      const result = await this.taskService.listWritebacks(req.author.id, workId, characterId);
      return ok(req, result);
    } catch (cause) {
      if (cause instanceof HttpException) throw cause;
      throw new HttpException(
        { code: 'COLLAB_UPSTREAM_ERROR', message: cause instanceof Error ? cause.message : '写回历史查询失败' },
        HttpStatus.BAD_REQUEST
      );
    }
  }

  @Get('works/:workId/role-profile/tasks/:taskId')
  async detail(
    @Req() req: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('taskId') taskId: string
  ): Promise<unknown> {
    try {
      const detail = await this.taskService.getTaskDetail(req.author.id, workId, taskId);
      return ok(req, detail);
    } catch (cause) {
      if (cause instanceof HttpException) throw cause;
      throw new HttpException(
        { code: 'COLLAB_UPSTREAM_ERROR', message: cause instanceof Error ? cause.message : '协同任务查询失败' },
        HttpStatus.BAD_REQUEST
      );
    }
  }
}
