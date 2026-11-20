import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CharacterEntity } from '../database/character.entity';
import { CharacterAliasEntity } from '../database/character-alias.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterViewEntity } from '../database/character-view.entity';
import { CharacterViewNodeEntity } from '../database/character-view-node.entity';
import { CharacterGrowthEventEntity } from '../database/character-growth-event.entity';
import { CharacterAvatarAssetEntity } from '../database/character-avatar-asset.entity';
import { CharacterAiDraftEntity } from '../database/character-ai-draft.entity';
import { CharacterAiCandidateItemEntity } from '../database/character-ai-candidate-item.entity';
import { CharacterPortabilityJobEntity } from '../database/character-portability-job.entity';
import { CharacterTextAnchorEntity } from '../database/character-text-anchor.entity';
import { CharacterArchiveScanEntity } from '../database/character-archive-scan.entity';
import { PlotNodeCharacterOwnerEntity } from '../database/plot-node-character-owner.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { AuditLogEntity } from '../database/audit-log.entity';
import { AuditService } from '../revision/audit.service';
import { AuthModule } from '../auth/auth.module';
import { PlotOwnerService } from '../plot/plot-owner.service';
import { CharacterController } from './character.controller';
import { CharacterRelationController } from './character-relation.controller';
import { CharacterViewController } from './character-view.controller';
import { CharacterGrowthController } from './character-growth.controller';
import { CharacterAvatarController } from './character-avatar.controller';
import { CharacterAiController } from './character-ai.controller';
import { CharacterAnchorController } from './character-anchor.controller';
import { CharacterPortabilityController } from './character-portability.controller';
import { CharacterTaskHandler } from './character-task.handler';
import { CharacterService } from './character.service';
import { CharacterRelationService, CharacterRelationTypeService } from './character-relation.service';
import { CharacterViewService } from './character-view.service';
import { CharacterGrowthService } from './character-growth.service';
import { CharacterAvatarService } from './character-avatar.service';
import { CharacterAiService } from './character-ai.service';
import { CharacterPortabilityService } from './character-portability.service';
import { CharacterArchiveScanService } from './character-scan.service';
import { CharacterAnchorService } from './character-anchor.service';
import { CharacterAvatarModelProvider } from './character-model.provider';
import { AiTaskModule } from '../ai/ai-task.module';

// M3c-2 角色版图模块：角色 / 关系 / 视图 / 成长线 / 归档锚点
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CharacterEntity,
      CharacterAliasEntity,
      CharacterRelationTypeEntity,
      CharacterRelationEntity,
      CharacterViewEntity,
      CharacterViewNodeEntity,
      CharacterGrowthEventEntity,
      CharacterAvatarAssetEntity,
      CharacterAiDraftEntity,
      CharacterAiCandidateItemEntity,
      CharacterPortabilityJobEntity,
      CharacterTextAnchorEntity,
      CharacterArchiveScanEntity,
      PlotNodeCharacterOwnerEntity,
      WorkEntity,
      ChapterEntity,
      PlotNodeEntity,
      PlotTreeEntity,
      AiTaskEntity,
      AiTaskEventEntity,
      AuditLogEntity
    ]),
    AuthModule,
    forwardRef(() => AiTaskModule)
  ],
  providers: [
    CharacterService,
    CharacterRelationTypeService,
    CharacterRelationService,
    CharacterViewService,
    CharacterGrowthService,
    CharacterAvatarService,
    CharacterAiService,
    CharacterPortabilityService,
    CharacterArchiveScanService,
    CharacterAnchorService,
    PlotOwnerService,
    CharacterAvatarModelProvider,
    CharacterTaskHandler,
    AuditService
  ],
  controllers: [
    CharacterController,
    CharacterRelationController,
    CharacterViewController,
    CharacterGrowthController,
    CharacterAvatarController,
    CharacterAiController,
    CharacterAnchorController,
    CharacterPortabilityController
  ],
  exports: [
    CharacterService,
    CharacterRelationService,
    CharacterRelationTypeService,
    CharacterViewService,
    CharacterGrowthService,
    CharacterArchiveScanService,
    CharacterAnchorService,
    CharacterAiService,
    CharacterAvatarService,
    CharacterTaskHandler
  ]
})
export class CharacterModule {}
