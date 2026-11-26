// M4-T4 Agent 分组入口 · 接口层单测
// 验证：tree 从 query 带 project_id（偏差 3 裁决）、override upsert/delete、manual 创建/删除、setAgentGroup 经 updateAgentV2 承载（偏差 2 裁决）。
// 守卫与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentGroupController } from './agent-group.controller';
import { AgentGroupService } from './agent-group.service';
import { AgentService } from './agent.service';
import type { AuthenticatedRequest } from '../common/http';

const AUTHOR_ID = randomUUID();
const PID = randomUUID();

function req(): AuthenticatedRequest {
  return {
    requestId: 'req-t4-group',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' }
  } as unknown as AuthenticatedRequest;
}

describe('AgentGroupController · M4-T4 分组端点编排', () => {
  let controller: AgentGroupController;
  const groupService = {
    getTreeData: vi.fn(),
    upsertOverride: vi.fn(),
    deleteOverride: vi.fn(),
    createManualGroup: vi.fn(),
    deleteManualGroup: vi.fn()
  };
  const agentService = { updateAgentV2: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    groupService.getTreeData.mockResolvedValue([{ key: 'project:', name: '默认', sort_order: 0, hidden: false, is_manual: false, children: [], agent_ids: [] }]);
    groupService.upsertOverride.mockResolvedValue({ key: 'flow:1', name: '开篇' });
    groupService.deleteOverride.mockResolvedValue(true);
    groupService.createManualGroup.mockResolvedValue({ id: randomUUID(), parent_key: 'project:', name: '新分组', sort_order: 0 });
    groupService.deleteManualGroup.mockResolvedValue(true);
    agentService.updateAgentV2.mockImplementation(async (_authorId: string, _agentId: string, input: { manual_group_key: string | null }) => ({ id: randomUUID(), manual_group_key: input.manual_group_key }));
    controller = new AgentGroupController(
      groupService as unknown as AgentGroupService,
      agentService as unknown as AgentService
    );
  });

  it('getTree：透传 author.id + query project_id', async () => {
    const res = await controller.getTree(req(), PID);
    expect(groupService.getTreeData).toHaveBeenCalledWith(AUTHOR_ID, PID);
    expect(res.request_id).toBe('req-t4-group');
    expect(res.data[0]!.key).toBe('project:');
  });

  it('upsertOverride：拆分 project_id/key 并透传可选字段', async () => {
    const res = await controller.upsertOverride(req(), { project_id: PID, key: 'flow:1', name: '开篇', sort_order: 2 });
    expect(groupService.upsertOverride).toHaveBeenCalledWith(PID, 'flow:1', { name: '开篇', sort_order: 2 });
    expect(res.data.name).toBe('开篇');
  });

  it('upsertOverride：无可选字段时传空对象（exactOptionalPropertyTypes）', async () => {
    await controller.upsertOverride(req(), { project_id: PID, key: 'flow:1' });
    expect(groupService.upsertOverride).toHaveBeenCalledWith(PID, 'flow:1', {});
  });

  it('deleteOverride：透传 query project_id + key', async () => {
    const res = await controller.deleteOverride(req(), { project_id: PID, key: 'flow:1' });
    expect(groupService.deleteOverride).toHaveBeenCalledWith(PID, 'flow:1');
    expect(res.data.success).toBe(true);
  });

  it('createManualGroup：拆分并透传（含默认 parent_key/sort_order）', async () => {
    const res = await controller.createManualGroup(req(), { project_id: PID, parent_key: 'project:', name: '新分组', sort_order: 0 });
    expect(groupService.createManualGroup).toHaveBeenCalledWith(PID, 'project:', '新分组', 0);
    expect((res.data as unknown as { name: string }).name).toBe('新分组');
  });

  it('deleteManualGroup：透传 project_id + groupId', async () => {
    const gid = randomUUID();
    const res = await controller.deleteManualGroup(req(), gid, PID);
    expect(groupService.deleteManualGroup).toHaveBeenCalledWith(PID, gid);
    expect(res.data.success).toBe(true);
  });

  it('setAgentGroup：经 updateAgentV2 承载 manual_group_key（偏差 2 裁决，纯 uuid）', async () => {
    const agentId = randomUUID();
    const gid = randomUUID();
    const res = await controller.setAgentGroup(req(), agentId, { manual_group_key: gid });
    expect(agentService.updateAgentV2).toHaveBeenCalledWith(AUTHOR_ID, agentId, { manual_group_key: gid });
    expect(res.data.manual_group_key).toBe(gid);
  });

  it('setAgentGroup：null 回落自动分组', async () => {
    const agentId = randomUUID();
    await controller.setAgentGroup(req(), agentId, { manual_group_key: null });
    expect(agentService.updateAgentV2).toHaveBeenCalledWith(AUTHOR_ID, agentId, { manual_group_key: null });
  });
});
