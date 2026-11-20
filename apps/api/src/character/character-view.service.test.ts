import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { CharacterViewEntity } from '../database/character-view.entity';
import { CharacterViewNodeEntity } from '../database/character-view-node.entity';
import { randomUUID } from 'node:crypto';
import { CharacterViewService } from './character-view.service';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let service: CharacterViewService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  service = new CharacterViewService(fixture.dataSource, auditMock as never);
});

afterEach(() => destroyWritingFixture(fixture));

async function quickChar(name: string, status: 'active' | 'archived' = 'active'): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const now = new Date();
  const e = repo.create({
    id: randomUUID(), work_id: fixture.workId, name, name_key: name.toLowerCase(),
    identity: null, age: 20, gender: '男', personality: '', experience: '',
    country_region: null, faith: null, faction: null, race: null, occupation: null,
    age_band: 'young', attributes: [], avatar_asset_id: null,
    status,
    merged_into_id: null,
    archived_at: status === 'archived' ? now : null,
    archived_by: status === 'archived' ? fixture.authorId : null,
    origin: 'manual', version: 1
  });
  return (await repo.save(e)).id;
}

describe('T14 CharacterViewService', () => {
  // ──────────────────── 默认视图 ────────────────────

  it('list 自动补齐默认视图，删除 409', async () => {
    const list = await service.list(fixture.authorId, fixture.workId);
    expect(list.some((v) => v.is_default)).toBe(true);
    const def = list.find((v) => v.is_default)!;
    await expect(service.delete(fixture.authorId, fixture.workId, def.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  // ──────────────────── 创建 ────────────────────

  it('创建视图默认加入全部 active 角色（auto_add_active 未传 / true）', async () => {
    const c1 = await quickChar('A');
    const c2 = await quickChar('B');
    const archivedId = await quickChar('C', 'archived');

    const v = await service.create(fixture.authorId, fixture.workId, { name: '板1' });
    expect(v.is_default).toBe(false);

    const nodes = await fixture.dataSource
      .getRepository(CharacterViewNodeEntity)
      .find({ where: { view_id: v.id } });
    const charIds = nodes.map((n) => n.character_id).sort();
    expect(charIds.sort()).toEqual([c1, c2].sort());
    expect(charIds).not.toContain(archivedId); // 归档角色不自动加入
  });

  it('auto_add_active=false → 空成员', async () => {
    await quickChar('X');
    const v = await service.create(fixture.authorId, fixture.workId, { name: '板2', auto_add_active: false });
    const nodes = await fixture.dataSource
      .getRepository(CharacterViewNodeEntity)
      .find({ where: { view_id: v.id } });
    expect(nodes).toEqual([]);
  });

  // ──────────────────── 成员 add/remove ────────────────────

  it('addMember 加入不存在的角色被跳过；重复加入幂等', async () => {
    const v = await service.create(fixture.authorId, fixture.workId, { name: '板3', auto_add_active: false });
    const c1 = await quickChar('P');
    const c2 = await quickChar('Q');

    const a1 = await service.addMember(fixture.authorId, fixture.workId, v.id, [c1, c2, randomUUID()]);
    expect(a1).toBe(2);
    const a2 = await service.addMember(fixture.authorId, fixture.workId, v.id, [c1]);
    expect(a2).toBe(0);
  });

  it('removeMember 幂等；未知角色静默跳过', async () => {
    const c1 = await quickChar('R');
    const v = await service.create(fixture.authorId, fixture.workId, { name: '板4', auto_add_active: true });
    const r1 = await service.removeMember(fixture.authorId, fixture.workId, v.id, [c1, randomUUID()]);
    expect(r1).toBe(1);
    const r2 = await service.removeMember(fixture.authorId, fixture.workId, v.id, [c1]);
    expect(r2).toBe(0);
  });

  // ──────────────────── 布局 upsert ────────────────────

  it('upsertLayout 幂等；未知成员忽略；不推进 view.version', async () => {
    const c1 = await quickChar('布局A');
    const c2 = await quickChar('布局B');
    const v = await service.create(fixture.authorId, fixture.workId, { name: '板5', auto_add_active: true });
    const beforeVer = v.version;
    const beforeNodes = await fixture.dataSource
      .getRepository(CharacterViewNodeEntity)
      .find({ where: { view_id: v.id } });

    const first = await service.upsertLayout(fixture.authorId, fixture.workId, v.id, [
      { character_id: c1, x: 10, y: 20 },
      { character_id: c2, x: 30, y: 40 },
      { character_id: randomUUID(), x: 99, y: 99 } // 未知
    ]);
    expect(first.updated).toBe(2);
    expect(first.ignored).toBe(1);

    const second = await service.upsertLayout(fixture.authorId, fixture.workId, v.id, [
      { character_id: c1, x: 10, y: 20 }
    ]);
    expect(second.updated).toBe(1); // 幂等：依然 update，返回 updated
    expect(second.ignored).toBe(0);

    // view.version 不变
    const dbView = await fixture.dataSource.getRepository(CharacterViewEntity).findOneByOrFail({ id: v.id });
    expect(dbView.version).toBe(beforeVer);
    // 节点数不变
    const afterNodes = await fixture.dataSource
      .getRepository(CharacterViewNodeEntity)
      .find({ where: { view_id: v.id } });
    expect(afterNodes.length).toBe(beforeNodes.length);
  });

  // ──────────────────── board 单次读全 ────────────────────

  it('getBoard 默认不含 archived；include_archived=true 才包含', async () => {
    const c1 = await quickChar('活跃角色');
    await quickChar('归档角色', 'archived');
    const v = await service.create(fixture.authorId, fixture.workId, { name: '板6', auto_add_active: true });

    const board1 = await service.getBoard(fixture.authorId, fixture.workId, v.id);
    expect(board1.members.length).toBe(1);
    expect(board1.members[0]!.id).toBe(c1);
    expect(board1.layouts).toBeInstanceOf(Map);
    expect(board1.relations).toBeDefined();
    expect(board1.relation_types).toBeDefined();

    // include_archived 时归档角色不会自动进 board，因为默认视图创建时只加 active
    // 手动把 archived 角色加进去
    const archivedId = await quickChar('归档角色2', 'archived');
    await service.addMember(fixture.authorId, fixture.workId, v.id, [archivedId]);
    const board2 = await service.getBoard(fixture.authorId, fixture.workId, v.id, { include_archived: true });
    const ids = board2.members.map((m) => m.id).sort();
    expect(ids).toEqual([c1, archivedId].sort());
  });

  it('board layouts 含位置，layout_ignored 忽略不存在的角色', async () => {
    const c1 = await quickChar('布局X');
    const c2 = await quickChar('布局Y');
    const v = await service.create(fixture.authorId, fixture.workId, { name: '板7', auto_add_active: true });
    await service.upsertLayout(fixture.authorId, fixture.workId, v.id, [
      { character_id: c1, x: 100, y: 200 }
    ]);
    const board = await service.getBoard(fixture.authorId, fixture.workId, v.id);
    expect(board.layouts.get(c1)).toEqual({ x: 100, y: 200 });
    expect(board.layouts.has(c2)).toBe(false); // c2 未 upsert，null → 不进 map
  });

  // ──────────────────── 版本冲突 ────────────────────

  it('update 带 expected_version 冲突 → 409', async () => {
    const v = await service.create(fixture.authorId, fixture.workId, { name: '板8', auto_add_active: false });
    await expect(
      service.update(fixture.authorId, fixture.workId, v.id, { name: '冲突改', version: 999 })
    ).rejects.toBeInstanceOf(ConflictException);
    // 不带 version → 通过
    await service.update(fixture.authorId, fixture.workId, v.id, { name: '正常改' });
  });

  it('update / delete 不存在视图 → 404', async () => {
    await expect(
      service.update(fixture.authorId, fixture.workId, randomUUID(), { name: 'nope' })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
