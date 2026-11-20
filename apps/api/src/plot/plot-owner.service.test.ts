import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { PlotTreeService } from './plot-tree.service';
import { PlotOwnerService, computeHidden } from './plot-owner.service';
import { CharacterEntity } from '../database/character.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { WorkService } from '../writing/work.service';

let fixture: WritingFixture;
let plotService: PlotTreeService;
let auditMock: { record: ReturnType<typeof vi.fn> };
let ownerService: PlotOwnerService;

async function createCharacter(name = '角色') {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const entity = repo.create({
    id: randomUUID(),
    work_id: fixture.workId,
    name,
    name_key: name.toLowerCase(),
    identity: null,
    age: 20,
    gender: '男',
    personality: '',
    experience: '',
    country_region: null,
    faith: null,
    faction: null,
    race: null,
    occupation: null,
    age_band: 'young',
    attributes: [],
    avatar_asset_id: null,
    status: 'active',
    merged_into_id: null,
    archived_at: null,
    archived_by: null,
    origin: 'manual',
    version: 1
  });
  return (await repo.save(entity)).id;
}

async function archiveCharacter(id: string) {
  await fixture.dataSource.getRepository(CharacterEntity).update(
    { id },
    { status: 'archived', archived_at: new Date(), archived_by: fixture.authorId, version: 2 }
  );
}

async function createPlotNode(title = '节点') {
  const tree = await fixture.dataSource.getRepository(PlotTreeEntity).findOneByOrFail({ work_id: fixture.workId });
  const repo = fixture.dataSource.getRepository(PlotNodeEntity);
  const node = repo.create({
    id: randomUUID(),
    tree_id: tree.id,
    parent_id: null,
    sibling_order: 0,
    title,
    summary: null,
    content: '',
    attributes: {},
    position_x: 0,
    position_y: 0,
    group_id: null,
    origin: 'manual'
  });
  const saved = await repo.save(node);
  // PlotTreeService 不推版本——因为这里是直接插节点，不走 withLockedTree；实际测试用它的归属逻辑即可
  return saved.id;
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  plotService = new PlotTreeService(fixture.dataSource, auditMock as never);
  ownerService = new PlotOwnerService(fixture.dataSource, auditMock as never);
  // 确保有一棵 plot tree
  await plotService.createTree(fixture.authorId, fixture.workId, { title: '主线' });
});

afterEach(() => destroyWritingFixture(fixture));

// ──────────────────── 纯函数 computeHidden ────────────────────

describe('computeHidden', () => {
  it('无任何归属 → 永不隐藏', () => {
    expect(computeHidden([])).toBe(false);
  });

  it('只有共享归属（is_exclusive=false）→ 永不隐藏', () => {
    expect(
      computeHidden([
        { character_id: 'a', is_exclusive: false, character_status: 'archived' }
      ])
    ).toBe(false);
  });

  it('1 个专属归属者，active → 不隐藏', () => {
    expect(
      computeHidden([{ character_id: 'a', is_exclusive: true, character_status: 'active' }])
    ).toBe(false);
  });

  it('1 个专属归属者，archived → 隐藏', () => {
    expect(
      computeHidden([{ character_id: 'a', is_exclusive: true, character_status: 'archived' }])
    ).toBe(true);
  });

  it('2 个专属归属者，一个 active 一个 archived → 不隐藏', () => {
    expect(
      computeHidden([
        { character_id: 'a', is_exclusive: true, character_status: 'active' },
        { character_id: 'b', is_exclusive: true, character_status: 'archived' }
      ])
    ).toBe(false);
  });

  it('2 个专属归属者，全部 archived → 隐藏', () => {
    expect(
      computeHidden([
        { character_id: 'a', is_exclusive: true, character_status: 'archived' },
        { character_id: 'b', is_exclusive: true, character_status: 'merged' }
      ])
    ).toBe(true);
  });

  it('混合：共享归属（archived）+ 专属归属（active）→ 不隐藏', () => {
    expect(
      computeHidden([
        { character_id: 'a', is_exclusive: false, character_status: 'archived' },
        { character_id: 'b', is_exclusive: true, character_status: 'active' }
      ])
    ).toBe(false);
  });
});

// ──────────────────── PlotOwnerService 集成 ────────────────────

