import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { CharacterEntity } from '../database/character.entity';
import { CharacterAvatarAssetEntity } from '../database/character-avatar-asset.entity';
import type { AvatarMime } from '../database/character-enums';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';
import {
  CharacterAvatarModelProvider,
  type AvatarProviderOutput
} from './character-model.provider';

const ALLOWED_MIMES: readonly AvatarMime[] = ['image/svg+xml', 'image/png'];
const MAX_BYTE_SIZE = 1 * 1024 * 1024; // 1 MB
const AVATAR_STORAGE_DIR = process.env.STORYFORGE_AVATAR_DIR ?? 'data/character-avatars';

// F2 §2.2.8、§4.5、§5.6、§11.2 头像资产生命周期
// pending → active，旧 active superseded；失败不清除旧 active
// 幂等：同一 task_id 重复调用返回既有 asset
@Injectable()
export class CharacterAvatarService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CharacterAvatarModelProvider) private readonly provider: CharacterAvatarModelProvider
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  async list(authorId: string, workId: string, characterId: string): Promise<CharacterAvatarAssetEntity[]> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      await manager.getRepository(CharacterEntity).findOneByOrFail({ id: characterId, work_id: workId });
    });
    return this.dataSource
      .getRepository(CharacterAvatarAssetEntity)
      .find({ where: { character_id: characterId }, order: { created_at: 'DESC' } });
  }

  /**
   * 生成头像：
   *  - 按 task_id 幂等查重（如果传入）
   *  - Provider 输出校验：mime 白名单 ≤ 1MB
   *  - 哈希命名落盘
   *  - 落库 status=pending
   */
  async generate(
    authorId: string,
    workId: string,
    characterId: string,
    options: { task_id?: string; prompt_hint?: string; mime?: AvatarMime } = {}
  ): Promise<CharacterAvatarAssetEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const char = await manager.getRepository(CharacterEntity).findOneBy({ id: characterId, work_id: workId });
      if (!char) throw new NotFoundException('角色不存在');

      if (options.task_id) {
        const existing = await manager
          .getRepository(CharacterAvatarAssetEntity)
          .findOneBy({ task_id: options.task_id });
        if (existing) return existing;
      }

      // Provider 输出
      const promptArgs: { seed: string; character_name: string; prompt_hint?: string } = {
        seed: options.task_id ?? randomUUID(),
        character_name: char.name
      };
      if (options.prompt_hint) promptArgs.prompt_hint = options.prompt_hint;
      const output: AvatarProviderOutput = await this.provider.generate(
        promptArgs,
        options.mime ? { mime: options.mime } : undefined
      );

      if (!ALLOWED_MIMES.includes(output.mime)) {
        throw new Error(`Provider 输出 mime 非白名单: ${output.mime}`);
      }
      const bytes = Buffer.from(output.data, output.mime === 'image/svg+xml' ? 'utf8' : 'base64');
      if (bytes.byteLength > MAX_BYTE_SIZE) {
        throw new Error(`Provider 输出超 1MB: ${bytes.byteLength}`);
      }
      const contentHash = createHash('sha256').update(bytes).digest('hex');

      const taskId = options.task_id ?? randomUUID();
      const fileName = `${contentHash}.${output.mime === 'image/svg+xml' ? 'svg' : 'png'}`;
      const storagePath = `${AVATAR_STORAGE_DIR}/${workId}/${characterId}/${fileName}`;

      // 真正落盘：目录可能不存在，先 mkdir -p 再写字节
      await mkdir(dirname(storagePath), { recursive: true });
      await writeFile(storagePath, bytes);

      const repo = manager.getRepository(CharacterAvatarAssetEntity);
      const saved = await repo.save(
        repo.create({
          id: randomUUID(),
          work_id: workId,
          character_id: characterId,
          status: 'pending',
          storage_kind: 'file',
          storage_path: storagePath,
          mime: output.mime,
          byte_size: bytes.byteLength,
          width: output.width,
          height: output.height,
          content_hash: contentHash,
          task_id: taskId,
          error: null
        })
      );
      await this.audit.record(
        authorId,
        'avatar_generate',
        'character_avatar',
        saved.id,
        { character_id: characterId, mime: output.mime, content_hash: contentHash.slice(0, 16) },
        workId,
        manager
      );
      return saved;
    });
  }

  /**
   * 采用头像：单事务内 pending → active，同角色其他 active → superseded。
   * 失败场景由 generate 内部处理；这里只处理合法状态迁移。
   */
  async adopt(authorId: string, workId: string, assetId: string): Promise<CharacterAvatarAssetEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterAvatarAssetEntity);
      const asset = await repo.findOneBy({ id: assetId, work_id: workId });
      if (!asset) throw new NotFoundException('头像资产不存在');
      if (asset.status !== 'pending') {
        throw new Error(`资产状态 ${asset.status} 不可 adopt`);
      }
      // 旧 active → superseded
      await repo
        .createQueryBuilder()
        .update({ status: 'superseded' })
        .where('character_id = :charId AND work_id = :workId AND status = :active', {
          charId: asset.character_id,
          workId,
          active: 'active'
        })
        .execute();
      asset.status = 'active';
      const saved = await repo.save(asset);
      // 同步回 character.avatar_asset_id（可选，不影响核心状态机）
      await manager
        .getRepository(CharacterEntity)
        .update({ id: asset.character_id }, { avatar_asset_id: saved.id });
      await this.audit.record(
        authorId,
        'avatar_adopt',
        'character_avatar',
        saved.id,
        { character_id: asset.character_id },
        workId,
        manager
      );
      return saved;
    });
  }

  /** 当前头像视图：active 单张 + pending 列表（旧 superseded/failed 不外露） */
  async getCurrent(
    authorId: string,
    workId: string,
    characterId: string
  ): Promise<{ active: CharacterAvatarAssetEntity | null; pending: CharacterAvatarAssetEntity[] }> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const character = await manager
        .getRepository(CharacterEntity)
        .findOneBy({ id: characterId, work_id: workId });
      if (!character) throw new NotFoundException('角色不存在');
    });
    const repo = this.dataSource.getRepository(CharacterAvatarAssetEntity);
    const active = await repo.findOne({
      where: { work_id: workId, character_id: characterId, status: 'active' },
      order: { created_at: 'DESC' }
    });
    const pending = await repo.find({
      where: { work_id: workId, character_id: characterId, status: 'pending' },
      order: { created_at: 'DESC' }
    });
    return { active, pending };
  }

  /** 读取头像字节：默认 active，指定 asset_id 时校验归属；文件缺失 404 */
  async getContent(
    authorId: string,
    workId: string,
    characterId: string,
    assetId?: string
  ): Promise<{
    buffer: Buffer;
    mime: AvatarMime;
    content_hash: string;
    asset: CharacterAvatarAssetEntity;
  }> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const character = await manager
        .getRepository(CharacterEntity)
        .findOneBy({ id: characterId, work_id: workId });
      if (!character) throw new NotFoundException('角色不存在');
    });
    const repo = this.dataSource.getRepository(CharacterAvatarAssetEntity);
    const asset = assetId
      ? await repo.findOneBy({ id: assetId, work_id: workId, character_id: characterId })
      : await repo.findOne({
          where: { work_id: workId, character_id: characterId, status: 'active' },
          order: { created_at: 'DESC' }
        });
    if (!asset || !asset.storage_path) throw new NotFoundException('头像资产不存在');
    try {
      const buffer = await readFile(asset.storage_path);
      return { buffer, mime: asset.mime, content_hash: asset.content_hash, asset };
    } catch {
      throw new NotFoundException('头像文件缺失');
    }
  }

  /** 失败标记：保留旧 active，不做迁移 */
  async markFailed(authorId: string, workId: string, assetId: string, error: Record<string, unknown>): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterAvatarAssetEntity);
      const asset = await repo.findOneBy({ id: assetId, work_id: workId });
      if (!asset) throw new NotFoundException('头像资产不存在');
      asset.status = 'failed';
      asset.error = error;
      await repo.save(asset);
      await this.audit.record(
        authorId,
        'avatar_fail',
        'character_avatar',
        assetId,
        { character_id: asset.character_id, reason: String(error?.message ?? error) },
        workId,
        manager
      );
    });
  }
}
