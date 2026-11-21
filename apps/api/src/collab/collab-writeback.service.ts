import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { CollabRoleField } from '@storyforge/contracts';
import { CharacterEntity } from '../database/character.entity';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { CollabUpstreamError } from './channel/collab-upstream.error';
import { COLLAB_WRITEBACK_PORT, type CollabWritebackPort, type WritebackRecord, type WritebackRecordInput } from './collab-writeback.port';

// F11 写回服务：实现写回端口，单事务完成「锁角色 → 复查 → 幂等 → 前后值 → 更新+版本 → 写单+字段行 → 写 outbox」（F2 §5.4）
// 只写配置白名单字段，不写正文与剧情树（F2 §1.1 第3条）
// 重复写回（同 task_id 已有写回单）幂等返回既有结果，不新增行（F2 §7.3）
// 任一校验失败抛错回滚整个事务，不产生部分写回（F2 §1.1 第6条）

@Injectable()
export class CollabWritebackService implements CollabWritebackPort {
  private readonly logger = new Logger(CollabWritebackService.name);

  async applyWriteback(manager: EntityManager, input: WritebackRecordInput): Promise<WritebackRecord> {
    // 幂等：同 task_id 已写回 → 直接返回既有结果（唯一约束兜底，见 §3.2.2）
    const existing = await manager.getRepository(RoleProfileWritebackEntity).findOneBy({ task_id: input.taskId });
    if (existing) {
      this.logger.log(`写回已存在 task=${input.taskId}，幂等返回 writeback=${existing.id}`);
      return { writebackId: existing.id, appliedVersion: existing.applied_version };
    }

    // 1) 锁角色行（SELECT ... FOR UPDATE），写回与撤销共用角色行乐观锁
    const character = await manager.getRepository(CharacterEntity).createQueryBuilder('c')
      .where('c.id = :id', { id: input.characterId })
      .setLock('pessimistic_write')
      .getOne();
    if (!character) {
      throw new CollabUpstreamError('写回角色不存在', false, 'COLLAB_TEST_ROLE_MISMATCH');
    }

    // 2) 复查协同配置：开启 + 该角色仍为测试角色（写回目标永远来自 DB 白名单，不信任模型字段名）
    const setting = await manager.getRepository(CollabSettingEntity).findOneBy({ work_id: input.workId });
    if (!setting || !setting.enabled) {
      throw new CollabUpstreamError('协同未启用，拒绝写回', false, 'COLLAB_DISABLED');
    }
    if (setting.test_character_id !== input.characterId) {
      throw new CollabUpstreamError('角色不再是配置的测试角色，拒绝写回', false, 'COLLAB_TEST_ROLE_MISMATCH');
    }
    const whitelist = new Set(setting.whitelist_fields);
    for (const field of Object.keys(input.fields) as CollabRoleField[]) {
      if (!whitelist.has(field)) {
        throw new CollabUpstreamError(`写回字段不在白名单: ${field}`, false, 'COLLAB_FIELD_NOT_ALLOWED');
      }
    }

    // 3) 记录 before_value（更新前快照，避免后续对象被修改）
    const beforeValues = new Map<CollabRoleField, unknown>();
    for (const field of Object.keys(input.fields) as CollabRoleField[]) {
      beforeValues.set(field, character[field]);
    }

    // 4) 一次性更新本次全部字段 + version+1
    const nextVersion = character.version + 1;
    for (const [field, value] of Object.entries(input.fields) as Array<[CollabRoleField, string]>) {
      character[field] = value;
    }
    character.version = nextVersion;
    await manager.save(character);

    // 5) 写写回单（status='applied'，applied_version 取新版本）
    const writeback = manager.getRepository(RoleProfileWritebackEntity).create({
      id: randomUUID(),
      task_id: input.taskId,
      work_id: input.workId,
      character_id: input.characterId,
      channel: input.channel,
      status: 'applied',
      applied_version: nextVersion,
      applied_by: input.appliedBy
    });
    await manager.save(writeback);

    // 6) 写字段行（前后值 + 撤销状态）
    const fieldRepo = manager.getRepository(RoleProfileWritebackFieldEntity);
    for (const [field, value] of Object.entries(input.fields) as Array<[CollabRoleField, string]>) {
      const row = fieldRepo.create({
        id: randomUUID(),
        writeback_id: writeback.id,
        field_key: field,
        before_value: beforeValues.get(field),
        after_value: value,
        status: 'applied'
      });
      await fieldRepo.save(row);
    }

    // 7) 写归档 outbox（payload 含结果、引用、字段前后值与通道；不含凭据/作者邮箱/其他角色/正文）
    const outbox = manager.getRepository(AgentArchiveOutboxEntity).create({
      id: randomUUID(),
      task_id: input.taskId,
      status: 'pending',
      attempts: 0,
      payload: {
        work_id: input.workId,
        character_id: input.characterId,
        channel: input.channel,
        result_text: input.resultText,
        fields: input.fields,
        citations: input.citations,
        applied_version: nextVersion
      }
    });
    await manager.save(outbox);

    return { writebackId: writeback.id, appliedVersion: nextVersion };
  }
}

// 供模块装配使用
export { COLLAB_WRITEBACK_PORT };
