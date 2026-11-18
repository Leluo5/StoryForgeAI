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
import { AuditService } from '../revision/audit.service';
import { AuthModule } from '../auth/auth.module';
import { AgentModule } from '../agent/agent.module';
import { AiTaskModule } from '../ai/ai-task.module';
import { PlotController } from './plot.controller';
import { PlotTreeService } from './plot-tree.service';
import { PlotDerivationService } from './plot-derivation.service';

// M3c-1 剧情模块：剧情树（树/节点/关联/分组/导入导出）+ 推衍（会话/步骤/候选回写）
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
      AuditLogEntity
    ]),
    AuthModule,
    AgentModule,
    AiTaskModule
  ],
  providers: [PlotTreeService, PlotDerivationService, AuditService],
  controllers: [PlotController],
  exports: [PlotTreeService, PlotDerivationService]
})
export class PlotModule {}
