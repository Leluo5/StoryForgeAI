import { Module, forwardRef, type OnModuleInit, Inject, Injectable } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';
import { WorkEntity } from '../database/work.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { AuthModule } from '../auth/auth.module';
import { AiTaskModule } from '../ai/ai-task.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { AgentModule } from '../agent/agent.module';
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
import { CozeImportClient } from './coze-import.client';
import { CozeImportService } from './coze-import.service';
import { CozeImportController } from './coze-import.controller';
import { WorkflowRunHandler } from './workflow-run.handler';

/**
 * 通道装配：把 Flowise / Coze 实现注册进 AgentChannelRegistry。
 * 注册表本身不感知具体厂商（端口隔离），装配职责集中在此。
 */
@Injectable()
export class CollabChannelBootstrap implements OnModuleInit {
  constructor(
    @Inject(AgentChannelRegistry) private readonly registry: AgentChannelRegistry,
    @Inject(FlowiseChannel) private readonly flowise: FlowiseChannel,
    @Inject(CozeChannel) private readonly coze: CozeChannel
  ) {}

  onModuleInit(): void {
    if (!this.registry.has('flowise')) this.registry.register(this.flowise);
    if (!this.registry.has('coze')) this.registry.register(this.coze);
  }
}

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
      AgentArchiveOutboxEntity,
      KnowledgeEntryEntity
    ]),
    AuthModule,
    forwardRef(() => AiTaskModule),
    SiteConfigModule,
    AgentModule
  ],
  providers: [
    CollabService,
    CollabReadinessService,
    CollabTaskService,
    AgentChannelRegistry,
    FlowiseChannel,
    CozeChannel,
    CollabChannelBootstrap,
    FastGptClient,
    CollabTaskHandler,
    CollabRevertService,
    CollabArchiveService,
    CollabArchiveQueue,
    CollabArchiveProcessor,
    AuditService,
    CozeImportClient,
    CozeImportService,
    WorkflowRunHandler,
    { provide: COLLAB_WRITEBACK_PORT, useClass: CollabWritebackService }
  ],
  controllers: [CollabController, CollabTaskController, CozeImportController],
  exports: [CollabService, CollabTaskService, AgentChannelRegistry, FastGptClient, CollabTaskHandler, CollabArchiveService, CollabArchiveQueue, CozeImportClient, WorkflowRunHandler]
})
export class CollabModule {}
