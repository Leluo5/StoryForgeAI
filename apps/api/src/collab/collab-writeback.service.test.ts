import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { AiTaskEntity } from '../database/ai-task.entity';
import { CollabWritebackService } from './collab-writeback.service';

// T14 写回服务单测：真实 DB fixture，直接 new 服务（不经 DI），在 dataSource.transaction 内调用端口。

let fixture: WritingFixture;
let service: CollabWritebackService;

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createWritingFixture();
  service = new CollabWritebackService();
});

afterEach(() => destroyWritingFixture(fixture));

async function seedCharacter(workId: string, opts: Partial<Pick<CharacterEntity, 'identity' | 'personality' | 'experience'>> = {}): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const c = await repo.save(repo.create({
    id: randomUUID(),
    work_id: workId,
    name: '林默',
    name_key: '林默',
    identity: opts.identity ?? '边城少年',
    personality: opts.personality ?? '坚韧',
    experience: opts.experience ?? '经历内容',
    status: 'active'
  }));
  return c.id;
}

async function seedAgent(authorId: string, platform: 'flowise' | 'coze'): Promise<string> {
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
    platform_config: platform === 'flowise' ? { flowise_chatflow_id: 'cf-123' } : {}
  }));
  return a.id;
}

async function seedSettings(
  workId: string,
  charId: string,
  opts: { enabled?: boolean; whitelist?: string[] } = {}
): Promise<void> {
  const repo = fixture.dataSource.getRepository(CollabSettingEntity);
  const agentId = await seedAgent(fixture.authorId, 'flowise');
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

function makeInput(charId: string, overrides: Partial<Parameters<CollabWritebackService['applyWriteback']>[1]> = {}) {
  return {
    taskId: randomUUID(),
    workId: fixture.workId,
    characterId: charId,
    channel: 'flowise' as const,
    appliedBy: fixture.authorId,
    fields: { identity: '边城少年·新', personality: '坚韧·新' },
    citations: [{ source_id: 'doc-1', title: '资料一', snippet: '摘录', score: 0.9 }],
    resultText: JSON.stringify({ fields: { identity: '边城少年·新', personality: '坚韧·新' } }),
    ...overrides
  };
}

async function apply(input: ReturnType<typeof makeInput>) {
  return fixture.dataSource.transaction((manager) => service.applyWriteback(manager, input));
}

describe('CollabWritebackService (T14 写回事务)', () => {
  it('完整写回：锁角色→更新字段+版本→写回单+字段行+outbox', async () => {
    const charId = await seedCharacter(fixture.workId);
    await seedSettings(fixture.workId, charId);
    const taskId = await seedTask(fixture.workId, fixture.authorId, charId, 'flowise');
    const input = makeInput(charId, { taskId });

    const result = await apply(input);

    // 角色已更新 + version+1
    const character = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(character.identity).toBe('边城少年·新');
    expect(character.personality).toBe('坚韧·新');
    expect(character.version).toBe(2);

    // 写回单
    const writeback = await fixture.dataSource.getRepository(RoleProfileWritebackEntity).findOneByOrFail({ task_id: input.taskId });
    expect(writeback.status).toBe('applied');
    expect(writeback.applied_version).toBe(2);
    expect(writeback.channel).toBe('flowise');
    expect(result.writebackId).toBe(writeback.id);
    expect(result.appliedVersion).toBe(2);

    // 字段行：before_value 为原值，after_value 为新值，status applied
    const fieldRows = await fixture.dataSource.getRepository(RoleProfileWritebackFieldEntity).find({ where: { writeback_id: writeback.id } });
    expect(fieldRows).toHaveLength(2);
    const byKey = Object.fromEntries(fieldRows.map((r) => [r.field_key, r]));
    expect(byKey['identity']!.before_value).toBe('边城少年');
    expect(byKey['identity']!.after_value).toBe('边城少年·新');
    expect(byKey['personality']!.before_value).toBe('坚韧');
    expect(byKey['personality']!.after_value).toBe('坚韧·新');

    // outbox：pending，payload 含结果/引用/通道，不含凭据
    const outbox = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findOneByOrFail({ task_id: input.taskId });
    expect(outbox.status).toBe('pending');
    expect(outbox.attempts).toBe(0);
    expect(outbox.payload.channel).toBe('flowise');
    expect(outbox.payload.result_text).toBe(input.resultText);
    expect(outbox.payload.citations).toHaveLength(1);
    expect(outbox.payload.applied_version).toBe(2);
  });

  it('重复写回（同 task_id）幂等：不新增行，返回既有写回单', async () => {
    const charId = await seedCharacter(fixture.workId);
    await seedSettings(fixture.workId, charId);
    const taskId = await seedTask(fixture.workId, fixture.authorId, charId, 'flowise');
    const input = makeInput(charId, { taskId });

    const first = await apply(input);
    // 第二次：修改字段值，但应被幂等拦截
    const second = await apply({ ...input, fields: { identity: '改后', personality: '改后' } });

    expect(second.writebackId).toBe(first.writebackId);
    expect(second.appliedVersion).toBe(first.appliedVersion);

    const count = await fixture.dataSource.getRepository(RoleProfileWritebackEntity).count({ where: { task_id: input.taskId } });
    expect(count).toBe(1);
    // 角色不被二次覆盖
    const character = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(character.identity).toBe('边城少年·新');
  });

  it('配置禁用 → COLLAB_DISABLED，角色不变', async () => {
    const charId = await seedCharacter(fixture.workId);
    await seedSettings(fixture.workId, charId, { enabled: false });
    await expect(apply(makeInput(charId))).rejects.toMatchObject({ code: 'COLLAB_DISABLED' });
    const character = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(character.identity).toBe('边城少年');
  });

  it('字段不在白名单 → COLLAB_FIELD_NOT_ALLOWED，不产生部分写回', async () => {
    const charId = await seedCharacter(fixture.workId);
    await seedSettings(fixture.workId, charId, { whitelist: ['identity', 'personality'] });
    await expect(apply(makeInput(charId, { fields: { identity: 'x', experience: 'y' } }))).rejects.toMatchObject({ code: 'COLLAB_FIELD_NOT_ALLOWED' });
    // 无写回单/outbox，角色不变
    const wbCount = await fixture.dataSource.getRepository(RoleProfileWritebackEntity).count();
    expect(wbCount).toBe(0);
    const obCount = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).count();
    expect(obCount).toBe(0);
    const character = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(character.identity).toBe('边城少年');
  });

  it('角色不再配置测试角色 → COLLAB_TEST_ROLE_MISMATCH', async () => {
    const charId = await seedCharacter(fixture.workId);
    const otherCharId = await seedCharacter(fixture.workId);
    await seedSettings(fixture.workId, charId);
    await expect(apply(makeInput(otherCharId))).rejects.toMatchObject({ code: 'COLLAB_TEST_ROLE_MISMATCH' });
    const other = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: otherCharId });
    expect(other.identity).toBe('边城少年');
  });
});
