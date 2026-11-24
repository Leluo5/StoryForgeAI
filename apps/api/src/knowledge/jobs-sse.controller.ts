// M3c-3 知识库 T24 SSE 端点（L3 接口层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§4.6；03-任务规划.md T24
// 职责：GET /knowledge/jobs/:jobId/events 的 controller（SSE 长连接）+ 权限（SessionGuard）+ 归属校验 + 流式头/心跳。
// 边界（L3 接口层）：只做编排与流式包装，业务逻辑全在 KnowledgeJobSseService.streamEvents（T12 已实现），不写新业务逻辑。
// 范式：对齐 apps/api/src/ai/ai-task.controller.ts L119-137 + ai-task.sse.ts L92-166（Express @Res 直接写帧）。
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import { knowledgeJobReplayQuerySchema } from '@storyforge/contracts';
import type { KnowledgeJobReplayQuery } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { type AuthenticatedRequest } from '../common/http';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeJobSseService, type SseSink } from './jobs.sse';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 知识库作业 SSE 接口层（M3c-3 v1.1 双层库口径）。
 * 路由：GET /api/v1/knowledge/jobs/:jobId/events（挂 SessionGuard，读流不加 CsrfGuard）。
 * 断线重连：Last-Event-ID 头 / ?after_seq= 查询参数；重放 after_seq 之后的事件，终态后关闭。
 */
@Controller('knowledge')
@UseGuards(SessionGuard)
export class KnowledgeJobsSseController {
  constructor(
    @Inject(KnowledgeJobService) private readonly jobs: KnowledgeJobService,
    @Inject(KnowledgeJobSseService) private readonly sse: KnowledgeJobSseService
  ) {}

  // ── §4.5 作业进度 SSE ──

  @Get('jobs/:jobId/events')
  @HttpCode(HttpStatus.OK)
  async streamJobEvents(
    @Req() request: AuthenticatedRequest,
    @Param('jobId') jobId: string,
    @Query(new ZodValidationPipe(knowledgeJobReplayQuerySchema)) query: KnowledgeJobReplayQuery,
    @Res() response: Response
  ): Promise<void> {
    // 1. 归属校验：作业须属于当前作者（streamEvents 内部只查存在，不查 owner）
    const job = await this.jobs.getJob(jobId);
    if (job.owner_id !== request.author.id) {
      throw new NotFoundException({ code: 'KNOWLEDGE_JOB_NOT_FOUND', message: '作业不存在' });
    }

    // 2. 游标：after_seq 查询参数优先，否则回退 Last-Event-ID 头
    const headerSeq = Number(request.headers['last-event-id'] ?? 0);
    const afterSeq = Number.isFinite(headerSeq) && query.after_seq == null
      ? headerSeq
      : (query.after_seq ?? 0);

    // 3. SSE 响应头（no-cache + keep-alive + 关闭代理缓冲）
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    // 4. sink：Express res 包装
    const sink: SseSink = {
      write: (data: string) => response.write(data),
      close: () => response.end()
    };

    // 5. 心跳（15s 注释帧保活）+ 断开清理（清心跳）。流结束由 sink.close 兜底。
    const heartbeat = setInterval(() => {
      response.write(': ping\n\n');
    }, HEARTBEAT_INTERVAL_MS);
    const cleanup = (): void => {
      clearInterval(heartbeat);
    };
    request.on('close', cleanup);

    // 6. 重放快照 + 实时订阅（streamEvents 内部：终态同步 close 返回；非终态订阅后即 resolve，不阻塞长连接）
    await this.sse.streamEvents(jobId, afterSeq, sink);
  }
}
