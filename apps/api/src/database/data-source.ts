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
import { WorkflowEntity } from './workflow.entity';
import { ModelEntity } from './model.entity';
import { KnowledgeWorkRefEntity } from './knowledge-work-ref.entity';
import { KnowledgeTagEntity } from './knowledge-tag.entity';
import { KnowledgeEntryTagEntity } from './knowledge-entry-tag.entity';
import { KnowledgeEntryLinkEntity } from './knowledge-entry-link.entity';
import { KnowledgeEntryEmbeddingEntity } from './knowledge-entry-embedding.entity';
import { KnowledgeJobEntity } from './knowledge-job.entity';
import { KnowledgeJobEventEntity } from './knowledge-job-event.entity';
import { SiteConfigEntity } from './site-config.entity';
import { ChatRoomEntity } from './chat-room.entity';
import { ChatRoomEventEntity } from './chat-room-event.entity';
import { AgentVersionEntity } from '../agent/agent-version.entity';
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
import { WorkflowBase1760700002000 } from './migrations/1760700002000-workflow-base';
import { ModelBase1760700003000 } from './migrations/1760700003000-model-base';
import { KnowledgeVector1760600001000 } from './migrations/1760600001000-knowledge-vector';
import { WorkAccessCode1760800000000 } from './migrations/1760800000000-work-access-code';
import { WorkCozeBindings1760900000000 } from './migrations/1760900000000-work-coze-bindings';
import { SiteConfig1761000000000 } from './migrations/1761000000000-site-config';
import { CozeImportOrigin1761100000000 } from './migrations/1761100000000-coze-import-origin';
import { ChatRoom1761200000000 } from './migrations/1761200000000-chat-room';
import { AgentVersionTable1761300000000 } from './migrations/1761300000000-agent-version-table';
import { WorkflowRunScope1761400000000 } from './migrations/1761400000000-workflow-run-scope';
import { CharacterMapScope1761500000000 } from './migrations/1761500000000-character-map-scope';
import { CharacterMapTool1761500001000 } from './migrations/1761500001000-character-map-tool';

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
      KnowledgeEntryEntity,
      WorkflowEntity,
      ModelEntity,
      KnowledgeWorkRefEntity,
      KnowledgeTagEntity,
      KnowledgeEntryTagEntity,
      KnowledgeEntryLinkEntity,
      KnowledgeEntryEmbeddingEntity,
      KnowledgeJobEntity,
      KnowledgeJobEventEntity,
      SiteConfigEntity,
      ChatRoomEntity,
      ChatRoomEventEntity,
      AgentVersionEntity
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
      KnowledgeBase1760600000000,
      WorkflowBase1760700002000,
      ModelBase1760700003000,
      KnowledgeVector1760600001000,
      WorkAccessCode1760800000000,
      WorkCozeBindings1760900000000,
      SiteConfig1761000000000,
      CozeImportOrigin1761100000000,
      ChatRoom1761200000000,
      AgentVersionTable1761300000000,
      WorkflowRunScope1761400000000,
      CharacterMapScope1761500000000,
      CharacterMapTool1761500001000
    ],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
}

export const AppDataSource = createDataSource();

// M3c-3 知识库 T07：API 启动前检查 vector 扩展存在。
// 缺失时拒绝启动（知识库向量功能无法工作），输出明确错误而非静默降级。
export async function assertKnowledgeVectorExtension(dataSource: DataSource): Promise<void> {
  const row = await dataSource.query<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`
  );
  if (!row[0]?.exists) {
    throw new Error(
      'PostgreSQL 缺少 vector 扩展（知识库向量功能依赖）。' +
        '请使用 pgvector/pgvector:pg16 镜像启动数据库，并确认迁移 1760600001000-knowledge-vector 已执行。'
    );
  }
}
