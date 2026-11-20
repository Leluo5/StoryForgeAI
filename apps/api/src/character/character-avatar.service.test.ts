import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { CharacterAvatarAssetEntity } from '../database/character-avatar-asset.entity';
import { DataSource } from 'typeorm';
import { CharacterAvatarService } from './character-avatar.service';
import { CharacterAvatarModelProvider } from './character-model.provider';
import { randomUUID } from 'node:crypto';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let provider: CharacterAvatarModelProvider;
let service: CharacterAvatarService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  provider = new CharacterAvatarModelProvider();
  service = new CharacterAvatarService(fixture.dataSource, auditMock as never, provider);
});

afterEach(() => destroyWritingFixture(fixture));

async function createCharacter(name: string): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const e = repo.create({
    id: randomUUID(), work_id: fixture.workId, name, name_key: name.toLowerCase(),
    identity: null, age: 20, gender: '男', personality: '', experience: '',
    country_region: null, faith: null, faction: null, race: null, occupation: null,
    age_band: 'young', attributes: [], avatar_asset_id: null,
    status: 'active', merged_into_id: null, archived_at: null, archived_by: null,
    origin: 'manual', version: 1
  });
  return (await repo.save(e)).id;
}

describe('CharacterAvatarService', () => {
  it('generate → pending，幂等 task_id 复用', async () => {
    const charId = await createCharacter('江离');
    const taskId = randomUUID();
    const a = await service.generate(fixture.authorId, fixture.workId, charId, { task_id: taskId });
    const b = await service.generate(fixture.authorId, fixture.workId, charId, { task_id: taskId });
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('pending');
    expect(a.content_hash).toBeTruthy();
    expect(a.mime).toBe('image/svg+xml');
    expect(a.task_id).toBe(taskId);
  });

  it('adopt：pending → active，同角色旧 active superseded', async () => {
    const charId = await createCharacter('江离');
    const a1 = await service.generate(fixture.authorId, fixture.workId, charId);
    const a2 = await service.generate(fixture.authorId, fixture.workId, charId);
    const adopted1 = await service.adopt(fixture.authorId, fixture.workId, a1.id);
    expect(adopted1.status).toBe('active');
    // 第二次 adopt 把 a1 置为 superseded
    await service.adopt(fixture.authorId, fixture.workId, a2.id);
    const recheck = await fixture.dataSource
      .getRepository(CharacterAvatarAssetEntity)
      .findOneByOrFail({ id: a1.id });
    expect(recheck.status).toBe('superseded');
    const a2Row = await fixture.dataSource
      .getRepository(CharacterAvatarAssetEntity)
      .findOneByOrFail({ id: a2.id });
    expect(a2Row.status).toBe('active');
    // character 表 avatar_asset_id 同步更新
    const charRow = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(charRow.avatar_asset_id).toBe(a2.id);
  });

  it('markFailed：pending → failed，不清除旧 active', async () => {
    const charId = await createCharacter('江离');
    const a1 = await service.generate(fixture.authorId, fixture.workId, charId);
    await service.adopt(fixture.authorId, fixture.workId, a1.id);
    const a2 = await service.generate(fixture.authorId, fixture.workId, charId);
    await service.markFailed(fixture.authorId, fixture.workId, a2.id, { message: 'mock error' });
    const a2Row = await fixture.dataSource
      .getRepository(CharacterAvatarAssetEntity)
      .findOneByOrFail({ id: a2.id });
    expect(a2Row.status).toBe('failed');
    // 旧的 a1 active 仍在
    const a1Row = await fixture.dataSource
      .getRepository(CharacterAvatarAssetEntity)
      .findOneByOrFail({ id: a1.id });
    expect(a1Row.status).toBe('active');
  });

  it('不存在资产 adopt/markFailed → 404', async () => {
    await expect(
      service.adopt(fixture.authorId, fixture.workId, randomUUID())
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('审计：avatar_generate / avatar_adopt / avatar_fail', async () => {
    const charId = await createCharacter('江离');
    const a1 = await service.generate(fixture.authorId, fixture.workId, charId);
    await service.adopt(fixture.authorId, fixture.workId, a1.id);
    const a2 = await service.generate(fixture.authorId, fixture.workId, charId);
    await service.markFailed(fixture.authorId, fixture.workId, a2.id, { message: 'mock' });
    const actions = auditMock.record.mock.calls.map((c) => c[1]);
    expect(actions).toContain('avatar_generate');
    expect(actions).toContain('avatar_adopt');
    expect(actions).toContain('avatar_fail');
  });
});
