import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowEntity } from '../database/workflow.entity';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { WorkflowRunService } from './workflow-run.service';
import { AuthModule } from '../auth/auth.module';
import { AiTaskModule } from '../ai/ai-task.module';

/**
 * 工作流管理模块（/ai-workflows）。
 * 依赖鉴权（SessionGuard → AuthModule）；导出 WorkflowService 供后续调用方复用。
 * M4-T7：WorkflowRunService 经 AiTaskModule 复用 ai-task 队列（scope='workflow_run'）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([WorkflowEntity]), AuthModule, AiTaskModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowRunService],
  exports: [WorkflowService, WorkflowRunService]
})
export class WorkflowModule {}
