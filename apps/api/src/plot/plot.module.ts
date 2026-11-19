import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotLinkEntity } from '../database/plot-link.entity';
import { PlotGroupEntity } from '../database/plot-group.entity';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';
import { DerivationCandidateEntity } from '../database/derivation-candidate.entity';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { AuditLogEntity } from '../database/audit-log.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { PlotGenerationDraftEntity } from '../database/plot-generation-draft.entity';
import { AuditService } from '../revision/audit.service';
import { AuthModule } from '../auth/auth.module';
import { AgentModule } from '../agent/agent.module';
import { AiTaskModule } from '../ai/ai-task.module';
import { PlotController } from './plot.controller';
import { PlotTreeService } from './plot-tree.service';
import { PlotDerivationService } from './plot-derivation.service';
import { PlotGenerationController } from './plot-generation.controller';
import { PlotGenerationService } from './plot-generation.service';

// M3c-1 剧情模块：剧情树 + 推衍 + 自动建树草稿
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlotTreeEntity,
      PlotNodeEntity,
      PlotLinkEntity,
      PlotGroupEntity,
      DerivationSessionEntity,
      DerivationStepEntity,
      DerivationCandidateEntity,
      AiTaskEntity,
      AiTaskEventEntity,
      WorkEntity,
      ChapterEntity,
      PlotGenerationDraftEntity,
      AuditLogEntity
    ]),
    AuthModule,
    AgentModule,
    AiTaskModule
  ],
  providers: [PlotTreeService, PlotDerivationService, PlotGenerationService, AuditService],
  controllers: [PlotController, PlotGenerationController],
  exports: [PlotTreeService, PlotDerivationService, PlotGenerationService]
})
export class PlotModule {}
