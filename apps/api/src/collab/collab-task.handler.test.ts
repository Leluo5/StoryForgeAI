import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { AgentTaskCitationEntity } from '../database/agent-task-citation.entity';
import { CollabTaskHandler, type RoleProfileTaskContext } from './collab-task.handler';
import { CollabUpstreamError } from './channel/collab-upstream.error';
import { COLLAB_WRITEBACK_PORT, type CollabWritebackPort } from './collab-writeback.port';
import { AiTaskEntity } from '../database/ai-task.entity';
import type { FastGptClient } from './retrieval/fastgpt.client';
import type { AgentChannelRegistry } from './channel/agent-channel.registry';
import type { AgentChannel, AgentChannelResult, CollabCitation } from '@storyforge/contracts';

// T13 处理器编排单测：真实 DB fixture（角色/Agent/协同配置种子）+ 检索/通道/写回端口替身。
// handler 直接 new 注入替身，不经 Nest DI 容器（容器内 PendingWriteback 占位，此处以替身验证完整编排）。

let fixture: WritingFixture;

const fastGptSearch = vi.fn();
const channelInvoke = vi.fn();
const writebackApply = vi.fn();

function makeStubs(): {
  fastGpt: FastGptClient;
  registry: AgentChannelRegistry;
  writeback: CollabWritebackPort;
} {
  return {
    fastGpt: { search: fastGptSearch } as unknown as FastGptClient,
    registry: {
      get: (name: 'flowise' | 'coze') => ({
        name,
        invoke: channelInvoke
      })
    } as unknown as AgentChannelRegistry,
    writeback: {
      applyWriteback: writebackApply
    }
  };
}

function makeHandler(): CollabTaskHandler {
  const { fastGpt, registry, writeback } = makeStubs();
  return new CollabTaskHandler(fixture.dataSource, fastGpt, registry, writeback);
}

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createWritingFixture();
});

afterEach(() => destroyWritingFixture(fixture));

async function seedCharacter(workId: string): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const c = await repo.save(repo.create({
    id: randomUUID(),
    work_id: workId,
    name: '林默',
    name_key: '林默',
    identity: '边城少年',
    personality: '坚韧',
    experience: '经历内容',
    status: 'active'
  }));
  return c.id;
}

async function seedAgent(authorId: string, platform: 'flowise' | 'coze', chatflowId?: string): Promise<string> {
  const repo = fixture.dataSource.getRepository(AgentEntity);
  const a = await repo.save(repo.create({
    id: randomUUID(),
    author_id: authorId,
    name: '协同 Agent',
    platform,
    model_id: 'mock',
    model_config: {},
    status: 'active',
    is_default: false,
    platform_config: chatflowId ? { flowise_chatflow_id: chatflowId } : {}
  }));
  return a.id;
}

async function seedSettings(
  workId: string,
  charId: string,
  agentId: string,
  opts: { enabled?: boolean; whitelist?: ('identity' | 'personality' | 'experience')[] } = {}
): Promise<void> {
  const repo = fixture.dataSource.getRepository(CollabSettingEntity);
  await repo.save(repo.create({
    work_id: workId,
    test_character_id: charId,
    agent_id: agentId,
    whitelist_fields: opts.whitelist ?? ['identity', 'personality', 'experience'],
    enabled: opts.enabled ?? true
  }));
}

async function seedTask(workId: string, authorId: string, charId: string, channel: 'flowise' | 'coze'): Promise<string> {
  const repo = fixture.dataSource.getRepository(AiTaskEntity);
  const t = await repo.save(repo.create({
    id: randomUUID(),
    idempotency_key: randomUUID(),
    work_id: workId,
    chapter_id: null,
    scope: 'role_profile',
    channel,
    tool: 'role_profile',
    agent_id: null,
    input_summary: { character_id: charId, fields: ['identity', 'personality'], instruction: '补充角色' },
    base_version: 0,
    status: 'running',
    created_by: authorId
  }));
  return t.id;
}

const baseTask: Omit<RoleProfileTaskContext, 'inputSummary'> = {
  taskId: randomUUID(),
  authorId: '00000000-0000-0000-0000-000000000000',
  workId: '00000000-0000-0000-0000-000000000000',
  tool: 'role_profile'
};

