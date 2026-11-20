import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { DataSource } from 'typeorm';
import { CharacterGrowthService } from './character-growth.service';
import { randomUUID } from 'node:crypto';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let service: CharacterGrowthService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  service = new CharacterGrowthService(fixture.dataSource, auditMock as never);
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

describe('CharacterGrowthService', () => {
  it('创建成长事件 + 列表倒序 + 审计', async () => {
    const charId = await createCharacter('江离');
    const { event } = await service.create(fixture.authorId, fixture.workId, charId, {
      title: '初入江湖', event_time: '第一章'
    });
    expect(event.title).toBe('初入江湖');
    const list = await service.list(fixture.authorId, fixture.workId, charId);
    expect(list).toHaveLength(1);
    expect(auditMock.record).toHaveBeenCalledWith(
      fixture.authorId, 'growth_create', 'character_growth',
      event.id, expect.objectContaining({ character_id: charId }),
      fixture.workId, expect.anything()
    );
  });

  it('plot_node_id 缺失 → 返回 PLOT_NODE_MISSING warning，事件仍保存', async () => {
    const charId = await createCharacter('江离');
    const missingNodeId = randomUUID();
    const { event, warning } = await service.create(fixture.authorId, fixture.workId, charId, {
      title: '遭遇战', plot_node_id: missingNodeId
    });
    expect(event.plot_node_id).toBe(missingNodeId);
    expect(event.plot_node_title).toBeNull();
    expect(warning).toBeDefined();
    expect(warning?.code).toBe('PLOT_NODE_MISSING');
  });

  it('chapter_id 跨作品 → 404', async () => {
    const charId = await createCharacter('江离');
    await expect(
      service.create(fixture.authorId, fixture.workId, charId, {
        title: '章节引用', chapter_id: randomUUID()
      })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('归档角色不可写 → 409', async () => {
    const charId = await createCharacter('江离');
    await fixture.dataSource.getRepository(CharacterEntity).update(
      { id: charId }, { status: 'archived', archived_at: new Date(), archived_by: fixture.authorId, version: 2 }
    );
    await expect(
      service.create(fixture.authorId, fixture.workId, charId, { title: '不可加' })
    ).rejects.toBeInstanceOf(ConflictException);
    const list = await service.list(fixture.authorId, fixture.workId, charId);
    expect(list).toEqual([]); // 只读
  });

  it('更新 + 删除 + 审计', async () => {
    const charId = await createCharacter('江离');
    const created = (await service.create(fixture.authorId, fixture.workId, charId, { title: '事件1' })).event;
    const updated = await service.update(fixture.authorId, fixture.workId, created.id, { title: '事件1 改' });
    expect(updated.title).toBe('事件1 改');
    auditMock.record.mockClear();
    await service.delete(fixture.authorId, fixture.workId, created.id);
    expect(auditMock.record).toHaveBeenCalledWith(
      fixture.authorId, 'growth_delete', 'character_growth',
      created.id, expect.anything(), fixture.workId, expect.anything()
    );
  });
});
