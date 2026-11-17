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
      AuditLogEntity
    ]),
    AuthModule
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
    { provide: AI_MODEL_PROVIDER, useClass: MockAiModelProvider }
  ],
  controllers: [AiTaskController],
  exports: [AiTaskService, AiTaskSseService, AiTaskProcessor]
})
export class AiTaskModule {}
