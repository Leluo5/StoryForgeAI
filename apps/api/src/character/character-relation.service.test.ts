import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import { CharacterRelationService, CharacterRelationTypeService, RELATION_COLOR_PALETTE } from './character-relation.service';
import { DEFAULT_CHARACTER_RELATION_TYPES, seedCharacterRelationTypes } from '../database/character-relation-type.seed';
import { computePairKey } from './character-candidate.normalize';
import { DataSource } from 'typeorm';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let typeService: CharacterRelationTypeService;
let relationService: CharacterRelationService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
  typeService = new CharacterRelationTypeService(fixture.dataSource, auditMock as never);
  relationService = new CharacterRelationService(fixture.dataSource, auditMock as never, typeService);
  // 补种默认类型，便于后续测试引用 code
  await seedCharacterRelationTypes(
    { query: (sql: string, params?: unknown[]) => fixture.dataSource.query(sql, params) } as never,
    fixture.workId
  );
});

afterEach(() => destroyWritingFixture(fixture));

async function quickChar(name: string) {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const e = repo.create({
    id: require('node:crypto').randomUUID(),
    work_id: fixture.workId,
    name, name_key: name.toLowerCase(),
    identity: null, age: 20, gender: '男',
    personality: '', experience: '', country_region: null, faith: null,
    faction: null, race: null, occupation: null, age_band: 'young',
    attributes: [], avatar_asset_id: null,
    status: 'active', merged_into_id: null, archived_at: null, archived_by: null,
    origin: 'manual', version: 1
  });
  return (await repo.save(e)).id;
}

async function findTypeByCode(code: string): Promise<CharacterRelationTypeEntity> {
  return fixture.dataSource
    .getRepository(CharacterRelationTypeEntity)
    .findOneByOrFail({ work_id: fixture.workId, code });
}

// ──────────────────── 关系类型 ────────────────────

