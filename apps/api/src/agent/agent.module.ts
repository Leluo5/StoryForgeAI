import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentEntity } from '../database/agent.entity';
import { AiToolEntity } from '../database/ai-tool.entity';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { AuditService } from '../revision/audit.service';
import { AuditLogEntity } from '../database/audit-log.entity';
import { AuthModule } from '../auth/auth.module';
import { AgentVersionService } from './agent-version.service';
import { AgentGroupService } from './agent-group.service';
import { FlowProgressService } from './flow-progress.service';
import { AgentProvisionService } from './agent-provision.service';
import { FlowProgressEntity } from '../database/flow-progress.entity';
import { AgentGroupOverrideEntity } from '../database/agent-group-override.entity';
import { RoleAgentBindingEntity } from '../database/role-agent-binding.entity';

/**
 * Agent 配置与管理模块（M3b-B5）。
 * 组装：AgentService + REST 控制器 + V2 子服务。
 * 依赖 M2 审计（AuditService）与鉴权（SessionGuard → AuthModule）；
 * 导出 AgentService 供 AiTaskModule 发起任务解析复用。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentEntity,
      AiToolEntity,
      AuditLogEntity,
      FlowProgressEntity,
      AgentGroupOverrideEntity,
      RoleAgentBindingEntity
    ]),
    AuthModule
  ],
  providers: [
    AgentService,
    AuditService,
    AgentVersionService,
    AgentGroupService,
    FlowProgressService,
    AgentProvisionService
  ],
  controllers: [AgentController],
  exports: [
    AgentService,
    AgentVersionService,
    AgentGroupService,
    FlowProgressService,
    AgentProvisionService
  ]
})
export class AgentModule {}
