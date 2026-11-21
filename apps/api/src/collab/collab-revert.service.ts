import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { CollabFieldConflict, CollabRoleField } from '@storyforge/contracts';
import { CharacterEntity } from '../database/character.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { WorkEntity } from '../database/work.entity';
import { CollabUpstreamError } from './channel/collab-upstream.error';

// F11 撤销服务：按字段撤销一次写回，恢复 before_value + 角色 version+1（F2 §1.1 第4条）
// 冲突语义：仅当「字段当前值 ≠ 写回后值」才判定冲突（其他字段变更不会推高本字段），
// 冲突返回 409 COLLAB_FIELD_CONFLICT 并保留当前值；重复撤销（字段已 reverted）幂等返回当前状态。
// 撤销与写回共用角色行乐观锁（pessimistic_write），保证并发写回/撤销互斥。

export interface RevertFieldResult {
  writebackId: string;
  writebackStatus: string;
  fieldKey: CollabRoleField;
  fieldStatus: string;
  /** 撤销成功时为恢复后的 before_value；冲突时为 null */
  restoredValue: unknown | null;
  /** 撤销成功时角色 version+1；冲突时保持原 version */
  version: number;
  /** 冲突信息（COLLAB_FIELD_CONFLICT 时返回当前值与写回后值） */
  conflict?: CollabFieldConflict;
}

@Injectable()
export class CollabRevertService {
  private readonly logger = new Logger(CollabRevertService.name);

  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async revertField(
    authorId: string,
    workId: string,
    writebackId: string,
    fieldKey: CollabRoleField,
    expectedValue?: unknown
  ): Promise<RevertFieldResult> {
    return this.dataSource.transaction(async (manager) => {
      // 0. 作品归属（撤销入口挂在作品下，防跨作品操作）
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
      if (!work || work.author_id !== authorId) {
        throw new CollabUpstreamError('作品不存在', false, 'COLLAB_TEST_ROLE_MISMATCH');
      }

      // 1. 写回单必须属于该作品
      const writeback = await manager.getRepository(RoleProfileWritebackEntity).findOneBy({ id: writebackId, work_id: workId });
      if (!writeback) {
        throw new CollabUpstreamError('写回单不存在', false, 'COLLAB_TEST_ROLE_MISMATCH');
      }

      // 2. 锁字段行
      const field = await manager.getRepository(RoleProfileWritebackFieldEntity).createQueryBuilder('f')
        .where('f.writeback_id = :writebackId AND f.field_key = :fieldKey', { writebackId, fieldKey })
        .setLock('pessimistic_write')
        .getOne();
      if (!field) {
        throw new CollabUpstreamError('字段行不存在', false, 'COLLAB_FIELD_NOT_ALLOWED');
      }

      // 3. 重复撤销幂等：字段已 reverted，返回当前状态（不重复恢复）
      if (field.status === 'reverted') {
        const writebackStatus = await this.computeWritebackStatus(manager, writebackId);
        return {
          writebackId,
          writebackStatus,
          fieldKey,
          fieldStatus: 'reverted',
          restoredValue: field.before_value,
          version: await this.currentVersion(manager, writeback.character_id)
        };
      }

      // 4. 锁角色行（乐观锁，与写回/撤销互斥）
      const character = await manager.getRepository(CharacterEntity).createQueryBuilder('c')
        .where('c.id = :id', { id: writeback.character_id })
        .setLock('pessimistic_write')
        .getOne();
      if (!character) {
        throw new CollabUpstreamError('角色不存在', false, 'COLLAB_TEST_ROLE_MISMATCH');
      }

      // 5. 值比对：客户端前置校验（可选）+ 库内 after_value 比对
      //    冲突判定：当前值 ≠ after_value（其他字段变更不会推高本字段，仅比版本会误伤）
      const currentValue = character[fieldKey];
      const afterValue = field.after_value;
      const conflict = currentValue !== afterValue;
      if (conflict) {
        this.logger.warn(`撤销冲突 field=${fieldKey} writeback=${writebackId}`);
        return {
          writebackId,
          writebackStatus: writeback.status,
          fieldKey,
          fieldStatus: 'applied',
          restoredValue: null,
          version: character.version,
          conflict: { field_key: fieldKey, current_value: currentValue, after_value: afterValue }
        };
      }

      // 6. 恢复 before_value + version+1
      const restored = field.before_value;
      character[fieldKey] = restored as never;
      character.version = character.version + 1;
      await manager.save(character);

      // 7. 置字段行 reverted
      field.status = 'reverted';
      field.reverted_at = new Date();
      field.reverted_by = authorId;
      await manager.save(field);

      // 8. 重算写回单状态
      const writebackStatus = await this.computeWritebackStatus(manager, writebackId);
      writeback.status = writebackStatus;
      await manager.save(writeback);

      return {
        writebackId,
        writebackStatus,
        fieldKey,
        fieldStatus: 'reverted',
        restoredValue: restored,
        version: character.version
      };
    });
  }

  /** 重算写回单状态：全字段 reverted → reverted；部分 → partially_reverted；否则 applied */
  private async computeWritebackStatus(
    manager: import('typeorm').EntityManager,
    writebackId: string
  ): Promise<string> {
    const rows = await manager.getRepository(RoleProfileWritebackFieldEntity).find({ where: { writeback_id: writebackId } });
    if (rows.length === 0) return 'applied';
    const revertedCount = rows.filter((r) => r.status === 'reverted').length;
    if (revertedCount === rows.length) return 'reverted';
    if (revertedCount > 0) return 'partially_reverted';
    return 'applied';
  }

  private async currentVersion(manager: import('typeorm').EntityManager, characterId: string): Promise<number> {
    const c = await manager.getRepository(CharacterEntity).findOneBy({ id: characterId });
    return c?.version ?? 0;
  }
}