describe('CharacterRelationTypeService', () => {
  it('作品已补种 23 种内置类型，均 is_builtin=true', async () => {
    const list = await typeService.list(fixture.authorId, fixture.workId);
    expect(list).toHaveLength(DEFAULT_CHARACTER_RELATION_TYPES.length);
    expect(list.every((t) => t.is_builtin)).toBe(true);
  });

  it('内置类型不可删除 → 409', async () => {
    const builtin = await findTypeByCode('kinship_spouse');
    await expect(typeService.delete(fixture.authorId, fixture.workId, builtin.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('内置类型被引用 → 改方向 409；未引用可改名', async () => {
    const type = await findTypeByCode('kinship_spouse');
    const a = await quickChar('A');
    const b = await quickChar('B');
    await relationService.create(fixture.authorId, fixture.workId, {
      source_id: a, target_id: b, type_id: type.id, label: '夫妻'
    });
    await expect(
      typeService.update(fixture.authorId, fixture.workId, type.id, { directed: true })
    ).rejects.toBeInstanceOf(ConflictException);

    // 未引用的可改
    const custom = await typeService.create(fixture.authorId, fixture.workId, {
      label: '师徒', group_key: 'society', group_label: '社会', directed: true, reverse_label: '徒'
    });
    const updated = await typeService.update(fixture.authorId, fixture.workId, custom.id, { label: '师尊' });
    expect(updated.label).toBe('师尊');
  });

  it('被引用类型禁止删除 → 409', async () => {
    const custom = await typeService.create(fixture.authorId, fixture.workId, {
      label: '仇敌', group_key: 'camp', group_label: '阵营', directed: false
    });
    const a = await quickChar('A');
    const b = await quickChar('B');
    await relationService.create(fixture.authorId, fixture.workId, {
      source_id: a, target_id: b, type_id: custom.id, label: '仇敌'
    });
    await expect(typeService.delete(fixture.authorId, fixture.workId, custom.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('无方向类型 reverse_label 必须为空', async () => {
    await expect(
      typeService.create(fixture.authorId, fixture.workId, {
        label: '认识', group_key: 'other', group_label: '其他', directed: false, reverse_label: '被认识'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ──────────────────── 关系实例 ────────────────────

describe('CharacterRelationService', () => {
  it('自关联 → 409/BadRequest', async () => {
    const type = await findTypeByCode('kinship_spouse');
    const a = await quickChar('A');
    await expect(
      relationService.create(fixture.authorId, fixture.workId, { source_id: a, target_id: a, type_id: type.id, label: '自己' })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pair_key 归一化 UNIQUE 冲突返回既有 id', async () => {
    const type = await findTypeByCode('kinship_spouse');
    const a = await quickChar('A');
    const b = await quickChar('B');
    const first = await relationService.create(fixture.authorId, fixture.workId, {
      source_id: a, target_id: b, type_id: type.id, label: '夫妻'
    });
    expect(first.created).toBe(true);
    const second = await relationService.create(fixture.authorId, fixture.workId, {
      source_id: b, target_id: a, type_id: type.id, label: '夫妻反向'
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('调色板颜色按顺序轮转 + tag 默认 label', async () => {
    const type = await findTypeByCode('kinship_spouse');
    const chars = await Promise.all(Array.from({ length: 9 }, (_, i) => quickChar(`C${i}`)));
    // 前 8 对是新的（pair_key 各不相同），第 9 对颜色回到 0
    const results: CharacterRelationEntity[] = [];
    for (let i = 0; i < 8; i++) {
      const pair = await relationService.create(fixture.authorId, fixture.workId, {
        source_id: chars[i]!, target_id: chars[(i + 1) % 8]!, type_id: type.id, label: `夫妻${i}`
      });
      results.push(await fixture.dataSource.getRepository(CharacterRelationEntity).findOneByOrFail({ id: pair.id }));
    }
    expect(results[0]!.color).toBe(RELATION_COLOR_PALETTE[0]);
    expect(results[7]!.color).toBe(RELATION_COLOR_PALETTE[7]);
    expect(results.every((r) => r.tag === r.label)).toBe(true);
  });

  it('归档角色不可新增关系 → 409', async () => {
    const type = await findTypeByCode('kinship_spouse');
    const a = await quickChar('A');
    const b = await quickChar('B');
    await fixture.dataSource.getRepository(CharacterEntity).update(
      { id: a }, { status: 'archived', archived_at: new Date(), archived_by: fixture.authorId, version: 2 }
    );
    await expect(
      relationService.create(fixture.authorId, fixture.workId, { source_id: a, target_id: b, type_id: type.id, label: '夫妻' })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('方向快照：创建时读 type.directed，后续类型改方向不影响实例', async () => {
    const type = await findTypeByCode('kinship_spouse'); // directed=false
    const a = await quickChar('A');
    const b = await quickChar('B');
    const created = await relationService.create(fixture.authorId, fixture.workId, {
      source_id: a, target_id: b, type_id: type.id, label: '夫妻'
    });
    const rel = await fixture.dataSource.getRepository(CharacterRelationEntity).findOneByOrFail({ id: created.id });
    expect(rel.directed).toBe(false);

    // 类型改为 directed（但已经有实例——update 会拒绝）
    await expect(
      typeService.update(fixture.authorId, fixture.workId, type.id, { directed: true })
    ).rejects.toBeInstanceOf(ConflictException);

    // 实例的 directed 不变
    const rel2 = await fixture.dataSource.getRepository(CharacterRelationEntity).findOneByOrFail({ id: created.id });
    expect(rel2.directed).toBe(false);
  });

  it('relation_update / relation_delete 审计', async () => {
    const type = await findTypeByCode('kinship_spouse');
    const a = await quickChar('A');
    const b = await quickChar('B');
    const created = await relationService.create(fixture.authorId, fixture.workId, {
      source_id: a, target_id: b, type_id: type.id, label: '夫妻'
    });
    auditMock.record.mockClear();
    await relationService.update(fixture.authorId, fixture.workId, created.id, { label: '夫妻改' });
    await relationService.delete(fixture.authorId, fixture.workId, created.id);
    const actions = auditMock.record.mock.calls.map((c) => c[1]);
    expect(actions).toContain('relation_update');
    expect(actions).toContain('relation_delete');
  });
});
