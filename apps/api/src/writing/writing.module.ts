import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { WorkController } from './work.controller';
import { WorkService } from './work.service';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { ChapterSaveController } from './chapter-save.controller';
import { ChapterSaveService } from './chapter-save.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkEntity, VolumeEntity, ChapterEntity, ChapterChangeEntity]),
    AuthModule
  ],
  providers: [WorkService, StructureService, ChapterSaveService],
  controllers: [WorkController, StructureController, ChapterSaveController],
  exports: [WorkService]
})
export class WritingModule {}
