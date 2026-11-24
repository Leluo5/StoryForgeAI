import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModelEntity } from '../database/model.entity';
import { ModelController } from './model.controller';
import { ModelService } from './model.service';
import { AuthModule } from '../auth/auth.module';

/**
 * 模型管理模块（/ai-models）。
 * 依赖鉴权（SessionGuard → AuthModule）；导出 ModelService 供后续调用方复用。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ModelEntity]), AuthModule],
  controllers: [ModelController],
  providers: [ModelService],
  exports: [ModelService]
})
export class ModelModule {}
