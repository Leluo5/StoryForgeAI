import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AgentService } from './agent.service';
import { AiTaskService, type AiTaskQueuePort } from '../ai/ai-task.service';
import { AiTaskEventBus } from '../ai/ai-task.sse';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiToolEntity } from '../database/ai-tool.entity';

let fixture: WritingFixture;
let service: AgentService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new AgentService(fixture.dataSource, { record: vi.fn() } as never, {} as never, {} as never, {} as never, {} as never);
});

afterEach(() => destroyWritingFixture(fixture));

function agentService(): AgentService {
  return new AgentService(fixture.dataSource, { record: vi.fn() } as never, {} as never, {} as never, {} as never, {} as never);
}

describe('AgentService', () => {
  // ── M3b-B3 createAgent ──

  it('creates an agent with default platform and empty model config', async () => {
    const { agent } = await service.createAgent(fixture.authorId, {
      name: '灵感助手', model_id: 'gpt-4o-mini'
    });
    expect(agent.name).toBe('灵感助手');
    expect(agent.platform).toBe('mock');
    expect(agent.model_config).toEqual({});
    expect(agent.status).toBe('active');
    expect(agent.is_default).toBe(false);
    expect(agent.author_id).toBe(fixture.authorId);
  });

  it('rejects duplicate agent name for the same author with 409', async () => {
    await service.createAgent(fixture.authorId, { name: '同名牌', model_id: 'm1' });
    await expect(service.createAgent(fixture.authorId, { name: '同名牌', model_id: 'm2' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('allows the same agent name for a different author', async () => {
    await service.createAgent(fixture.authorId, { name: '共用名', model_id: 'm1' });
    const { agent } = await service.createAgent(fixture.otherAuthorId, { name: '共用名', model_id: 'm2' });
    expect(agent.name).toBe('共用名');
  });

  it('enforces default exclusivity: creating a second default clears the first', async () => {
    const first = await service.createAgent(fixture.authorId, { name: '默认A', model_id: 'm1', is_default: true });
    const second = await service.createAgent(fixture.authorId, { name: '默认B', model_id: 'm2', is_default: true });
    // 断言 DB 实际状态（返回值是创建时刻快照，不反映后续互斥清除）
    const firstInDb = await fixture.dataSource.getRepository('AgentEntity').findOneByOrFail({ id: first.agent.id });
    expect(firstInDb.is_default).toBe(false);
    expect(second.agent.is_default).toBe(true);
  });

  // ── M3b-B3 updateAgent ──

  it('updates agent fields and preserves default exclusivity', async () => {
    const created = await service.createAgent(fixture.authorId, { name: '默认', model_id: 'm1', is_default: true });
    const updated = await service.updateAgent(fixture.authorId, created.agent.id, {
      name: '默认改名', model_id: 'm2', model_config: { temperature: 0.5 }
    });
    expect(updated.agent.name).toBe('默认改名');
    expect(updated.agent.model_id).toBe('m2');
    expect(updated.agent.model_config).toEqual({ temperature: 0.5 });
    expect(updated.agent.is_default).toBe(true); // 默认仍保持
  });

  it('rejects updating a non-owned or missing agent with 404', async () => {
    await expect(service.updateAgent(fixture.authorId, randomUUID(), { name: 'x' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('forbids disabling the default agent with 409', async () => {
    const created = await service.createAgent(fixture.authorId, { name: '默认', model_id: 'm1', is_default: true });
    await expect(service.updateAgent(fixture.authorId, created.agent.id, { status: 'disabled' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects renaming to a duplicate name with 409', async () => {
    await service.createAgent(fixture.authorId, { name: '甲', model_id: 'm1' });
    const b = await service.createAgent(fixture.authorId, { name: '乙', model_id: 'm2' });
    await expect(service.updateAgent(fixture.authorId, b.agent.id, { name: '甲' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  // ── M3b-B3 deleteAgent ──

  it('soft-deletes a non-default agent and unbinds its tools', async () => {
    const other = await service.createAgent(fixture.authorId, { name: '次要', model_id: 'm2' });
    // 绑定工具 'continue' 到次要 Agent
    const toolRepo = fixture.dataSource.getRepository(AiToolEntity);
    await toolRepo.update({ tool_id: 'continue' }, { agent_id: other.agent.id });

    const del = await service.deleteAgent(fixture.authorId, other.agent.id);
    expect(del.ok).toBe(true);
    const stored = await toolRepo.findOneByOrFail({ tool_id: 'continue' });
    expect(stored.agent_id).toBeNull(); // 解绑
    const agent = await fixture.dataSource.getRepository('AgentEntity').findOneByOrFail({ id: other.agent.id });
    expect(agent.status).toBe('disabled'); // 软删
  });

  it('forbids deleting the default agent with 409', async () => {
    const def = await service.createAgent(fixture.authorId, { name: '默认', model_id: 'm1', is_default: true });
    await expect(service.deleteAgent(fixture.authorId, def.agent.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects deleting a missing agent with 404', async () => {
    await expect(service.deleteAgent(fixture.authorId, randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── M3b-B3 listAgents ──

  it('lists agents with bound tool count for the author only', async () => {
    await service.createAgent(fixture.authorId, { name: 'A', model_id: 'm1' });
    await service.createAgent(fixture.authorId, { name: 'B', model_id: 'm2' });
    await service.createAgent(fixture.otherAuthorId, { name: 'C', model_id: 'm3' });

    const listed = await service.listAgents(fixture.authorId);
    expect(listed.agents).toHaveLength(2);
    expect(listed.agents.every((a) => a.author_id === fixture.authorId)).toBe(true);
    for (const a of listed.agents) expect(a.bound_tool_count).toBe(0);
  });

  // ── M3b-B4 ensureDefaultAgent ──

  it('lazily creates a default Mock agent and binds all enabled tools', async () => {
    const agent = await service.ensureDefaultAgent(fixture.authorId);
    expect(agent.is_default).toBe(true);
    expect(agent.platform).toBe('mock');
    expect(agent.name).toBe('默认创作 Agent');

    const tools = await fixture.dataSource.getRepository(AiToolEntity).find({ where: { enabled: true } });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.agent_id).toBe(agent.id); // 全部启用工具绑定默认 Agent
  });

  it('is idempotent: ensureDefaultAgent returns the existing default without duplicates', async () => {
    const first = await service.ensureDefaultAgent(fixture.authorId);
    const second = await service.ensureDefaultAgent(fixture.authorId);
    expect(second.id).toBe(first.id);
    const count = await fixture.dataSource.getRepository('AgentEntity')
      .createQueryBuilder('a').where('a.author_id = :id', { id: fixture.authorId }).andWhere('a.is_default = true').getCount();
    expect(count).toBe(1);
  });

  // ── M3b-B4 listTools / updateTool ──

  it('lists all seeded tools (9) with bound agent summary', async () => {
    const { tools } = await service.listTools(fixture.authorId);
    expect(tools).toHaveLength(9);
    const ids = tools.map((t) => t.tool_id).sort();
    expect(ids).toEqual([
      'character_avatar_generate',
      'character_extract',
      'character_growth_extract',
      'continue',
      'expand',
      'plot_derivation',
      'plot_generate',
      'polish',
      'rewrite'
    ]);
    for (const t of tools) expect(t.bound_agent).toBeNull(); // 未绑定
  });

  it('updates a tool: name, enabled flag and agent binding', async () => {
    const agent = await service.createAgent(fixture.authorId, { name: '绑定目标', model_id: 'm1' });
    const updated = await service.updateTool(fixture.authorId, 'continue', {
      name: '续写·新', agent_id: agent.agent.id, enabled: false
    });
    expect(updated.tool.name).toBe('续写·新');
    expect(updated.tool.enabled).toBe(false);
    expect(updated.tool.agent_id).toBe(agent.agent.id);
    expect(updated.tool.bound_agent?.id).toBe(agent.agent.id);
    expect(updated.warning).toContain('进行中的 AI 任务不受影响');
  });

  it('rejects binding a tool to a missing agent with 404', async () => {
    await expect(service.updateTool(fixture.authorId, 'continue', { agent_id: randomUUID() }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects updating an unknown tool with 404', async () => {
    await expect(service.updateTool(fixture.authorId, 'unknown-tool', { enabled: true }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── M3b-B4 resolveToolForTask ──

  it('resolves an existing enabled tool to its bound agent id', async () => {
    const agent = await service.createAgent(fixture.authorId, { name: '执行者', model_id: 'm1' });
    await service.updateTool(fixture.authorId, 'continue', { agent_id: agent.agent.id });
    const resolved = await service.resolveToolForTask('continue');
    expect(resolved.tool.tool_id).toBe('continue');
    expect(resolved.agentId).toBe(agent.agent.id);
  });

  it('returns null agentId for an unbound tool', async () => {
    const resolved = await service.resolveToolForTask('continue');
    expect(resolved.agentId).toBeNull();
  });

  it('throws 404 for an unknown tool', async () => {
    await expect(service.resolveToolForTask('unknown-tool'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 for a disabled tool', async () => {
    await service.updateTool(fixture.authorId, 'continue', { enabled: false });
    await expect(service.resolveToolForTask('continue'))
      .rejects.toBeInstanceOf(ConflictException);
  });

  // ── M3b-B4a 发起任务解析写入 agent_id（复用 AiTaskService） ──

  function buildAiTaskService(): AiTaskService {
    const queue: AiTaskQueuePort = { enqueue: vi.fn().mockResolvedValue(true), remove: vi.fn().mockResolvedValue(undefined) };
    return new AiTaskService(fixture.dataSource, { record: vi.fn() } as never, queue, new AiTaskEventBus(), service);
  }

  it('writes the bound agent_id when creating a task', async () => {
    const agent = await service.createAgent(fixture.authorId, { name: '执行者', model_id: 'm1' });
    await service.updateTool(fixture.authorId, 'continue', { agent_id: agent.agent.id });
    const ai = buildAiTaskService();
    const { task } = await ai.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: `m3b-agent-${randomUUID()}`
    });
    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.agent_id).toBe(agent.agent.id);
  });

  it('falls back to the lazily created default agent when tool is unbound', async () => {
    const ai = buildAiTaskService();
    const { task } = await ai.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: `m3b-agent-${randomUUID()}`
    });
    const defaultAgent = await service.ensureDefaultAgent(fixture.authorId);
    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.agent_id).toBe(defaultAgent.id);
  });

  it('rejects creating a task with a disabled tool (409)', async () => {
    await service.updateTool(fixture.authorId, 'continue', { enabled: false });
    const ai = buildAiTaskService();
    await expect(ai.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: `m3b-agent-${randomUUID()}`
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
