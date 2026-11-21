import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { AgentEntity } from '../database/agent.entity';
import { CharacterEntity } from '../database/character.entity';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { AgentTaskCitationEntity } from '../database/agent-task-citation.entity';
import { CollabTaskService } from './collab-task.service';
import { CollabService } from './collab.service';
import { CollabReadinessService } from './collab-readiness.service';

// T18 前置：角色资料协同任务创建/查询服务单测（真实 DB fixture，mock 外部依赖）

let fixture: WritingFixture;
let service: CollabTaskService;

// 替身依赖
let collabMock: { getCollabSettings: ReturnType<typeof vi.fn> };
let readinessMock: { getReadiness: ReturnType<typeof vi.fn> };
let queueMock: { enqueue: ReturnType<typeof vi.fn> };
let eventBusMock: { publish: ReturnType<typeof vi.fn> };
let auditMock: { record: ReturnType<typeof vi.fn> };

// 种子数据：Agent / 测试角色 / 设置
let agentId: string;
let characterId: string;
let testCharacterVersion: number;

async function seedAgent(platform = 'flowise'): Promise<string> {
  const repo = fixture.dataSource.getRepository(AgentEntity);
  const row = await repo.save(repo.create({
    id: randomUUID(),
    author_id: fixture.authorId,
    name: '协同 Agent',
    platform,
    model_id: 'mock-model',
    platform_config: platform === 'flowise' ? { flowise_chatflow_id: 'chatflow-1' } : {}
  }));
  return row.id;
}

async function seedCharacter(): Promise<{ id: string; version: number }> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const row = await repo.save(repo.create({
    id: randomUUID(),
    work_id: fixture.workId,
    name: '测试角色',
    name_key: '测试角色',
    personality: '',
    experience: '',
    attributes: [],
    status: 'active',
    version: 1
  }));
  return { id: row.id, version: row.version };
}

async function seedSettings(opts: { enabled?: boolean; agentId?: string; testCharacterId?: string; whitelist?: string[] } = {}): Promise<void> {
  const repo = fixture.dataSource.getRepository(CollabSettingEntity);
  await repo.save(repo.create({
    work_id: fixture.workId,
    test_character_id: opts.testCharacterId ?? characterId,
    agent_id: opts.agentId ?? agentId,
    whitelist_fields: opts.whitelist ?? ['identity', 'personality', 'experience'],
    enabled: opts.enabled ?? true
  }));
}

function makeService(): void {
  service = new CollabTaskService(
    fixture.dataSource,
    collabMock as unknown as CollabService,
    readinessMock as unknown as CollabReadinessService,
    queueMock as unknown as never,
    eventBusMock as unknown as never,
    auditMock as unknown as never
  );
}

function settingsResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    work_id: fixture.workId,
    enabled: true,
    test_character_id: characterId,
    agent_id: agentId,
    whitelist_fields: ['identity', 'personality', 'experience'],
    ...overrides
  };
}

function readinessResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: { enabled: true, test_character_id: characterId, agent_id: agentId },
    channels: { flowise: { configured: true }, coze: { configured: false } },
    retrieval: { configured: false },
    archive: { configured: false },
    ...overrides
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createWritingFixture();
  agentId = await seedAgent('flowise');
  const character = await seedCharacter();
  characterId = character.id;
  testCharacterVersion = character.version;

  collabMock = { getCollabSettings: vi.fn().mockResolvedValue(settingsResponse()) };
  readinessMock = { getReadiness: vi.fn().mockResolvedValue(readinessResponse()) };
  queueMock = { enqueue: vi.fn().mockResolvedValue(undefined) };
  eventBusMock = { publish: vi.fn() };
  auditMock = { record: vi.fn().mockResolvedValue(undefined) };
  makeService();
});

afterEach(() => destroyWritingFixture(fixture));

