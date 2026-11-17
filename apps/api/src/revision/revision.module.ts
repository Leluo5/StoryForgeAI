import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { VersionSnapshotEntity } from '../database/version-snapshot.entity';
import { CommentThreadEntity } from '../database/comment-thread.entity';
import { TodoEntity } from '../database/todo.entity';
import { NotificationEntity } from '../database/notification.entity';
import { AuditLogEntity } from '../database/audit-log.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { RevisionService } from './revision.service';
import { VersionService } from './version.service';
import { CommentService } from './comment.service';
import { TodoService } from './todo.service';
import { NotificationService } from './notification.service';
import { AuditService } from './audit.service';
import { NotificationController, RevisionController } from './revision.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RevisionSetEntity,
      VersionSnapshotEntity,
      CommentThreadEntity,
      TodoEntity,
      NotificationEntity,
      AuditLogEntity,
      WorkEntity,
      ChapterEntity
    ]),
    AuthModule
  ],
  controllers: [RevisionController, NotificationController],
  providers: [RevisionService, VersionService, CommentService, TodoService, NotificationService, AuditService],
  exports: [RevisionService, VersionService, CommentService, TodoService, NotificationService, AuditService]
})
export class RevisionModule {}
