import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowEntity } from '../database/workflow.entity';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { AuthModule } from '../auth/auth.module';

/**
 * 工作流管理模块（/ai-workflows）。
 * 依赖鉴权（SessionGuard → AuthModule）；导出 WorkflowService 供后续调用方复用。
 */
@Module({
  imports: [TypeOrmModule.forFeature([WorkflowEntity]), AuthModule],
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService]
})
export class WorkflowModule {}