describe('CollabTaskService (T18 前置 任务创建/查询)', () => {
  it('创建成功：测试角色+白名单字段+通道就绪 → queued 任务 + 入队 + 事件 + 审计', async () => {
    const result = await service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId,
      fields: ['identity', 'personality'],
      instruction: '补充测试角色的身份与性格'
    });

    expect(result.task.scope).toBe('role_profile');
    expect(result.task.channel).toBe('flowise');
    expect(result.task.status).toBe('queued');
    expect(queueMock.enqueue).toHaveBeenCalledWith(result.task.id);
    expect(eventBusMock.publish).toHaveBeenCalled();
    expect(auditMock.record).toHaveBeenCalled();

    const row = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: result.task.id });
    expect(row.status).toBe('queued');
    expect(row.scope).toBe('role_profile');
    const events = await fixture.dataSource.getRepository(AiTaskEventEntity).findBy({ task_id: result.task.id });
    expect(events.length).toBe(1);
  });

  it('协同未启用 → COLLAB_DISABLED', async () => {
    collabMock.getCollabSettings.mockResolvedValueOnce(settingsResponse({ enabled: false }));
    await expect(service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId, fields: ['identity'], instruction: 'x'
    })).rejects.toMatchObject({ status: 409 });
  });

  it('角色 ≠ 测试角色 → COLLAB_TEST_ROLE_MISMATCH', async () => {
    await expect(service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: randomUUID(), fields: ['identity'], instruction: 'x'
    })).rejects.toMatchObject({ status: 409 });
  });

  it('字段不在白名单 → COLLAB_FIELD_NOT_ALLOWED', async () => {
    collabMock.getCollabSettings.mockResolvedValueOnce(settingsResponse({ whitelist_fields: ['identity', 'personality'] }));
    await expect(service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId, fields: ['experience'], instruction: 'x'
    })).rejects.toMatchObject({ status: 400 });
  });

  it('通道未配置 → COLLAB_CHANNEL_NOT_CONFIGURED', async () => {
    readinessMock.getReadiness.mockResolvedValueOnce(readinessResponse({ channels: { flowise: { configured: false }, coze: { configured: false } } }));
    await expect(service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId, fields: ['identity'], instruction: 'x'
    })).rejects.toMatchObject({ status: 409 });
  });

  it('幂等键命中 → 返回既有任务且不重复入队', async () => {
    // 先创建一次（入队 1 次）
    const first = await service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId, fields: ['identity'], instruction: 'x'
    });
    // 相同 idempotencyKey 再创建
    queueMock.enqueue.mockClear();
    const second = await service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId, fields: ['identity'], instruction: 'x',
      idempotencyKey: first.task.idempotency_key ?? undefined
    });
    expect(second.task.id).toBe(first.task.id);
    expect(queueMock.enqueue).not.toHaveBeenCalled();
  });

  it('查询详情：返回任务+引用+写回+归档', async () => {
    const created = await service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId, fields: ['identity'], instruction: 'x'
    });
    const taskId = created.task.id;

    // seed 引用
    await fixture.dataSource.getRepository(AgentTaskCitationEntity).save(
      fixture.dataSource.getRepository(AgentTaskCitationEntity).create({
        id: randomUUID(), task_id: taskId, dataset_id: 'ds-1', source_id: 'doc-1', title: '资料一', snippet: '摘录', score: '0.9'
      })
    );
    // seed 写回单 + 字段
    const wbId = randomUUID();
    await fixture.dataSource.getRepository(RoleProfileWritebackEntity).save(
      fixture.dataSource.getRepository(RoleProfileWritebackEntity).create({
        id: wbId, task_id: taskId, work_id: fixture.workId, character_id: characterId,
        channel: 'flowise', status: 'applied', applied_version: testCharacterVersion,
        applied_by: fixture.authorId, applied_at: new Date()
      })
    );
    await fixture.dataSource.getRepository(RoleProfileWritebackFieldEntity).save(
      fixture.dataSource.getRepository(RoleProfileWritebackFieldEntity).create({
        id: randomUUID(), writeback_id: wbId, field_key: 'identity', before_value: '旧值', after_value: '新值', status: 'applied'
      })
    );
    // seed 归档 outbox
    await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).save(
      fixture.dataSource.getRepository(AgentArchiveOutboxEntity).create({
        id: randomUUID(), task_id: taskId, status: 'delivered', attempts: 1,
        external_id: 'exec-1', payload: {}
      })
    );

    const detail = await service.getTaskDetail(fixture.authorId, fixture.workId, taskId);
    expect(detail.task.id).toBe(taskId);
    expect(detail.citations.length).toBe(1);
    expect(detail.citations[0]!.source_id).toBe('doc-1');
    expect(detail.writeback?.fields[0]?.field_key).toBe('identity');
    expect(detail.archive?.status).toBe('delivered');
    expect(detail.archive?.external_id).toBe('exec-1');
  });

  it('写回列表：按角色返回写回历史并含字段', async () => {
    const created = await service.createRoleProfileTask(fixture.authorId, fixture.workId, {
      character_id: characterId, fields: ['identity'], instruction: 'x'
    });
    const wbId = randomUUID();
    await fixture.dataSource.getRepository(RoleProfileWritebackEntity).save(
      fixture.dataSource.getRepository(RoleProfileWritebackEntity).create({
        id: wbId, task_id: created.task.id, work_id: fixture.workId, character_id: characterId,
        channel: 'flowise', status: 'applied', applied_version: testCharacterVersion,
        applied_by: fixture.authorId, applied_at: new Date()
      })
    );
    await fixture.dataSource.getRepository(RoleProfileWritebackFieldEntity).save(
      fixture.dataSource.getRepository(RoleProfileWritebackFieldEntity).create({
        id: randomUUID(), writeback_id: wbId, field_key: 'identity', before_value: '旧', after_value: '新', status: 'applied'
      })
    );

    const result = await service.listWritebacks(fixture.authorId, fixture.workId, characterId);
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.id).toBe(wbId);
    expect(result.items[0]!.fields[0]?.field_key).toBe('identity');
    expect(result.items[0]!.fields[0]?.after_value).toBe('新');
  });

  it('写回列表：作品不属于作者 → 404', async () => {
    await expect(service.listWritebacks(fixture.otherAuthorId, fixture.workId, characterId))
      .rejects.toMatchObject({ status: 404 });
  });
});
