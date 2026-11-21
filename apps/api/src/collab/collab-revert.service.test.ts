import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CharacterEntity } from '../database/character.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { AiTaskEntity } from '../database/ai-task.entity';
import { CollabRevertService } from './collab-revert.service';

// T15 撤销服务单测：真实 DB fixture，直接 new 服务（不经 DI）。

let fixture: WritingFixture;
let service: CollabRevertService;

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createWritingFixture();
  service = new CollabRevertService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

async function seedCharacter(workId: string, fields: Partial<Pick<CharacterEntity, 'identity' | 'personality'>>): Promise<string> {
  const repo = fixture.dataSource.getRepository(CharacterEntity);
  const c = await repo.save(repo.create({
    id: randomUUID(),
    work_id: workId,
    name: '林默',
    name_key: '林默',
    identity: fields.identity ?? '边城少年',
    personality: fields.personality ?? '坚韧',
    experience: '经历内容',
    status: 'active'
  }));
  return c.id;
}

async function seedTask(workId: string, charId: string): Promise<string> {
  const repo = fixture.dataSource.getRepository(AiTaskEntity);
  const t = await repo.save(repo.create({
    id: randomUUID(),
    idempotency_key: randomUUID(),
    work_id: workId,
    chapter_id: null,
    scope: 'role_profile',
    channel: 'flowise',
    tool: 'role_profile',
    agent_id: null,
    input_summary: { character_id: charId, fields: ['identity', 'personality'], instruction: '补充角色' },
    base_version: 0,
    status: 'succeeded',
    created_by: fixture.authorId
  }));
  return t.id;
}

async function seedWriteback(
  workId: string,
  charId: string,
  taskId: string,
  fields: Array<{ key: string; before: unknown; after: unknown; status?: string }>
): Promise<{ writebackId: string; fieldIds: string[] }> {
  const wbRepo = fixture.dataSource.getRepository(RoleProfileWritebackEntity);
  const wb = await wbRepo.save(wbRepo.create({
    id: randomUUID(),
    task_id: taskId,
    work_id: workId,
    character_id: charId,
    channel: 'flowise',
    status: 'applied',
    applied_version: 2,
    applied_by: fixture.authorId
  }));
  const fieldRepo = fixture.dataSource.getRepository(RoleProfileWritebackFieldEntity);
  const fieldIds: string[] = [];
  for (const f of fields) {
    const row = await fieldRepo.save(fieldRepo.create({
      id: randomUUID(),
      writeback_id: wb.id,
      field_key: f.key,
      before_value: f.before,
      after_value: f.after,
      status: f.status ?? 'applied'
    }));
    fieldIds.push(row.id);
  }
  return { writebackId: wb.id, fieldIds };
}

