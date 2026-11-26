import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AgentVersionService, MAX_VERSIONS } from './agent-version.service';
import { AgentEntity } from '../database/agent.entity';
import { AgentVersionEntity } from './agent-version.entity';

let fixture: WritingFixture;
let service: AgentVersionService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new AgentVersionService(fixture.dataSource, fixture.dataSource.getRepository(AgentVersionEntity));
});

afterEach(() => destroyWritingFixture(fixture));

/** 构造最小 AgentEntity（未持久化，仅供 buildSnapshot 读取字段）。 */
function makeAgent(overrides: Partial<AgentEntity> = {}): AgentEntity {
  const agent = new AgentEntity();
  agent.id = randomUUID();
  agent.author_id = fixture.authorId;
  agent.name = '版本Agent';
  agent.platform = 'mock';
  agent.model_id = 'gpt-4o-mini';
  agent.model_config = { temperature: 0.5 };
  agent.status = 'active';
  agent.is_default = false;
  agent.created_at = new Date('2026-01-01T00:00:00Z');
  agent.updated_at = new Date('2026-01-02T00:00:00Z');
  agent.kind = 'legacy';
  agent.description = '描述';
  agent.scope = 'project';
  agent.platform_config = {};
  agent.source = 'manual';
  agent.tags = [];
  agent.credential_source = 'global';
  agent.version_no = 1;
  Object.assign(agent, overrides);
  return agent;
}

/** 持久化一个 ai_agents 行（agent_version FK 依赖）。 */
async function persistAgent(overrides: Partial<AgentEntity> = {}): Promise<AgentEntity> {
  const repo = fixture.dataSource.getRepository(AgentEntity);
  const row = repo.create(makeAgent(overrides));
  return repo.save(row);
}

describe('AgentVersionService（独立 agent_version 表）', () => {
  it('buildSnapshot 保留业务字段，剔除 updated_at 冗余', () => {
    const snapshot = service.buildSnapshot(makeAgent());
    expect(snapshot.name).toBe('版本Agent');
    expect(snapshot.model_config).toEqual({ temperature: 0.5 });
    expect(snapshot.created_at).toBe('2026-01-01T00:00:00.000Z');
    // 剔除冗余字段
    expect(snapshot).not.toHaveProperty('updated_at');
    expect(snapshot).not.toHaveProperty('versions');
    expect(snapshot).not.toHaveProperty('version_no');
  });

  it('appendVersion 写入一行并可用 getSnapshot 读回', async () => {
    const agent = await persistAgent();
    await service.appendVersion(agent.id, 1, 'create', '创建 Agent', service.buildSnapshot(agent));
    const snapshot = await service.getSnapshot(agent.id, 1);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.name).toBe('版本Agent');
  });

  it('appendVersion 超出上限清理最旧版本（保留最近 MAX_VERSIONS）', async () => {
    const agent = await persistAgent();
    const total = MAX_VERSIONS + 5;
    for (let no = 1; no <= total; no += 1) {
      const snap = service.buildSnapshot(makeAgent({ name: `v${no}` }));
      await service.appendVersion(agent.id, no, 'update', `第 ${no} 版`, snap);
    }
    const repo = fixture.dataSource.getRepository(AgentVersionEntity);
    const rows = await repo.find({ where: { agent_id: agent.id }, order: { version_no: 'ASC' } });
    expect(rows).toHaveLength(MAX_VERSIONS);
    // 最旧被清掉：最早保留的应是 total - MAX_VERSIONS + 1
    expect(rows[0]!.version_no).toBe(total - MAX_VERSIONS + 1);
    expect(rows[rows.length - 1]!.version_no).toBe(total);
  });

  it('listVersions 返回降序且不含 snapshot', async () => {
    const agent = await persistAgent();
    await service.appendVersion(agent.id, 1, 'create', '创建 Agent', service.buildSnapshot(agent));
    await service.appendVersion(agent.id, 2, 'update', '更新字段: name', service.buildSnapshot(agent));
    const list = await service.listVersions(agent.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.version_no).toBe(2);
    expect(list[1]!.version_no).toBe(1);
    expect(list[0]!.change_type).toBe('update');
    expect(list[0]!.note).toBe('更新字段: name');
    expect(list[0]).not.toHaveProperty('snapshot');
    expect(list[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('getSnapshot 对不存在的版本返回 null', async () => {
    const agent = await persistAgent();
    await expect(service.getSnapshot(agent.id, 999)).resolves.toBeNull();
  });
});