describe('PlotOwnerService · 写操作', () => {
  it('整组替换：写入归属 + 默认 is_exclusive=true + 审计', async () => {
    const nodeId = await createPlotNode('初遇');
    const charA = await createCharacter('江离');
    const charB = await createCharacter('沈砚');
    const result = await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA },
      { character_id: charB }
    ]);
    expect(result.owners).toHaveLength(2);
    expect(result.owners.every((o) => o.is_exclusive)).toBe(true);
    expect(result.hidden).toBe(false);
    expect(auditMock.record).toHaveBeenCalledWith(
      fixture.authorId,
      'plot_node_owners_set',
      'plot_node',
      nodeId,
      { count: 2 },
      fixture.workId,
      expect.anything()
    );

    // 数据库 UNIQUE 约束生效：同节点同角色再写会被覆盖（set 先 delete）
    const second = await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA }
    ]);
    expect(second.owners).toHaveLength(1);
  });

  it('空数组清空归属', async () => {
    const nodeId = await createPlotNode('初遇');
    const charA = await createCharacter('江离');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [{ character_id: charA }]);
    const cleared = await ownerService.set(fixture.authorId, fixture.workId, nodeId, []);
    expect(cleared.owners).toEqual([]);
    expect(cleared.hidden).toBe(false);

    const list = await ownerService.list(fixture.authorId, fixture.workId, nodeId);
    expect(list.owners).toEqual([]);
  });

  it('去重 + ≤10 上限', async () => {
    const nodeId = await createPlotNode('初遇');
    const chars = await Promise.all(Array.from({ length: 11 }, (_, i) => createCharacter(`角色${i}`)));

    // 超上限 → 422
    await expect(
      ownerService.set(
        fixture.authorId,
        fixture.workId,
        nodeId,
        chars.map((id) => ({ character_id: id }))
      )
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // 同角色重复 → 自动去重
    const charA = chars[0]!;
    const result = await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA },
      { character_id: charA },
      { character_id: charA }
    ]);
    expect(result.owners).toHaveLength(1);
  });

  it('归属者 archived → 409', async () => {
    const nodeId = await createPlotNode('初遇');
    const archivedCharId = await createCharacter('已归档角色');
    await archiveCharacter(archivedCharId);
    await expect(
      ownerService.set(fixture.authorId, fixture.workId, nodeId, [{ character_id: archivedCharId }])
    ).rejects.toMatchObject({ response: { code: 'PLOT_OWNER_CHARACTER_ARCHIVED' } });
  });

  it('归属者跨作品 → 404', async () => {
    const nodeId = await createPlotNode('初遇');
    // 先给 otherAuthor 建一个合法 work，用它的 work_id 造合法角色
    const otherWork = await new WorkService(fixture.dataSource).create(fixture.otherAuthorId, {
      title: '他的书', description: ''
    });
    const otherRepo = fixture.dataSource.getRepository(CharacterEntity);
    const otherChar = otherRepo.create({
      id: randomUUID(),
      work_id: otherWork.work.id,
      name: '他作品角色',
      name_key: '他作品角色'.toLowerCase(),
      identity: null, age: 20, gender: '男',
      personality: '', experience: '',
      country_region: null, faith: null, faction: null, race: null, occupation: null,
      age_band: 'young', attributes: [], avatar_asset_id: null,
      status: 'active', merged_into_id: null, archived_at: null, archived_by: null,
      origin: 'manual', version: 1
    });
    const otherId = (await otherRepo.save(otherChar)).id;
    await expect(
      ownerService.set(fixture.authorId, fixture.workId, nodeId, [{ character_id: otherId }])
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('节点不存在 / 越权 → 404', async () => {
    const charA = await createCharacter('江离');
    await expect(
      ownerService.set(fixture.authorId, fixture.workId, randomUUID(), [{ character_id: charA }])
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PlotOwnerService · A6/Q4 差异更新', () => {
  it('1 个专属归属 → 更新 is_exclusive，不产生重复行', async () => {
    const nodeId = await createPlotNode('单专属');
    const charA = await createCharacter('江离');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA, is_exclusive: true }
    ]);
    const updated = await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA, is_exclusive: false }
    ]);
    expect(updated.owners).toHaveLength(1);
    expect(updated.owners[0]?.is_exclusive).toBe(false);
  });

  it('2 个专属：归档行保留，未出现 active 行删除', async () => {
    const nodeId = await createPlotNode('双专属');
    const charA = await createCharacter('江离');
    const charB = await createCharacter('沈砚');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA },
      { character_id: charB }
    ]);
    await archiveCharacter(charB);

    // 归档行不在请求中 → 保留；active 的 A 保留
    const afterRemoveOther = await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA }
    ]);
    expect(afterRemoveOther.owners.map((o) => o.character_id).sort()).toEqual([charA, charB].sort());

    // 清空 active：只删 A，B 归档行保留
    const cleared = await ownerService.set(fixture.authorId, fixture.workId, nodeId, []);
    expect(cleared.owners.map((o) => o.character_id)).toEqual([charB]);
    expect(cleared.hidden).toBe(true);
  });

  it('多专属：部分归档后隐藏判定仍以 active 为准', async () => {
    const nodeId = await createPlotNode('多专属');
    const charA = await createCharacter('A');
    const charB = await createCharacter('B');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA },
      { character_id: charB }
    ]);
    await archiveCharacter(charA);
    const partial = await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charB }
    ]);
    expect(partial.hidden).toBe(false);
    await archiveCharacter(charB);
    const allArchived = await ownerService.set(fixture.authorId, fixture.workId, nodeId, []);
    expect(allArchived.owners).toHaveLength(2);
    expect(allArchived.hidden).toBe(true);
  });
});

