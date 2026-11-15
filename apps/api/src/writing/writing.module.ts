import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { WorkEntity } from '../database/work.entity';
import { VolumeEntity } from '../database/volume.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { WorkController } from './work.controller';
import { WorkService } from './work.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkEntity, VolumeEntity, ChapterEntity, ChapterChangeEntity]),
    AuthModule
  ],
  providers: [WorkService],
  controllers: [WorkController],
  exports: [WorkService]
})
export class WritingModule {}
