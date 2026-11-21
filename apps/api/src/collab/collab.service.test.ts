import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { WorkService } from '../writing/work.service';
import { CollabService } from './collab.service';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';

let fixture: WritingFixture;
let service: CollabService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new CollabService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

async function seedCharacter(workId: string, status: 'active' | 'archived' = 'active'): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const c = await repo.save(repo.create({
    id: randomUUID(),
    work_id: workId,
    name: '测试角色',
    name_key: '测试角色',
    personality: '',
    experience: '',
    status,
    archived_at: status === 'archived' ? new Date() : null
  }));
  return c.id;
}

async function seedAgent(authorId: string, platform: 'flowise' | 'coze' | 'mock'): Promise<string> {
  const repo = fixture.dataSource.getRepository(AgentEntity);
  const a = await repo.save(repo.create({
    id: randomUUID(),
    author_id: authorId,
    name: '协同 Agent',
    platform,
    model_id: 'mock',
    model_config: {},
    status: 'active',
    is_default: false
  }));
  return a.id;
}

const validInput = (charId: string, agentId: string) => ({
  test_character_id: charId,
  agent_id: agentId,
  whitelist_fields: ['identity', 'personality'] as ('identity' | 'personality' | 'experience')[],
  enabled: true
});

describe('CollabService (F11 T06)', () => {
  it('get returns null when no collab settings configured', async () => {
    const result = await service.getCollabSettings(fixture.authorId, fixture.workId);
    expect(result).toBeNull();
  });

  it('get rejects a work not owned by the author', async () => {
    await expect(service.getCollabSettings(fixture.otherAuthorId, fixture.workId))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('put saves a valid config for a flowise agent', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise');
    const saved = await service.putCollabSettings(fixture.authorId, fixture.workId, validInput(charId, agentId));
    expect(saved.work_id).toBe(fixture.workId);
    expect(saved.test_character_id).toBe(charId);
    expect(saved.agent_id).toBe(agentId);
    expect(saved.enabled).toBe(true);
    expect(saved.whitelist_fields).toEqual(['identity', 'personality']);
  });

  it('put rejects a character not belonging to the work', async () => {
    // 造一个真实存在的、属于 otherAuthor 的作品，角色挂在它下面
    const otherWork = await new WorkService(fixture.dataSource).create(fixture.otherAuthorId, {
      title: '另一个作品', description: '用于角色不属当前作品用例'
    });
    const charId = await seedCharacter(otherWork.work.id);
    const agentId = await seedAgent(fixture.authorId, 'flowise');
    await expect(service.putCollabSettings(fixture.authorId, fixture.workId, validInput(charId, agentId)))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('put rejects an archived character', async () => {
    const charId = await seedCharacter(fixture.workId, 'archived');
    const agentId = await seedAgent(fixture.authorId, 'flowise');
    await expect(service.putCollabSettings(fixture.authorId, fixture.workId, validInput(charId, agentId)))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('put rejects an agent not owned by the author', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.otherAuthorId, 'flowise');
    await expect(service.putCollabSettings(fixture.authorId, fixture.workId, validInput(charId, agentId)))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('put rejects a non-flowise/coze agent platform', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'mock');
    await expect(service.putCollabSettings(fixture.authorId, fixture.workId, validInput(charId, agentId)))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('put upserts: a second save overwrites the first', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise');
    await service.putCollabSettings(fixture.authorId, fixture.workId, validInput(charId, agentId));
    const second = await service.putCollabSettings(fixture.authorId, fixture.workId, {
      ...validInput(charId, agentId),
      enabled: false,
      whitelist_fields: ['identity', 'experience']
    });
    expect(second.enabled).toBe(false);
    expect(second.whitelist_fields).toEqual(['identity', 'experience']);
  });

  it('collab_settings defaults enabled=false at the DB layer', async () => {
    const charId = await seedCharacter(fixture.workId);
    const agentId = await seedAgent(fixture.authorId, 'flowise');
    const repo = fixture.dataSource.getRepository('CollabSettingEntity');
    await repo.save(repo.create({ work_id: fixture.workId, test_character_id: charId, agent_id: agentId, whitelist_fields: ['identity', 'personality'] }));
    const row = await repo.findOneByOrFail({ work_id: fixture.workId });
    expect(row.enabled).toBe(false);
  });
});
