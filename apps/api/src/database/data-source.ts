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
import { AuthBase1736899200000 } from './migrations/1736899200000-auth-base';
import { WritingBase1736985600000 } from './migrations/1736985600000-writing-base';
import { RevisionBase1760000000000 } from './migrations/1760000000000-revision-base';
import { AiTaskBase1760100000000 } from './migrations/1760100000000-ai-task-base';
import { AgentConfigBase1760200000000 } from './migrations/1760200000000-agent-config-base';
import { PlotBase1760300000000 } from './migrations/1760300000000-plot-base';
import { AiTaskPlotScope1760300001000 } from './migrations/1760300001000-ai-task-plot-scope';
import { DerivationSessionStartNodeNoFk1760300002000 } from './migrations/1760300002000-derivation-session-start-node-no-fk';
import { AgentProjectLevelUp1760400000000 } from './migrations/1760400000000-agent-project-level-up';

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
      RoleAgentBindingEntity
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
      AgentProjectLevelUp1760400000000
    ],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
}

export const AppDataSource = createDataSource();
