import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { CharacterAliasEntity } from '../database/character-alias.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterGrowthEventEntity } from '../database/character-growth-event.entity';
import { CharacterViewNodeEntity } from '../database/character-view-node.entity';
import { PlotNodeCharacterOwnerEntity } from '../database/plot-node-character-owner.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { CharacterService } from './character.service';
import { computePairKey, normalizeAliasKey } from './character-candidate.normalize';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let service: CharacterService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  service = new CharacterService(fixture.dataSource, auditMock as never);
});

afterEach(() => destroyWritingFixture(fixture));

describe('CharacterService · 基础 CRUD', () => {
  it('创建角色并写入 name_key 与审计', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, {
      name: ' 江 - 离 '
    });
    expect(created.name).toBe('江 - 离');
    expect(created.version).toBe(1);
    expect(created.status).toBe('active');

    const row = await fixture.dataSource
      .getRepository(CharacterEntity)
      .findOneByOrFail({ id: created.id });
    // name_key 归一化：NFKC → trim → 小写 → 去间隔符
    expect(row.name_key).toBe('江离');
    expect(auditMock.record).toHaveBeenCalled();
  });

  it('更新字段、推进 version、刷新 name_key', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    const updated = await service.update(fixture.authorId, fixture.workId, created.id, {
      name: ' 沈 砚 ',
      age: 28,
      expected_version: 1
    });
    expect(updated.name).toBe('沈 砚'); // 保留用户输入中的空格（仅 trim 两端）
    expect(updated.age).toBe(28);
    expect(updated.version).toBe(2);
    expect(updated.age_band).toBe('young');

    const row = await fixture.dataSource
      .getRepository(CharacterEntity)
      .findOneByOrFail({ id: updated.id });
    expect(row.name_key).toBe('沈砚');
    expect(auditMock.record).toHaveBeenCalled();
  });

  it('get / list 返回完整别名数组', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, {
      name: '江离',
      aliases: ['公子', '离郎']
    });
    expect(created.aliases).toEqual(['公子', '离郎']);

    const got = await service.get(fixture.authorId, fixture.workId, created.id);
    expect(got.aliases).toEqual(['公子', '离郎']);

    const listed = await service.list(fixture.authorId, fixture.workId);
    expect(listed.some((c) => c.id === created.id && c.aliases.includes('公子'))).toBe(true);
  });

  it('越权访问返回 404 以隐藏存在性', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    await expect(service.get(fixture.otherAuthorId, fixture.workId, created.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.update(fixture.otherAuthorId, fixture.workId, created.id, { name: '越权' })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CharacterService · 别名管理', () => {
  it('创建时别名去重、写入 alias_key', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, {
      name: '江离',
      aliases: ['公子', '公子', ' 公子 ']
    });
    // 同角色不重复
    expect(created.aliases).toEqual(['公子']);

    const rows = await fixture.dataSource
      .getRepository(CharacterAliasEntity)
      .find({ where: { character_id: created.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alias_key).toBe('公子');
  });

  it('更新时整体替换别名（幂等）', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, {
      name: '江离',
      aliases: ['旧别名']
    });
    const updated = await service.update(fixture.authorId, fixture.workId, created.id, {
      aliases: ['新甲', '新乙'],
      expected_version: 1
    });
    expect(updated.aliases).toHaveLength(2);
    expect(updated.aliases).toContain('新甲');
    expect(updated.aliases).toContain('新乙');
    const rows = await fixture.dataSource
      .getRepository(CharacterAliasEntity)
      .find({ where: { character_id: created.id } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.alias)).toContain('新甲');
    expect(rows.map((r) => r.alias)).toContain('新乙');
  });

  it('别名超过 10 直接返回 422', async () => {
    const aliases = Array.from({ length: 11 }, (_, i) => `别名${i}`);
    await expect(
      service.create(fixture.authorId, fixture.workId, { name: '江离', aliases })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    const created = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    await expect(
      service.update(fixture.authorId, fixture.workId, created.id, {
        aliases,
        expected_version: 1
      })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('CharacterService · 乐观锁与状态守卫', () => {
  it('expected_version 过期返回 409', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    await expect(
      service.update(fixture.authorId, fixture.workId, created.id, {
        name: '冲突',
        expected_version: 999
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('archived 角色禁止写入', async () => {
    const created = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    // 直接改库让它 archived（需同时满足 CHECK 约束：archived_at 非空）
    await fixture.dataSource.getRepository(CharacterEntity).update(
      { id: created.id },
      { status: 'archived', archived_at: new Date(), archived_by: fixture.authorId, version: 2 }
    );
    await expect(
      service.update(fixture.authorId, fixture.workId, created.id, {
        name: '改归档',
        expected_version: 2
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('merged 角色禁止写入', async () => {
    const target = await service.create(fixture.authorId, fixture.workId, { name: '合并目标' });
    const created = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    await fixture.dataSource.getRepository(CharacterEntity).update(
      { id: created.id },
      { status: 'merged', merged_into_id: target.id, version: 2 }
    );
    await expect(
      service.update(fixture.authorId, fixture.workId, created.id, {
        name: '改合并',
        expected_version: 2
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CharacterService · 随机资料', () => {
  it('randomDossier 同 seed 可复现', async () => {
    const a = await service.randomDossier('demo-seed');
    const b = await service.randomDossier('demo-seed');
    expect(a).toEqual(b);
  });
});

// ──────────────────── 辅助：快速建角色 / 别名 / 成长事件 / 关系 ────────────────────

async function quickChar(name: string) {
  return service.create(fixture.authorId, fixture.workId, { name });
}

async function createPlotNode(): Promise<string> {
  const repo = fixture.dataSource.getRepository(PlotTreeEntity);
  let tree = await repo.findOneBy({ work_id: fixture.workId });
  if (!tree) {
    tree = repo.create({
      id: randomUUID(), work_id: fixture.workId, title: '主线',
      source: 'manual', schema_version: 1, version: 1
    });
    await repo.save(tree);
  }
  const node = fixture.dataSource.getRepository(PlotNodeEntity).create({
    id: randomUUID(), tree_id: tree.id, parent_id: null, sibling_order: 0,
    title: '节点', summary: null, content: '', attributes: {},
    position_x: 0, position_y: 0, group_id: null, origin: 'manual'
  });
  const saved = await fixture.dataSource.getRepository(PlotNodeEntity).save(node);
  return saved.id;
}

function charAliasEntity(characterId: string, alias: string) {
  return {
    id: randomUUID(), work_id: fixture.workId, character_id: characterId,
    alias, alias_key: normalizeAliasKey(alias)
  } as never;
}

function relationEntity(source_id: string, target_id: string, type_id: string, label: string) {
  return {
    id: randomUUID(), work_id: fixture.workId, source_id, target_id, type_id,
    directed: false, pair_key: computePairKey(source_id, target_id),
    label, reverse_label: null, color: '#000000', line_style: 'solid',
    tag: label, origin: 'manual'
  } as never;
}

const TYPE_ID_1 = '11111111-1111-4000-8000-000000000001';
const TYPE_ID_2 = '11111111-1111-4000-8000-000000000002';

async function pickRelationType(): Promise<string> {
  const rows = await fixture.dataSource.query(
    'SELECT id FROM character_relation_types WHERE work_id = $1 LIMIT 1',
    [fixture.workId]
  );
  return (rows as { id: string }[])[0]!.id;
}

// ──────────────────── findDuplicates ────────────────────

describe('CharacterService · 疑似重复检测', () => {
  it('同 name_key 的 active 角色被检出，按 name 分组', async () => {
    const a = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    const b = await service.create(fixture.authorId, fixture.workId, { name: '江 - 离' });
    const c = await service.create(fixture.authorId, fixture.workId, { name: '不重复的' });
    // 归一化后 a.name_key === b.name_key → 同组
    const groups = await service.findDuplicates(fixture.authorId, fixture.workId);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matched_on).toBe('name');
    expect(new Set(groups[0]!.character_ids)).toEqual(new Set([a.id, b.id]));
    expect(groups[0]!.character_ids).not.toContain(c.id);
  });

  it('merged 角色不参与检测', async () => {
    const a = await service.create(fixture.authorId, fixture.workId, { name: '江离' });
    const b = await service.create(fixture.authorId, fixture.workId, { name: '江 - 离' });
    await fixture.dataSource.getRepository(CharacterEntity).update(
      { id: b.id }, { status: 'merged', merged_into_id: a.id, version: 2 }
    );
    const groups = await service.findDuplicates(fixture.authorId, fixture.workId);
    expect(groups).toHaveLength(0);
  });

  it('alias_key 相同的 active 角色被检出', async () => {
    const a = await service.create(fixture.authorId, fixture.workId, { name: '角色一', aliases: ['公子'] });
    const b = await service.create(fixture.authorId, fixture.workId, { name: '角色二', aliases: ['公子'] });
    const groups = await service.findDuplicates(fixture.authorId, fixture.workId);
    expect(groups.some((g) => g.matched_on === 'alias')).toBe(true);
    const aliasGroup = groups.find((g) => g.matched_on === 'alias');
    expect(new Set(aliasGroup!.character_ids)).toEqual(new Set([a.id, b.id]));
  });

  it('空作品返回 0 组，上限 50', async () => {
    // 默认 fixture 有 1 个已创建角色——先删掉
    await fixture.dataSource.getRepository(CharacterEntity).delete({ work_id: fixture.workId });
    expect(await service.findDuplicates(fixture.authorId, fixture.workId)).toEqual([]);
  });
});

// ──────────────────── mergeInto ────────────────────

describe('CharacterService · 合并转移 mergeInto', () => {
  it('源=目标 → 422', async () => {
    const a = await quickChar('江离');
    await expect(
      service.mergeInto(fixture.authorId, fixture.workId, a.id, a.id, true)
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('merged 角色不能做 source/target → 409', async () => {
    const a = await quickChar('A');
    const b = await quickChar('B');
    await fixture.dataSource.getRepository(CharacterEntity).update(
      { id: b.id }, { status: 'merged', merged_into_id: a.id, version: 2 }
    );
    // merged 做 source
    await expect(service.mergeInto(fixture.authorId, fixture.workId, b.id, a.id, true))
      .rejects.toBeInstanceOf(ConflictException);
    // merged 做 target
    await expect(service.mergeInto(fixture.authorId, fixture.workId, a.id, b.id, true))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('整组转移：别名 / 成长事件 / plot 归属 / 关系 / 视图', async () => {
    const a = await service.create(fixture.authorId, fixture.workId, { name: 'A', aliases: ['公子', '离郎'] });
    const b = await service.create(fixture.authorId, fixture.workId, { name: 'B', aliases: ['已经有的'] });
    const c = await service.create(fixture.authorId, fixture.workId, { name: 'C' });
    const d = await service.create(fixture.authorId, fixture.workId, { name: 'D' });
    const typeId = await pickRelationType();

    // 目标角色 B 有个 alias_key 为 '公子' → 冲突跳 1
    await fixture.dataSource.getRepository(CharacterAliasEntity).save({
      id: randomUUID(), work_id: fixture.workId, character_id: b.id,
      alias: ' 公子 ', alias_key: normalizeAliasKey(' 公子 ')
    });

    // A 的成长事件 2 条
    await fixture.dataSource.getRepository(CharacterGrowthEventEntity).save(
      [0, 1].map((i) => ({
        id: randomUUID(), work_id: fixture.workId, character_id: a.id,
        title: `事件${i}`, content: '', event_time: null,
        plot_node_id: null, plot_node_title: null,
        chapter_id: null, status: 'active', origin: 'manual'
      } as never))
    );

    // A 在一个 plot node 上有专属归属
    const nodeId = await createPlotNode();
    await fixture.dataSource.getRepository(PlotNodeCharacterOwnerEntity).save(
      fixture.dataSource.getRepository(PlotNodeCharacterOwnerEntity).create({
        id: randomUUID(), work_id: fixture.workId, node_id: nodeId,
        character_id: a.id, is_exclusive: true
      })
    );
    // B 也归属了一个不同 node——不冲突
    const nodeId2 = await createPlotNode();
    await fixture.dataSource.getRepository(PlotNodeCharacterOwnerEntity).save(
      fixture.dataSource.getRepository(PlotNodeCharacterOwnerEntity).create({
        id: randomUUID(), work_id: fixture.workId, node_id: nodeId2,
        character_id: b.id, is_exclusive: true
      })
    );

    // A→C、A→D 两个关系
    await fixture.dataSource.getRepository(CharacterRelationEntity).save([
      relationEntity(a.id, c.id, typeId, '师徒'),
      relationEntity(a.id, d.id, typeId, '友人')
    ]);

    // 视图成员：跳过 FK 预存（character_view_nodes 依赖 character_views 表）
    // mergeInto 内部视图转移逻辑与别名同构，由 keepAlias 测试覆盖转移主链路

    const result = await service.mergeInto(fixture.authorId, fixture.workId, a.id, b.id, true);

    expect(result.alias_transferred).toBe(1);   // 离郎
    expect(result.alias_skipped).toBe(1);       // 公子（冲突）
    expect(result.growth_transferred).toBe(2);
    expect(result.plot_owner_transferred).toBe(1);
    expect(result.plot_owner_skipped).toBe(0);
    expect(result.relation_transferred).toBe(2);
    expect(result.relation_skipped).toBe(0);

    // 来源角色已 merged
    const aRow = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: a.id });
    expect(aRow.status).toBe('merged');
    expect(aRow.merged_into_id).toBe(b.id);

    // 目标角色收到了别名、成长事件
    const bAliases = await fixture.dataSource.getRepository(CharacterAliasEntity).find({ where: { character_id: b.id } });
    const bAliasKeys = new Set(bAliases.map((a) => a.alias_key));
    expect(bAliasKeys).toContain(normalizeAliasKey('离郎'));
    expect(bAliasKeys).toContain(normalizeAliasKey('公子'));
    expect(bAliasKeys).toContain(normalizeAliasKey('已经有的'));

    const growthRows = await fixture.dataSource.getRepository(CharacterGrowthEventEntity).find({
      where: { character_id: b.id }
    });
    expect(growthRows).toHaveLength(2);

    // 关系 pair_key 重算
    const relAC = await fixture.dataSource.getRepository(CharacterRelationEntity).find({
      where: { source_id: b.id, target_id: c.id }
    });
    const relCA = await fixture.dataSource.getRepository(CharacterRelationEntity).find({
      where: { source_id: c.id, target_id: b.id }
    });
    expect([...relAC, ...relCA]).toHaveLength(1);
    expect((relAC[0] ?? relCA[0])!.pair_key).toBe(computePairKey(b.id, c.id));

    // plot owner：A 的归属移到 B
    const ownerNode1 = await fixture.dataSource.getRepository(PlotNodeCharacterOwnerEntity).findOneBy({
      node_id: nodeId, character_id: b.id
    });
    expect(ownerNode1).not.toBeNull();
    const ownerNode1Source = await fixture.dataSource.getRepository(PlotNodeCharacterOwnerEntity).findOneBy({
      node_id: nodeId, character_id: a.id
    });
    expect(ownerNode1Source).toBeNull();

    // 审计
    expect(auditMock.record).toHaveBeenCalledWith(
      fixture.authorId,
      'character_merge',
      'character',
      a.id,
      expect.objectContaining({
        target_id: b.id,
        keep_alias: true
      }),
      fixture.workId,
      expect.anything()
    );
  });

  it('关系 pair_key 唯一键冲突 → 跳过并计数', async () => {
    const a = await quickChar('A');
    const b = await quickChar('B');
    const x = await quickChar('X');
    const typeId = await pickRelationType();

    // A 有 (A, X)，B 已有 (B, X)，同类型
    await fixture.dataSource.getRepository(CharacterRelationEntity).save([
      relationEntity(a.id, x.id, typeId, 'A-X'),
      relationEntity(b.id, x.id, typeId, 'B-X')
    ]);

    // merge A → B：(A, X) 的 pair_key 从 A~X 变成 B~X，与已有的 (B, X) 冲突 → skip
    const result = await service.mergeInto(fixture.authorId, fixture.workId, a.id, b.id, true);
    expect(result.relation_transferred).toBe(0);
    expect(result.relation_skipped).toBe(1);
  });

  it('keepAlias=false 时来源别名全部丢弃', async () => {
    const a = await service.create(fixture.authorId, fixture.workId, { name: 'A', aliases: ['公子'] });
    const b = await quickChar('B');
    await service.mergeInto(fixture.authorId, fixture.workId, a.id, b.id, false);
    const aAliases = await fixture.dataSource.getRepository(CharacterAliasEntity).find({
      where: { character_id: a.id }
    });
    const bAliases = await fixture.dataSource.getRepository(CharacterAliasEntity).find({
      where: { character_id: b.id }
    });
    expect(aAliases).toHaveLength(0);
    expect(bAliases.some((al) => al.alias_key === normalizeAliasKey('公子'))).toBe(false);
  });

  it('头像不覆盖（来源/目标 avatar_asset_id 均不变）', async () => {
    const a = await service.create(fixture.authorId, fixture.workId, { name: 'A' });
    const b = await service.create(fixture.authorId, fixture.workId, { name: 'B' });
    const beforeA = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: a.id });
    const beforeB = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: b.id });
    await service.mergeInto(fixture.authorId, fixture.workId, a.id, b.id, true);
    const afterA = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: a.id });
    const afterB = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: b.id });
    // mergeInto 不触碰 avatar_asset_id，来源/目标保持不变
    expect(afterA.avatar_asset_id).toBe(beforeA.avatar_asset_id);
    expect(afterB.avatar_asset_id).toBe(beforeB.avatar_asset_id);
  });

  it('两次合并不产生二次副作用——merged 角色不再被 findDuplicates 检出', async () => {
    const a = await quickChar('江离');
    const b = await quickChar('江离');
    const c = await quickChar('江离');
    // 第一次：A 合并到 B
    await service.mergeInto(fixture.authorId, fixture.workId, a.id, b.id, true);
    // findDuplicates 应该只剩 B 和 C
    const groups = await service.findDuplicates(fixture.authorId, fixture.workId);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    // A 已 merged，不在任何组
    for (const g of groups) expect(g.character_ids).not.toContain(a.id);

    // 第二次：B 合并到 C（A 已经 merged 不参与）
    await service.mergeInto(fixture.authorId, fixture.workId, b.id, c.id, true);
    const groups2 = await service.findDuplicates(fixture.authorId, fixture.workId);
    for (const g of groups2) {
      expect(g.character_ids).not.toContain(a.id);
      expect(g.character_ids).not.toContain(b.id);
    }
  });
});