describe('CollabRevertService (T15 按字段撤销)', () => {
  it('成功撤销：恢复 before_value + version+1 + 字段行 reverted + 写回单 reverted', async () => {
    const charId = await seedCharacter(fixture.workId, { identity: '边城少年·新', personality: '坚韧·新' });
    const taskId = await seedTask(fixture.workId, charId);
    // 单字段写回单：撤销唯一字段后整体 reverted
    const { writebackId } = await seedWriteback(fixture.workId, charId, taskId, [
      { key: 'identity', before: '边城少年', after: '边城少年·新' }
    ]);

    const result = await service.revertField(fixture.authorId, fixture.workId, writebackId, 'identity');

    expect(result.writebackStatus).toBe('reverted');
    expect(result.fieldStatus).toBe('reverted');
    expect(result.restoredValue).toBe('边城少年');
    // 手工 seed 角色 version 默认 1，撤销 +1 → 2
    expect(result.version).toBe(2);

    const character = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(character.identity).toBe('边城少年');
    expect(character.personality).toBe('坚韧·新');
    expect(character.version).toBe(2);

    const wb = await fixture.dataSource.getRepository(RoleProfileWritebackEntity).findOneByOrFail({ id: writebackId });
    expect(wb.status).toBe('reverted');
  });

  it('部分字段撤销 → partially_reverted', async () => {
    const charId = await seedCharacter(fixture.workId, { identity: '边城少年·新', personality: '坚韧·新' });
    const taskId = await seedTask(fixture.workId, charId);
    const { writebackId } = await seedWriteback(fixture.workId, charId, taskId, [
      { key: 'identity', before: '边城少年', after: '边城少年·新' },
      { key: 'personality', before: '坚韧', after: '坚韧·新' }
    ]);

    const result = await service.revertField(fixture.authorId, fixture.workId, writebackId, 'identity');
    expect(result.writebackStatus).toBe('partially_reverted');
    const wb = await fixture.dataSource.getRepository(RoleProfileWritebackEntity).findOneByOrFail({ id: writebackId });
    expect(wb.status).toBe('partially_reverted');
  });

  it('冲突（当前值 ≠ after_value）→ 返回 conflict，字段与版本不变', async () => {
    // 角色当前 identity 被再次修改为 '改后'，与 after_value '边城少年·新' 不符
    const charId = await seedCharacter(fixture.workId, { identity: '改后', personality: '坚韧·新' });
    const taskId = await seedTask(fixture.workId, charId);
    const { writebackId } = await seedWriteback(fixture.workId, charId, taskId, [
      { key: 'identity', before: '边城少年', after: '边城少年·新' }
    ]);

    const result = await service.revertField(fixture.authorId, fixture.workId, writebackId, 'identity');

    expect(result.conflict).toEqual({ field_key: 'identity', current_value: '改后', after_value: '边城少年·新' });
    expect(result.version).toBe(1);
    const character = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(character.identity).toBe('改后');
    expect(character.version).toBe(1);
  });

  it('重复撤销幂等：字段已 reverted → 返回当前状态，不再次恢复', async () => {
    const charId = await seedCharacter(fixture.workId, { identity: '边城少年', personality: '坚韧·新' });
    const taskId = await seedTask(fixture.workId, charId);
    const { writebackId } = await seedWriteback(fixture.workId, charId, taskId, [
      { key: 'identity', before: '边城少年', after: '边城少年·新', status: 'reverted' }
    ]);

    const result = await service.revertField(fixture.authorId, fixture.workId, writebackId, 'identity');
    expect(result.fieldStatus).toBe('reverted');
    expect(result.version).toBe(1); // 未再次 +1
    const character = await fixture.dataSource.getRepository(CharacterEntity).findOneByOrFail({ id: charId });
    expect(character.version).toBe(1);
  });

  it('字段行不存在 → COLLAB_FIELD_NOT_ALLOWED', async () => {
    const charId = await seedCharacter(fixture.workId, { identity: '边城少年·新' });
    const taskId = await seedTask(fixture.workId, charId);
    const { writebackId } = await seedWriteback(fixture.workId, charId, taskId, [
      { key: 'personality', before: '坚韧', after: '坚韧·新' }
    ]);
    await expect(service.revertField(fixture.authorId, fixture.workId, writebackId, 'identity'))
      .rejects.toMatchObject({ code: 'COLLAB_FIELD_NOT_ALLOWED' });
  });

  it('写回单不属于该作品 → 拒绝', async () => {
    const charId = await seedCharacter(fixture.workId, { identity: '边城少年·新' });
    const taskId = await seedTask(fixture.workId, charId);
    const { writebackId } = await seedWriteback(fixture.workId, charId, taskId, [
      { key: 'identity', before: '边城少年', after: '边城少年·新' }
    ]);
    await expect(service.revertField(fixture.authorId, '00000000-0000-0000-0000-000000000000', writebackId, 'identity'))
      .rejects.toMatchObject({ code: 'COLLAB_TEST_ROLE_MISMATCH' });
  });
});
