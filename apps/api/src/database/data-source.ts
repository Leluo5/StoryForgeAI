import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { AuthorEntity } from './author.entity';
import { SessionEntity } from './session.entity';
import { WorkEntity } from './work.entity';
import { VolumeEntity } from './volume.entity';
import { ChapterEntity } from './chapter.entity';
import { ChapterChangeEntity } from './chapter-change.entity';
import { RevisionSetEntity } from './revision-set.entity';
import { VersionSnapshotEntity } from './version-snapshot.entity';
import { CommentThreadEntity } from './comment-thread.entity';
import { TodoEntity } from './todo.entity';
import { NotificationEntity } from './notification.entity';
import { AuditLogEntity } from './audit-log.entity';
import { AiTaskEntity } from './ai-task.entity';
import { AiTaskEventEntity } from './ai-task-event.entity';
import { AgentEntity } from './agent.entity';
import { AiToolEntity } from './ai-tool.entity';
import { PlotTreeEntity } from './plot-tree.entity';
import { PlotGroupEntity } from './plot-group.entity';
import { PlotNodeEntity } from './plot-node.entity';
import { PlotLinkEntity } from './plot-link.entity';
import { DerivationSessionEntity } from './derivation-session.entity';
import { DerivationStepEntity } from './derivation-step.entity';
import { DerivationCandidateEntity } from './derivation-candidate.entity';
import { PlotGenerationDraftEntity } from './plot-generation-draft.entity';
import { FlowProgressEntity } from './flow-progress.entity';
import { AgentGroupOverrideEntity } from './agent-group-override.entity';
import { RoleAgentBindingEntity } from './role-agent-binding.entity';
import { CharacterEntity } from './character.entity';
import { CharacterAliasEntity } from './character-alias.entity';
import { CharacterRelationTypeEntity } from './character-relation-type.entity';
import { CharacterRelationEntity } from './character-relation.entity';
import { CharacterViewEntity } from './character-view.entity';
import { CharacterViewNodeEntity } from './character-view-node.entity';
import { CharacterGrowthEventEntity } from './character-growth-event.entity';
import { CharacterAvatarAssetEntity } from './character-avatar-asset.entity';
import { CharacterAiDraftEntity } from './character-ai-draft.entity';
import { CharacterAiCandidateItemEntity } from './character-ai-candidate-item.entity';
import { CharacterPortabilityJobEntity } from './character-portability-job.entity';
import { CharacterTextAnchorEntity } from './character-text-anchor.entity';
import { CharacterArchiveScanEntity } from './character-archive-scan.entity';
import { PlotNodeCharacterOwnerEntity } from './plot-node-character-owner.entity';
import { CollabSettingEntity } from './collab-setting.entity';
import { RoleProfileWritebackEntity } from './role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from './role-profile-writeback-field.entity';
import { AgentTaskCitationEntity } from './agent-task-citation.entity';
import { AgentArchiveOutboxEntity } from './agent-archive-outbox.entity';
import { KnowledgeEntryEntity } from './knowledge-entry.entity';
import { AuthBase1736899200000 } from './migrations/1736899200000-auth-base';
import { WritingBase1736985600000 } from './migrations/1736985600000-writing-base';
import { RevisionBase1760000000000 } from './migrations/1760000000000-revision-base';
import { AiTaskBase1760100000000 } from './migrations/1760100000000-ai-task-base';
import { AgentConfigBase1760200000000 } from './migrations/1760200000000-agent-config-base';
import { PlotBase1760300000000 } from './migrations/1760300000000-plot-base';
import { AiTaskPlotScope1760300001000 } from './migrations/1760300001000-ai-task-plot-scope';
import { DerivationSessionStartNodeNoFk1760300002000 } from './migrations/1760300002000-derivation-session-start-node-no-fk';
import { AgentProjectLevelUp1760400000000 } from './migrations/1760400000000-agent-project-level-up';
import { CharacterBase1760500000000 } from './migrations/1760500000000-character-base';
import { AiTaskCharacterScope1760500001000 } from './migrations/1760500001000-ai-task-character-scope';
import { CharacterRelationTypeSeed1760500002000 } from './migrations/1760500002000-character-relation-type-seed';
import { CharacterAnchors1760500003000 } from './migrations/1760500003000-character-anchors';
import { PlotNodeCharacterOwners1760500004000 } from './migrations/1760500004000-plot-node-character-owners';
import { CharacterAiTools1760500005000 } from './migrations/1760500005000-character-ai-tools';
import { CollabBase1760700000000 } from './migrations/1760700000000-collab-base';
import { AiTaskRoleProfileScope1760700001000 } from './migrations/1760700001000-ai-task-role-profile-scope';
import { KnowledgeBase1760600000000 } from './migrations/1760600000000-knowledge-base';

export function createDataSource(databaseUrl: string = env.DATABASE_URL): DataSource {
  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [
      AuthorEntity,
      SessionEntity,
      WorkEntity,
      VolumeEntity,
      ChapterEntity,
      ChapterChangeEntity,
      RevisionSetEntity,
      VersionSnapshotEntity,
      CommentThreadEntity,
      TodoEntity,
      NotificationEntity,
      AuditLogEntity,
      AiTaskEntity,
      AiTaskEventEntity,
      AgentEntity,
      AiToolEntity,
      PlotTreeEntity,
      PlotGroupEntity,
      PlotNodeEntity,
      PlotLinkEntity,
      DerivationSessionEntity,
      DerivationStepEntity,
      DerivationCandidateEntity,
      PlotGenerationDraftEntity,
      FlowProgressEntity,
      AgentGroupOverrideEntity,
      RoleAgentBindingEntity,
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
      CollabSettingEntity,
      RoleProfileWritebackEntity,
      RoleProfileWritebackFieldEntity,
      AgentTaskCitationEntity,
      AgentArchiveOutboxEntity,
      KnowledgeEntryEntity
    ],
    migrations: [
      AuthBase1736899200000,
      WritingBase1736985600000,
      RevisionBase1760000000000,
      AiTaskBase1760100000000,
      AgentConfigBase1760200000000,
      PlotBase1760300000000,
      AiTaskPlotScope1760300001000,
      DerivationSessionStartNodeNoFk1760300002000,
      AgentProjectLevelUp1760400000000,
      CharacterBase1760500000000,
      AiTaskCharacterScope1760500001000,
      CharacterRelationTypeSeed1760500002000,
      CharacterAnchors1760500003000,
      PlotNodeCharacterOwners1760500004000,
      CharacterAiTools1760500005000,
      CollabBase1760700000000,
      AiTaskRoleProfileScope1760700001000,
      KnowledgeBase1760600000000
    ],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
}

export const AppDataSource = createDataSource();
