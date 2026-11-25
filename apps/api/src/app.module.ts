import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppDataSource } from './database/data-source';
import { HealthController } from './health.controller';
import { WritingModule } from './writing/writing.module';
import { RevisionModule } from './revision/revision.module';
import { AiTaskModule } from './ai/ai-task.module';
import { AgentModule } from './agent/agent.module';
import { PlotModule } from './plot/plot.module';
import { CharacterModule } from './character/character.module';
import { ArkClawModule } from './arkclaw/arkclaw.module';
import { CollabModule } from './collab/collab.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { WorkflowModule } from './workflow/workflow.module';
import { ModelModule } from './model/model.module';
import { SiteConfigModule } from './site-config/site-config.module';
import { ChatRoomModule } from './chat-room/chat-room.module';

@Module({
  imports: [TypeOrmModule.forRoot({ ...AppDataSource.options }), AuthModule, WritingModule, RevisionModule, AiTaskModule, AgentModule, PlotModule, CharacterModule, ArkClawModule, CollabModule, KnowledgeModule, WorkflowModule, ModelModule, SiteConfigModule, ChatRoomModule],
  controllers: [HealthController]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
