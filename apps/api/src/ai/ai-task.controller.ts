import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  CreateAiTaskRequest,
  ListAiTaskEventsQuery,
  ListAiTasksQuery
} from '@storyforge/contracts';
import {
  createAiTaskRequestSchema,
  listAiTaskEventsQuerySchema,
  listAiTasksQuerySchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { AiTaskService } from './ai-task.service';
import { AiTaskSseService } from './ai-task.sse';

/**
 * AI 创作任务接口层（M3a-A8）。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - POST   /works/:workId/chapters/:chapterId/ai-tasks       发起任务（幂等，201/200/409/422）
 * - GET    /works/:workId/chapters/:chapterId/ai-tasks       列出章节任务（分页 + status 过滤）
 * - GET    /works/:workId/ai-tasks/:taskId                   单任务详情
 * - POST   /works/:workId/ai-tasks/:taskId/retry             重试（仅 failed/cancelled）
 * - POST   /works/:workId/ai-tasks/:taskId/cancel            取消（仅 queued/running）
 * - GET    /works/:workId/ai-tasks/:taskId/events            SSE 进度推送
 */
@Controller('works/:workId')
@UseGuards(SessionGuard)
export class AiTaskController {
  constructor(
    @Inject(AiTaskService) private readonly aiTaskService: AiTaskService,
    @Inject(AiTaskSseService) private readonly aiTaskSseService: AiTaskSseService
  ) {}

  // ── 发起任务 ──

  @Post('chapters/:chapterId/ai-tasks')
  @UseGuards(CsrfGuard)
  async createAiTask(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Body(new ZodValidationPipe(createAiTaskRequestSchema)) input: CreateAiTaskRequest,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.aiTaskService.createTask(request.author.id, workId, chapterId, input);
    // 幂等命中（已有 succeeded + 结果修订集）返回 200；新建返回 201
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return ok(request, { task: result.task });
  }

  // ── 列出章节任务 ──

  @Get('chapters/:chapterId/ai-tasks')
  async listAiTasks(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Query(new ZodValidationPipe(listAiTasksQuerySchema)) query: ListAiTasksQuery
  ) {
    return ok(request, await this.aiTaskService.listTasks(request.author.id, workId, chapterId, query));
  }

  // ── 单任务详情 ──

  @Get('ai-tasks/:taskId')
  async getAiTask(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('taskId') taskId: string
  ) {
    return ok(request, await this.aiTaskService.getTask(request.author.id, workId, taskId));
  }

  // ── 重试 ──

  @Post('ai-tasks/:taskId/retry')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async retryAiTask(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('taskId') taskId: string
  ) {
    return ok(request, await this.aiTaskService.retryTask(request.author.id, workId, taskId));
  }

  // ── 取消 ──

  @Post('ai-tasks/:taskId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async cancelAiTask(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('taskId') taskId: string
  ) {
    return ok(request, await this.aiTaskService.cancelTask(request.author.id, workId, taskId));
  }

  // ── SSE 进度推送 ──

  @Get('ai-tasks/:taskId/events')
  async streamAiTaskEvents(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('taskId') taskId: string,
    @Query(new ZodValidationPipe(listAiTaskEventsQuerySchema)) query: ListAiTaskEventsQuery,
    @Res() response: Response
  ): Promise<void> {
    const lastEventId = (request.headers['last-event-id'] as string | undefined) ?? null;
    await this.aiTaskSseService.handleEvents({
      authorId: request.author.id,
      workId,
      taskId,
      request: request as unknown as Request,
      response,
      lastEventId,
      ...(query.since != null ? { since: query.since } : {})
    });
  }
}
