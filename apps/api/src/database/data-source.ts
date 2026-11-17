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
import { AuthBase1736899200000 } from './migrations/1736899200000-auth-base';
import { WritingBase1736985600000 } from './migrations/1736985600000-writing-base';
import { RevisionBase1760000000000 } from './migrations/1760000000000-revision-base';
import { AiTaskBase1760100000000 } from './migrations/1760100000000-ai-task-base';

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
      AiTaskEventEntity
    ],
    migrations: [AuthBase1736899200000, WritingBase1736985600000, RevisionBase1760000000000, AiTaskBase1760100000000],
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: false
  });
}

export const AppDataSource = createDataSource();
