// M4-T4 Agent provision/工具开关/进度入口 · 接口层单测
// 验证：provision/bind-roles/reset-default/progress/reset/switch-tool 端点编排 + author.id 透传。
// R1：switch 路径带 projectId（以方案 4.2 表格为准）。
// R2：progress/reset 服务签名改 (authorId, roleId)，controller 透传 author.id。
// 守卫与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentProvisionController } from './agent-provision.controller';
import { AgentProvisionService } from './agent-provision.service';
import { FlowProgressService } from './flow-progress.service';
import type { AuthenticatedRequest } from '../common/http';

const AUTHOR_ID = randomUUID();

function req(): AuthenticatedRequest {
  return {
    requestId: 'req-t4-provision',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' }
  } as unknown as AuthenticatedRequest;
}

describe('AgentProvisionController · M4-T4 provision/进度/工具开关端点编排', () => {
  let controller: AgentProvisionController;
  const provisionService = {
    provisionProjectDefaults: vi.fn(),
    bindRoles: vi.fn(),
    resetRoleDefaultFlow: vi.fn(),
    switchToolDefault: vi.fn()
  };
  const progressService = {
    getProgress: vi.fn(),
    resetProgress: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provisionService.provisionProjectDefaults.mockResolvedValue({ flowAgents: 3, toolAgents: 1 });
    provisionService.bindRoles.mockResolvedValue(2);
    provisionService.resetRoleDefaultFlow.mockResolvedValue(1);
    provisionService.switchToolDefault.mockResolvedValue({ tool_name: '大纲', agent_id: randomUUID() });
    progressService.getProgress.mockResolvedValue({ status: 'idle', steps: [] });
    progressService.resetProgress.mockResolvedValue({ status: 'idle', steps: [] });
    controller = new AgentProvisionController(
      provisionService as unknown as AgentProvisionService,
      progressService as unknown as FlowProgressService
    );
  });

  it('provision：透传 author.id + projectId（body 空）', async () => {
    const pid = randomUUID();
    const res = await controller.provision(req(), pid);
    expect(provisionService.provisionProjectDefaults).toHaveBeenCalledWith(AUTHOR_ID, pid);
    expect(res.request_id).toBe('req-t4-provision');
    expect(res.data.flowAgents).toBe(3);
  });

  it('bindRoles：透传 author.id + projectId，返回 created 计数', async () => {
    const pid = randomUUID();
    const res = await controller.bindRoles(req(), pid);
    expect(provisionService.bindRoles).toHaveBeenCalledWith(AUTHOR_ID, pid);
    expect((res.data as unknown as { created: number }).created).toBe(2);
  });

  it('resetRoleDefaultFlow：透传 author.id + roleId + mode', async () => {
    const rid = randomUUID();
    const res = await controller.resetRoleDefaultFlow(req(), rid, { mode: 'fill' });
    expect(provisionService.resetRoleDefaultFlow).toHaveBeenCalledWith(AUTHOR_ID, rid, 'fill');
    expect(res.data.created).toBe(1);
  });

  it('resetRoleDefaultFlow：mode 透传 replace', async () => {
    const rid = randomUUID();
    await controller.resetRoleDefaultFlow(req(), rid, { mode: 'replace' });
    expect(provisionService.resetRoleDefaultFlow).toHaveBeenCalledWith(AUTHOR_ID, rid, 'replace');
  });

  it('getProgress（R2）：透传 author.id + roleId', async () => {
    const rid = randomUUID();
    const res = await controller.getProgress(req(), rid);
    expect(progressService.getProgress).toHaveBeenCalledWith(AUTHOR_ID, rid);
    expect(res.data.status).toBe('idle');
  });

  it('resetProgress（R2）：透传 author.id + roleId', async () => {
    const rid = randomUUID();
    const res = await controller.resetProgress(req(), rid);
    expect(progressService.resetProgress).toHaveBeenCalledWith(AUTHOR_ID, rid);
    expect(res.data.status).toBe('idle');
  });

  it('switchTool（R1）：透传 author.id + projectId + toolName + agent_id', async () => {
    const pid = randomUUID();
    const agentId = randomUUID();
    const res = await controller.switchTool(req(), pid, '大纲', { agent_id: agentId });
    expect(provisionService.switchToolDefault).toHaveBeenCalledWith(AUTHOR_ID, pid, '大纲', agentId);
    expect((res.data as unknown as { tool_name: string }).tool_name).toBe('大纲');
  });
});
