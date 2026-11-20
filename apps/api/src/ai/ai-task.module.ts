import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { VersionSnapshotEntity } from '../database/version-snapshot.entity';
import { AuditLogEntity } from '../database/audit-log.entity';
import { AuditService } from '../revision/audit.service';
import { AiTaskService, AI_TASK_QUEUE } from './ai-task.service';
import { AiTaskQueue } from './ai-task.queue';
import { AiTaskProcessor, AI_RESULT_MAPPER } from './ai-task.processor';
import { AiTaskEventBus, AI_TASK_EVENT_BUS, AiTaskSseService } from './ai-task.sse';
import { AiResultMapper } from './ai-result.mapper';
import { MockAiModelProvider, AI_MODEL_PROVIDER } from './ai-model.provider';
import { AiTaskController } from './ai-task.controller';
import { AgentModule } from '../agent/agent.module';
import { env } from '../config/env';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotGenerationDraftEntity } from '../database/plot-generation-draft.entity';
import { PlotTaskHandler } from '../plot/plot-task.handler';
import { MockPlotModelProvider, PLOT_MODEL_PROVIDER } from '../plot/plot-model.provider';

/**
 * AI 创作基座模块（M3a）。
 * 组装：任务服务 + BullMQ 队列 + Worker + 事件总线/SSE + AI 模型 Provider + 结果映射。
 * 依赖 M2 修订集（RevisionSetEntity）与审计（AuditService）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiTaskEntity,
      AiTaskEventEntity,
      WorkEntity,
      ChapterEntity,
      RevisionSetEntity,
      VersionSnapshotEntity,
      AuditLogEntity,
      DerivationSessionEntity,
      DerivationStepEntity,
      PlotNodeEntity,
      PlotGenerationDraftEntity
    ]),
    AuthModule,
    AgentModule
  ],
  providers: [
    AuditService,
    AiTaskService,
    { provide: AI_TASK_QUEUE, useClass: AiTaskQueue },
    AiTaskProcessor,
    AiTaskEventBus,
    { provide: AI_TASK_EVENT_BUS, useExisting: AiTaskEventBus },
    AiTaskSseService,
    { provide: AI_RESULT_MAPPER, useClass: AiResultMapper },
    // Mock 模型：E2E（NODE_ENV=test）下加 400ms 延迟，制造「发起→消费完成」的可观测窗口，
    // 供状态机/取消用例捕获 queued/running 状态；单测直接 new MockAiModelProvider() 不受影响，生产/开发延迟为 0。
    { provide: AI_MODEL_PROVIDER, useFactory: () => new MockAiModelProvider({ latencyMs: env.NODE_ENV === 'test' ? 400 : 0 }) },
    // 剧情推衍模型（M3c）：与章节创作模型隔离
    PlotTaskHandler,
    { provide: PLOT_MODEL_PROVIDER, useFactory: () => new MockPlotModelProvider({ delayMs: env.NODE_ENV === 'test' ? 200 : 0 }) }
  ],
  controllers: [AiTaskController],
  exports: [AiTaskService, AiTaskSseService, AiTaskProcessor, AI_TASK_QUEUE, AI_TASK_EVENT_BUS]
})
export class AiTaskModule {}