const hits = [
  { id: 'doc-1', title: '资料一', content: '摘录内容'.repeat(10), score: 0.9 },
  { id: 'doc-2', title: '资料二', content: '另一段摘录'.repeat(10), score: null }
];

const citationShape = (hitsArr: typeof hits): CollabCitation[] => hitsArr.map((h) => ({
  source_id: h.id,
  title: h.title,
  snippet: h.content.slice(0, 500),
  score: h.score
}));

describe('CollabTaskHandler (T13 role_profile 编排)', () => {
  it('协同未启用 → COLLAB_DISABLED', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise', 'cf-123');
    await seedSettings(fixture.workId, charId, agentId, { enabled: false });
    const handler = makeHandler();
    await expect(handler.handle({
      ...baseTask,
      workId: fixture.workId,
      inputSummary: { character_id: charId, fields: ['identity', 'personality'], instruction: '补充角色' }
    })).rejects.toMatchObject({ code: 'COLLAB_DISABLED' });
    expect(fastGptSearch).not.toHaveBeenCalled();
  });

  it('非测试角色 → COLLAB_TEST_ROLE_MISMATCH', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise', 'cf-123');
    await seedSettings(fixture.workId, charId, agentId);
    const otherCharId = await seedCharacter(fixture.workId);
    const handler = makeHandler();
    await expect(handler.handle({
      ...baseTask,
      workId: fixture.workId,
      inputSummary: { character_id: otherCharId, fields: ['identity', 'personality'], instruction: '补充角色' }
    })).rejects.toMatchObject({ code: 'COLLAB_TEST_ROLE_MISMATCH' });
    expect(fastGptSearch).not.toHaveBeenCalled();
  });

  it('字段不在白名单 → COLLAB_FIELD_NOT_ALLOWED', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise', 'cf-123');
    await seedSettings(fixture.workId, charId, agentId, { whitelist: ['identity', 'personality'] });
    const handler = makeHandler();
    await expect(handler.handle({
      ...baseTask,
      workId: fixture.workId,
      inputSummary: { character_id: charId, fields: ['identity', 'experience'], instruction: '补充角色' }
    })).rejects.toMatchObject({ code: 'COLLAB_FIELD_NOT_ALLOWED' });
    expect(fastGptSearch).not.toHaveBeenCalled();
  });

  it('flowise 无 chatflow → COLLAB_CHANNEL_NOT_CONFIGURED', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise');
    await seedSettings(fixture.workId, charId, agentId);
    const handler = makeHandler();
    await expect(handler.handle({
      ...baseTask,
      workId: fixture.workId,
      inputSummary: { character_id: charId, fields: ['identity', 'personality'], instruction: '补充角色' }
    })).rejects.toMatchObject({ code: 'COLLAB_CHANNEL_NOT_CONFIGURED' });
    expect(fastGptSearch).not.toHaveBeenCalled();
  });

  it('完整编排成功：检索→引用落库→通道→校验→写回，返回摘要', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise', 'cf-123');
    await seedSettings(fixture.workId, charId, agentId);
    const handler = makeHandler();

    fastGptSearch.mockResolvedValue({ datasetId: 'ds-1', hits });
    channelInvoke.mockResolvedValue({
      rawText: JSON.stringify({ fields: { identity: '边城少年·新', personality: '坚韧·新' } }),
      model: 'flowise',
      latencyMs: 123
    } as AgentChannelResult);
    writebackApply.mockResolvedValue({ writebackId: randomUUID(), appliedVersion: 2 });

    const taskId = await seedTask(fixture.workId, fixture.authorId, charId, 'flowise');
    const summary = await handler.handle({
      ...baseTask,
      taskId,
      authorId: fixture.authorId,
      workId: fixture.workId,
      inputSummary: { character_id: charId, fields: ['identity', 'personality'], instruction: '补充角色' }
    });

    expect(summary.scope).toBe('role_profile');
    expect(summary.character_id).toBe(charId);
    expect(summary.channel).toBe('flowise');
    expect(summary.citation_count).toBe(2);
    expect(summary.writeback_id).toBeDefined();
    expect(summary.applied_version).toBe(2);

    // 通道 invoke 收到完整请求（chatflowId 条件展开、上下文只含白名单字段、引用三项）
    expect(channelInvoke).toHaveBeenCalledTimes(1);
    const req = channelInvoke.mock.calls[0]![0];
    expect(req.taskId).toBe(taskId);
    expect(req.workId).toBe(fixture.workId);
    expect(req.channel).toBe('flowise');
    expect(req.chatflowId).toBe('cf-123');
    expect(req.instruction).toBe('补充角色');
    expect(req.roleContext).toEqual({ identity: '边城少年', personality: '坚韧' });
    expect(req.outputFields).toEqual(['identity', 'personality']);
    expect(req.citations).toHaveLength(2);
    const firstCitation = req.citations[0]!;
    expect(firstCitation).toEqual({ source_id: 'doc-1', title: '资料一', snippet: hits[0]!.content.slice(0, 500), score: 0.9 });

    // 写回端口收到已校验字段与上下文
    expect(writebackApply).toHaveBeenCalledTimes(1);
    const wbInput = writebackApply.mock.calls[0]![1];
    expect(wbInput.characterId).toBe(charId);
    expect(wbInput.channel).toBe('flowise');
    expect(wbInput.appliedBy).toBe(fixture.authorId);
    expect(wbInput.fields).toEqual({ identity: '边城少年·新', personality: '坚韧·新' });
    expect(wbInput.citations).toHaveLength(2);
    expect(wbInput.resultText).toBe(JSON.stringify({ fields: { identity: '边城少年·新', personality: '坚韧·新' } }));

    // 引用快照已落库（独立事务，任务 id 对应）
    const citations = await fixture.dataSource.getRepository(AgentTaskCitationEntity).find({ where: { task_id: taskId } });
    expect(citations).toHaveLength(2);
    const bySource = Object.fromEntries(citations.map((c) => [c.source_id, c]));
    expect(Object.keys(bySource).sort()).toEqual(['doc-1', 'doc-2']);
    expect(bySource['doc-1']!.dataset_id).toBe('ds-1');
    expect(bySource['doc-1']!.score).toBe('0.9000');
    expect(bySource['doc-2']!.score).toBeNull();
  });

  it('结果非法（缺字段）→ COLLAB_INVALID_RESULT，不调用写回', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise', 'cf-123');
    await seedSettings(fixture.workId, charId, agentId);
    const handler = makeHandler();

    fastGptSearch.mockResolvedValue({ datasetId: 'ds-1', hits });
    channelInvoke.mockResolvedValue({
      rawText: JSON.stringify({ fields: { identity: '边城少年·新' } }),
      model: 'flowise',
      latencyMs: 10
    } as AgentChannelResult);

    await expect(handler.handle({
      ...baseTask,
      workId: fixture.workId,
      inputSummary: { character_id: charId, fields: ['identity', 'personality'], instruction: '补充角色' }
    })).rejects.toMatchObject({ code: 'COLLAB_INVALID_RESULT' });
    expect(writebackApply).not.toHaveBeenCalled();
  });

  it('引用落库失败不阻断生成（日志警告，写回仍执行）', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise', 'cf-123');
    await seedSettings(fixture.workId, charId, agentId);
    const handler = makeHandler();

    fastGptSearch.mockResolvedValue({ datasetId: 'ds-1', hits });
    channelInvoke.mockResolvedValue({
      rawText: JSON.stringify({ fields: { identity: '边城少年·新', personality: '坚韧·新' } }),
      model: 'flowise',
      latencyMs: 10
    } as AgentChannelResult);
    writebackApply.mockResolvedValue({ writebackId: randomUUID(), appliedVersion: 2 });
    // 让引用落库失败：用不存在任务 id 的 FK 违反 → catch 内部日志，不抛出
    const summary = await handler.handle({
      ...baseTask,
      taskId: randomUUID(),
      workId: fixture.workId,
      inputSummary: { character_id: charId, fields: ['identity', 'personality'], instruction: '补充角色' }
    });
    expect(summary.citation_count).toBe(2);
    expect(writebackApply).toHaveBeenCalledTimes(1);
  });
});
