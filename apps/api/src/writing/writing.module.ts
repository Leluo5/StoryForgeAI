import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { WorkController } from './work.controller';
import { WorkService } from './work.service';
import { WorkUploadService } from './work-upload.service';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { ChapterSaveController } from './chapter-save.controller';
import { ChapterSaveService } from './chapter-save.service';
import { ExperienceController } from './experience.controller';
import { ExperienceService } from './experience.service';
import { env } from '../config/env';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkEntity, VolumeEntity, ChapterEntity, ChapterChangeEntity]),
    AuthModule
  ],
  providers: [
    WorkService,
    StructureService,
    ChapterSaveService,
    ExperienceService,
    {
      provide: WorkUploadService,
      useFactory: (dataSource: DataSource) => new WorkUploadService(dataSource, env.WORK_UPLOADS_DIR),
      inject: [DataSource]
    }
  ],
  controllers: [WorkController, StructureController, ChapterSaveController, ExperienceController],
  exports: [WorkService, WorkUploadService]
})
export class WritingModule {}
