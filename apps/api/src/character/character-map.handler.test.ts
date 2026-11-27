import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import { CharacterMapTaskHandler } from './character-map.handler';
import {
  CHARACTER_MAP_MODEL_PROVIDER,
  MockCharacterMapModelProvider,
  type CharacterMapModelProvider,
  type CharacterMapOutput
} from './character-map.model';

let fixture: WritingFixture;
let auditMock: { record: ReturnType<typeof vi.fn> };
let handler: CharacterMapTaskHandler;

beforeEach(async () => {
  fixture = await createWritingFixture();
  auditMock = { record: vi.fn() };
});

afterEach(() => destroyWritingFixture(fixture));

async function quickChar(
  name: string,
  opts: { status?: CharacterEntity['status']; mergedIntoId?: string } = {}
): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const e = repo.create({
    id: require('node:crypto').randomUUID(),
    work_id: fixture.workId,
    name, name_key: name.toLowerCase(),
    identity: null, age: 20, gender: '男',
    personality: '', experience: '', country_region: null, faith: null,
    faction: null, race: null, occupation: null, age_band: 'young',
    attributes: [], avatar_asset_id: null,
    status: opts.status ?? 'active',
    merged_into_id: opts.mergedIntoId ?? null,
    archived_at: null, archived_by: null,
    origin: 'manual', version: 1
  });
  return (await repo.save(e)).id;
}

async function findTypeByCode(code: string): Promise<CharacterRelationTypeEntity> {
  return fixture.dataSource
    .getRepository(CharacterRelationTypeEntity)
    .findOneByOrFail({ work_id: fixture.workId, code });
}

function makeHandler(model: CharacterMapModelProvider): CharacterMapTaskHandler {
  return new CharacterMapTaskHandler(fixture.dataSource, auditMock as never, model);
}

const ctx = {
  taskId: 't-1',
  authorId: 'a-1',
  workId: 'w-1',
  tool: 'character_map_generate',
  inputSummary: {}
};

