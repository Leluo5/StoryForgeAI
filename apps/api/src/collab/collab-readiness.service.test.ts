import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CollabReadinessService, type CollabReadinessEnv } from './collab-readiness.service';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';

let fixture: WritingFixture;

beforeEach(async () => {
  fixture = await createWritingFixture();
});
afterEach(() => destroyWritingFixture(fixture));

const fullEnv: CollabReadinessEnv = {
  FLOWISE_BASE_URL: 'https://flowise.example.com',
  FLOWISE_API_KEY: 'fk',
  FASTGPT_BASE_URL: 'https://fastgpt.example.com',
  FASTGPT_API_KEY: 'fak',
  FASTGPT_DATASET_ID: 'ds-1',
  COZE_API_BASE: 'https://coze.example.com',
  COZE_PAT: 'pat',
  COZE_BOT_ID: 'bot-1',
  N8N_ARCHIVE_WEBHOOK_URL: 'https://n8n.example.com/webhook/archive',
  N8N_ARCHIVE_TOKEN: 'n8n-token'
};

async function seedAgent(authorId: string, platform_config: Record<string, unknown>): Promise<string> {
  const repo = fixture.dataSource.getRepository(AgentEntity);
  const a = await repo.save(repo.create({
    id: randomUUID(),
    author_id: authorId,
    name: '协同 Agent',
    platform: 'flowise',
    model_id: 'mock',
    model_config: {},
    platform_config,
    status: 'active',
    is_default: false
  }));
  return a.id;
}

async function seedSetting(workId: string, agentId: string): Promise<void> {
  const charRepo = fixture.dataSource.getRepository(CharacterEntity);
  const char = await charRepo.save(charRepo.create({
    id: randomUUID(),
    work_id: workId,
    name: '测试角色',
    name_key: '测试角色',
    personality: '',
    experience: '',
    status: 'active'
  }));
  const repo = fixture.dataSource.getRepository(CollabSettingEntity);
  await repo.save(repo.create({
    work_id: workId,
    test_character_id: char.id,
    agent_id: agentId,
    whitelist_fields: ['identity', 'personality'],
    enabled: true
  }));
}

describe('CollabReadinessService (F11 T07)', () => {
  it('returns empty settings when nothing configured', async () => {
    const service = new CollabReadinessService(fixture.dataSource, {});
    const result = await service.getReadiness(fixture.authorId, fixture.workId);
    expect(result.settings).toEqual({ enabled: false, test_character_id: null, agent_id: null });
    expect(result.channels.flowise.configured).toBe(false);
    expect(result.channels.coze.configured).toBe(false);
    expect(result.retrieval.configured).toBe(false);
    expect(result.archive.configured).toBe(false);
  });

  it('rejects a work not owned by the author', async () => {
    const service = new CollabReadinessService(fixture.dataSource, {});
    await expect(service.getReadiness(fixture.otherAuthorId, fixture.workId))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('marks flowise ready only when env vars + agent chatflow id are present', async () => {
    const agentId = await seedAgent(fixture.authorId, { flowise_chatflow_id: 'chatflow-1' });
    await seedSetting(fixture.workId, agentId);
    const service = new CollabReadinessService(fixture.dataSource, fullEnv);
    const result = await service.getReadiness(fixture.authorId, fixture.workId);
    expect(result.channels.flowise.configured).toBe(true);
    expect(result.channels.coze.configured).toBe(true);
    expect(result.retrieval.configured).toBe(true);
    expect(result.archive.configured).toBe(true);
    expect(result.settings.enabled).toBe(true);
  });

  it('flowise not ready when env vars present but agent has no chatflow id', async () => {
    const agentId = await seedAgent(fixture.authorId, {});
    await seedSetting(fixture.workId, agentId);
    const service = new CollabReadinessService(fixture.dataSource, fullEnv);
    const result = await service.getReadiness(fixture.authorId, fixture.workId);
    expect(result.channels.flowise.configured).toBe(false);
  });

  it('flowise not ready when FLOWISE env vars missing', async () => {
    const agentId = await seedAgent(fixture.authorId, { flowise_chatflow_id: 'chatflow-1' });
    await seedSetting(fixture.workId, agentId);
    const service = new CollabReadinessService(fixture.dataSource, {
      ...fullEnv,
      FLOWISE_BASE_URL: undefined,
      FLOWISE_API_KEY: undefined
    });
    const result = await service.getReadiness(fixture.authorId, fixture.workId);
    expect(result.channels.flowise.configured).toBe(false);
  });
});
