// M4-T4 Agent 生命周期入口 · 接口层单测
// 验证：端点编排（AgentService.archive/restore/listVersions/rollbackVersion 透传 + author.id）+ ok() 包装。
// 守卫与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
// 注意：装饰器元数据（@UseGuards/@HttpCode）在单测环境不可靠，只测行为不测元数据。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentLifecycleController } from './agent-lifecycle.controller';
import { AgentService } from './agent.service';
import type { AuthenticatedRequest } from '../common/http';

const AUTHOR_ID = randomUUID();

function req(): AuthenticatedRequest {
  return {
    requestId: 'req-t4-lifecycle',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' }
  } as unknown as AuthenticatedRequest;
}

describe('AgentLifecycleController · M4-T4 生命周期与版本端点编排', () => {
  let controller: AgentLifecycleController;
  const agentService = {
    archiveAgent: vi.fn(),
    restoreAgent: vi.fn(),
    listVersions: vi.fn(),
    rollbackVersion: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    agentService.archiveAgent.mockResolvedValue({ id: randomUUID(), status: 'archived' });
    agentService.restoreAgent.mockResolvedValue({ id: randomUUID(), status: 'active' });
    agentService.listVersions.mockResolvedValue([{ version_no: 1, change_type: 'create', note: '', created_at: '' }]);
    agentService.rollbackVersion.mockResolvedValue({ id: randomUUID(), version_no: 3 });
    controller = new AgentLifecycleController(agentService as unknown as AgentService);
  });

  it('archiveAgent：透传 author.id + agentId', async () => {
    const agentId = randomUUID();
    const res = await controller.archiveAgent(req(), agentId);
    expect(agentService.archiveAgent).toHaveBeenCalledWith(AUTHOR_ID, agentId);
    expect(res.request_id).toBe('req-t4-lifecycle');
    expect(res.data.status).toBe('archived');
  });

  it('restoreAgent：透传 author.id + agentId', async () => {
    const agentId = randomUUID();
    const res = await controller.restoreAgent(req(), agentId);
    expect(agentService.restoreAgent).toHaveBeenCalledWith(AUTHOR_ID, agentId);
    expect(res.data.status).toBe('active');
  });

  it('listVersions：透传 author.id + agentId，返回摘要数组', async () => {
    const agentId = randomUUID();
    const res = await controller.listVersions(req(), agentId);
    expect(agentService.listVersions).toHaveBeenCalledWith(AUTHOR_ID, agentId);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it('rollback：解析 versionNo 并透传', async () => {
    const agentId = randomUUID();
    const res = await controller.rollback(req(), agentId, '5');
    expect(agentService.rollbackVersion).toHaveBeenCalledWith(AUTHOR_ID, agentId, 5);
    expect(res.data.version_no).toBe(3);
  });

  it('rollback：非数字 versionNo 传给服务（服务负责 404/校验）', async () => {
    const agentId = randomUUID();
    agentService.rollbackVersion.mockRejectedValue(new Error('version not found'));
    await expect(controller.rollback(req(), agentId, 'abc')).rejects.toThrow('version not found');
  });

  it('归档：服务抛错透传（不吞异常）', async () => {
    agentService.archiveAgent.mockRejectedValue(new Error('not owner'));
    await expect(controller.archiveAgent(req(), randomUUID())).rejects.toThrow('not owner');
  });
});