describe('CharacterMapTaskHandler', () => {
  it('角色 < 2：不调用 LLM，返回空结果', async () => {
    const model = new MockCharacterMapModelProvider();
    const spy = vi.spyOn(model, 'generateCharacterMap');
    const h = makeHandler(model);
    await quickChar('独行者');
    const result = await h.handle({ ...ctx, authorId: fixture.authorId, workId: fixture.workId });
    expect(spy).not.toHaveBeenCalled();
    expect(result.relations_considered).toBe(0);
    expect(result.relations_created).toBe(0);
  });

  it('缺失对端角色：跳过该边不报错；有效边正常落库 origin=ai', async () => {
    const a = await quickChar('甲');
    const b = await quickChar('乙');
    const type = await findTypeByCode('kinship_spouse');
    const output: CharacterMapOutput = {
      relations: [
        { from: '甲', to: '不存在的角色', relation_type: 'kinship_spouse' }, // 缺失对端 → 跳过
        { from: '甲', to: '乙', relation_type: 'kinship_spouse' } // 有效 → 落库
      ]
    };
    const model = new MockCharacterMapModelProvider({ output });
    const h = makeHandler(model);
    const result = await h.handle({ ...ctx, authorId: fixture.authorId, workId: fixture.workId });
    expect(result.relations_considered).toBe(2);
    expect(result.relations_skipped_missing_char).toBe(1);
    expect(result.relations_created).toBe(1);

    const saved = await fixture.dataSource.getRepository(CharacterRelationEntity).find({
      where: { work_id: fixture.workId }
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.origin).toBe('ai');
    expect(saved[0]!.source_id).toBe(a);
    expect(saved[0]!.target_id).toBe(b);
    expect(saved[0]!.type_id).toBe(type.id);
  });

  it('自环跳过；无向重复跳过（A-B 与 B-A 同类型只落一条）', async () => {
    const a = await quickChar('甲');
    const b = await quickChar('乙');
    await quickChar('丙');
    const output: CharacterMapOutput = {
      relations: [
        { from: '甲', to: '甲', relation_type: 'kinship_spouse' }, // 自环 → 跳过
        { from: '甲', to: '乙', relation_type: 'kinship_spouse' }, // 落库
        { from: '乙', to: '甲', relation_type: 'kinship_spouse' } // 无向重复 → 跳过
      ]
    };
    const h = makeHandler(new MockCharacterMapModelProvider({ output }));
    const result = await h.handle({ ...ctx, authorId: fixture.authorId, workId: fixture.workId });
    expect(result.relations_skipped_self).toBe(1);
    expect(result.relations_skipped_dup).toBe(1);
    expect(result.relations_created).toBe(1);
  });

  it('类型归一：code 精确匹配；label 匹配；匹配不到 fallback 第一个类型', async () => {
    const a = await quickChar('甲');
    const b = await quickChar('乙');
    const c = await quickChar('丙');
    const output: CharacterMapOutput = {
      relations: [
        { from: '甲', to: '乙', relation_type: 'kinship_spouse' }, // code 精确
        { from: '乙', to: '丙', relation_type: '夫妻' }, // label 匹配
        { from: '甲', to: '丙', relation_type: '完全不存在的类型' } // fallback 第一个
      ]
    };
    const h = makeHandler(new MockCharacterMapModelProvider({ output }));
    const result = await h.handle({ ...ctx, authorId: fixture.authorId, workId: fixture.workId });
    expect(result.relations_created).toBe(3);

    const spouse = await findTypeByCode('kinship_spouse');
    const allTypes = await fixture.dataSource.getRepository(CharacterRelationTypeEntity).find({
      where: { work_id: fixture.workId },
      order: { sort_order: 'ASC' }
    });
    const fallbackType = allTypes[0]!;
    const repo = fixture.dataSource.getRepository(CharacterRelationEntity);

    // 事务内 created_at 相同，排序不稳定；改用 source/target 精确定位每条边
    const relAB = await repo.findOneByOrFail({ work_id: fixture.workId, source_id: a, target_id: b });
    expect(relAB.type_id).toBe(spouse.id); // code 精确

    const relBC = await repo.findOneByOrFail({ work_id: fixture.workId, source_id: b, target_id: c });
    expect(relBC.type_id).toBe(spouse.id); // label 匹配 → kinship_spouse

    const relAC = await repo.findOneByOrFail({ work_id: fixture.workId, source_id: a, target_id: c });
    expect(relAC.type_id).toBe(fallbackType.id); // fallback 第一个（sort_order 最小）
  });

  it('LLM 失败：向上抛 CharacterMapModelError（retryable），不落库', async () => {
    await quickChar('甲');
    await quickChar('乙');
    const h = makeHandler(new MockCharacterMapModelProvider({ fail: true }));
    await expect(h.handle({ ...ctx, authorId: fixture.authorId, workId: fixture.workId }))
      .rejects.toMatchObject({ retryable: true });
    const saved = await fixture.dataSource.getRepository(CharacterRelationEntity).find({
      where: { work_id: fixture.workId }
    });
    expect(saved).toHaveLength(0);
  });

  it('归档角色不参与建图（status!=active 不计入输入）', async () => {
    const a = await quickChar('甲');
    await quickChar('乙', { status: 'merged', mergedIntoId: a }); // 非 active（合并入甲），不参与建图
    const model = new MockCharacterMapModelProvider();
    const spy = vi.spyOn(model, 'generateCharacterMap');
    const h = makeHandler(model);
    const result = await h.handle({ ...ctx, authorId: fixture.authorId, workId: fixture.workId });
    // 仅 1 个 active 角色 < 2 → 空结果
    expect(spy).not.toHaveBeenCalled();
    expect(result.relations_created).toBe(0);
  });

  it('failDraft 为 best-effort 空实现（建图直接落库，无草稿可标）', async () => {
    const h = makeHandler(new MockCharacterMapModelProvider());
    await expect(h.failDraft(ctx as never, {})).resolves.toBeUndefined();
  });
});
