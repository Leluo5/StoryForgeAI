import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type {
  CollabSettings,
  PutCollabSettingsRequest
} from '@storyforge/contracts';
import { putCollabSettingsRequestSchema } from '@storyforge/contracts';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';
import { WorkEntity } from '../database/work.entity';

// F11 协同设置服务：一作品一份配置，校验归属与平台后 upsert
// F2 §4.2：作品归属、角色属于作品且 active、Agent 属于作者、平台 ∈ {flowise, coze}、白名单 2-3 项
@Injectable()
export class CollabService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /** 读取配置：未配置返回 null（前端据此区分未配置状态） */
  async getCollabSettings(authorId: string, workId: string): Promise<CollabSettings | null> {
    // 作品归属前置校验，保证跨作品不可读
    await this.assertWorkOwned(authorId, workId);
    const entity = await this.dataSource
      .getRepository(CollabSettingEntity)
      .findOneBy({ work_id: workId });
    if (!entity) return null;
    return this.toSettings(entity);
  }

  /** 保存配置：覆盖式写入（upsert，PK=work_id） */
  async putCollabSettings(
    authorId: string,
    workId: string,
    input: PutCollabSettingsRequest
  ): Promise<CollabSettings> {
    // zod 契约校验（白名单 2-3 项、字段合法）
    const parsed = putCollabSettingsRequestSchema.parse(input);

    return this.dataSource.transaction(async (manager) => {
      // 1. 作品归属
      await this.assertWorkOwnedIn(manager, authorId, workId);

      // 2. 角色属于该作品且 active
      const character = await manager.getRepository(CharacterEntity).findOneBy({
        id: parsed.test_character_id,
        work_id: workId
      });
      if (!character || character.status !== 'active') {
        throw new BadRequestException({
          code: 'COLLAB_TEST_ROLE_MISMATCH',
          message: '测试角色必须属于该作品且为 active'
        });
      }

      // 3. Agent 属于当前作者
      const agent = await manager.getRepository(AgentEntity).findOneBy({
        id: parsed.agent_id,
        author_id: authorId
      });
      if (!agent) {
        throw new NotFoundException({
          code: 'COLLAB_CHANNEL_NOT_CONFIGURED',
          message: '执行 Agent 不存在或不属于当前作者'
        });
      }

      // 4. 目标 Agent 平台必须是已配置的 flowise 或 coze（F2 §4.2）
      if (agent.platform !== 'flowise' && agent.platform !== 'coze') {
        throw new BadRequestException({
          code: 'COLLAB_CHANNEL_NOT_CONFIGURED',
          message: '执行 Agent 的 platform 必须是 flowise 或 coze'
        });
      }

      // 5. upsert（PK=work_id）
      const repo = manager.getRepository(CollabSettingEntity);
      let entity = await repo.findOneBy({ work_id: workId });
      if (!entity) {
        entity = repo.create({ work_id: workId });
      }
      entity.test_character_id = parsed.test_character_id;
      entity.agent_id = parsed.agent_id;
      entity.whitelist_fields = parsed.whitelist_fields;
      entity.enabled = parsed.enabled;
      try {
        entity = await repo.save(entity);
      } catch (err) {
        // 并发撞主键 → 重读后覆盖（幂等 upsert）
        const existing = await repo.findOneBy({ work_id: workId });
        if (existing) {
          existing.test_character_id = parsed.test_character_id;
          existing.agent_id = parsed.agent_id;
          existing.whitelist_fields = parsed.whitelist_fields;
          existing.enabled = parsed.enabled;
          entity = await repo.save(existing);
        } else {
          throw err;
        }
      }
      return this.toSettings(entity);
    });
  }

  private toSettings(entity: CollabSettingEntity): CollabSettings {
    return {
      work_id: entity.work_id,
      test_character_id: entity.test_character_id,
      agent_id: entity.agent_id,
      whitelist_fields: entity.whitelist_fields as CollabSettings['whitelist_fields'],
      enabled: entity.enabled,
      created_at: entity.created_at.toISOString(),
      updated_at: entity.updated_at.toISOString()
    };
  }

  private async assertWorkOwned(authorId: string, workId: string): Promise<void> {
    const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId });
    if (!work || work.author_id !== authorId) {
      // work 不存在或非作者 → 统一 404，不泄露资源存在性
      throw new NotFoundException({ code: 'WORK_NOT_FOUND', message: '作品不存在' });
    }
  }

  private async assertWorkOwnedIn(
    manager: EntityManager,
    authorId: string,
    workId: string
  ): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
    if (!work || work.author_id !== authorId) {
      throw new NotFoundException({ code: 'WORK_NOT_FOUND', message: '作品不存在' });
    }
  }
}