describe('PlotOwnerService · 隐藏判定（真实 DB）', () => {
  it('共享归属（is_exclusive=false）永不隐藏，即使角色已归档', async () => {
    const nodeId = await createPlotNode('共享节点');
    const charA = await createCharacter('江离');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA, is_exclusive: false }
    ]);
    await archiveCharacter(charA);
    const list = await ownerService.list(fixture.authorId, fixture.workId, nodeId);
    expect(list.hidden).toBe(false);
  });

  it('1 个专属归属者 active → 不隐藏；归档后 → 隐藏', async () => {
    const nodeId = await createPlotNode('专属节点');
    const charA = await createCharacter('江离');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [{ character_id: charA }]);
    expect((await ownerService.list(fixture.authorId, fixture.workId, nodeId)).hidden).toBe(false);
    await archiveCharacter(charA);
    expect((await ownerService.list(fixture.authorId, fixture.workId, nodeId)).hidden).toBe(true);
  });

  it('2 个专属归属者：一个 archived 一个 active → 不隐藏', async () => {
    const nodeId = await createPlotNode('双专属节点');
    const charA = await createCharacter('江离');
    const charB = await createCharacter('沈砚');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA },
      { character_id: charB }
    ]);
    await archiveCharacter(charA);
    const list = await ownerService.list(fixture.authorId, fixture.workId, nodeId);
    expect(list.hidden).toBe(false);
  });

  it('2 个专属归属者全部 archived → 隐藏', async () => {
    const nodeId = await createPlotNode('双专属节点');
    const charA = await createCharacter('江离');
    const charB = await createCharacter('沈砚');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [
      { character_id: charA },
      { character_id: charB }
    ]);
    await archiveCharacter(charA);
    await archiveCharacter(charB);
    const list = await ownerService.list(fixture.authorId, fixture.workId, nodeId);
    expect(list.hidden).toBe(true);
  });
});

describe('PlotOwnerService · 归档影响统计', () => {
  it('无归属时 exclusive_archived_nodes=hidden_nodes=0', async () => {
    await createPlotNode('节点一');
    await createPlotNode('节点二');
    const stats = await ownerService.exclusiveArchivedStats(fixture.authorId, fixture.workId);
    expect(stats.exclusive_archived_nodes).toBe(0);
    expect(stats.hidden_nodes).toBe(0);
    expect(stats.total_nodes).toBe(2);
  });

  it('正确统计专属归档节点与隐藏节点', async () => {
    const nodeA = await createPlotNode('A');
    const nodeB = await createPlotNode('B');
    const nodeC = await createPlotNode('C');
    const charA = await createCharacter('A');
    const charB = await createCharacter('B');
    const charC = await createCharacter('C');

    // A：专属归属，稍后归档角色 → 隐藏
    await ownerService.set(fixture.authorId, fixture.workId, nodeA, [{ character_id: charA }]);
    // B：共享归属 → 永不隐藏
    await ownerService.set(fixture.authorId, fixture.workId, nodeB, [
      { character_id: charB, is_exclusive: false }
    ]);
    // C：专属 + active → 不隐藏
    await ownerService.set(fixture.authorId, fixture.workId, nodeC, [{ character_id: charC }]);

    await archiveCharacter(charA);
    await archiveCharacter(charB); // 共享归档，不影响
    // charC 保持 active

    const stats = await ownerService.exclusiveArchivedStats(fixture.authorId, fixture.workId);
    expect(stats.total_nodes).toBe(3);
    // A 和 C 有 exclusive 归属（B 没有）
    expect(stats.exclusive_archived_nodes).toBe(2);
    // 只有 A 隐藏
    expect(stats.hidden_nodes).toBe(1);
  });
});

describe('PlotOwnerService · 删除归属', () => {
  it('单条删除不存在的归属 → removed=false，不写审计', async () => {
    const nodeId = await createPlotNode('节点');
    await ownerService.remove(fixture.authorId, fixture.workId, nodeId, randomUUID());
    // 审计只在 removed=true 时写——这里被事务回滚也没关系，直接计数
    const beforeCalls = auditMock.record.mock.calls.filter(
      (c) => c[1] === 'plot_node_owner_remove'
    ).length;
    await ownerService.remove(fixture.authorId, fixture.workId, nodeId, randomUUID());
    const afterCalls = auditMock.record.mock.calls.filter(
      (c) => c[1] === 'plot_node_owner_remove'
    ).length;
    expect(afterCalls - beforeCalls).toBe(0);
  });

  it('单条删除存在的归属 → removed=true + 审计', async () => {
    const nodeId = await createPlotNode('节点');
    const charA = await createCharacter('江离');
    await ownerService.set(fixture.authorId, fixture.workId, nodeId, [{ character_id: charA }]);
    const result = await ownerService.remove(fixture.authorId, fixture.workId, nodeId, charA);
    expect(result.removed).toBe(true);
    expect(result.node_id).toBe(nodeId);

    const list = await ownerService.list(fixture.authorId, fixture.workId, nodeId);
    expect(list.owners).toEqual([]);
    expect(auditMock.record).toHaveBeenCalledWith(
      fixture.authorId,
      'plot_node_owner_remove',
      'plot_node',
      nodeId,
      { character_id: charA },
      fixture.workId,
      expect.anything()
    );
  });
});
