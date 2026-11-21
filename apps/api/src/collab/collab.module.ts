import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';
import { WorkEntity } from '../database/work.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { AuthModule } from '../auth/auth.module';
import { AiTaskModule } from '../ai/ai-task.module';
import { CollabService } from './collab.service';
import { CollabReadinessService } from './collab-readiness.service';
import { CollabController } from './collab.controller';
import { CollabTaskService } from './collab-task.service';
import { CollabTaskController } from './collab-task.controller';
import { AgentChannelRegistry } from './channel/agent-channel.registry';
import { FlowiseChannel } from './channel/flowise.channel';
import { CozeChannel } from './channel/coze.channel';
import { FastGptClient } from './retrieval/fastgpt.client';
import { CollabTaskHandler } from './collab-task.handler';
import { CollabWritebackService } from './collab-writeback.service';
import { CollabRevertService } from './collab-revert.service';
import { CollabArchiveService } from './collab-archive.service';
import { CollabArchiveQueue } from './collab-archive.queue';
import { CollabArchiveProcessor } from './collab-archive.processor';
import { COLLAB_WRITEBACK_PORT } from './collab-writeback.port';
import { AuditService } from '../revision/audit.service';

/**
 * F11 多平台 Agent 协同模块。
 * 组装：CollabService + 通道注册表 + REST 控制器 + 写回服务。
 * 依赖鉴权（SessionGuard → AuthModule）；导出 CollabService 供后续任务编排复用。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CollabSettingEntity,
      CharacterEntity,
      AgentEntity,
      WorkEntity,
      RoleProfileWritebackEntity,
      RoleProfileWritebackFieldEntity,
      AgentArchiveOutboxEntity
    ]),
    AuthModule,
    forwardRef(() => AiTaskModule)
  ],
  providers: [
    CollabService,
    CollabReadinessService,
    CollabTaskService,
    AgentChannelRegistry,
    FlowiseChannel,
    CozeChannel,
    FastGptClient,
    CollabTaskHandler,
    CollabRevertService,
    CollabArchiveService,
    CollabArchiveQueue,
    CollabArchiveProcessor,
    AuditService,
    { provide: COLLAB_WRITEBACK_PORT, useClass: CollabWritebackService }
  ],
  controllers: [CollabController, CollabTaskController],
  exports: [CollabService, CollabTaskService, AgentChannelRegistry, FastGptClient, CollabTaskHandler, CollabArchiveService, CollabArchiveQueue]
})
export class CollabModule {}
