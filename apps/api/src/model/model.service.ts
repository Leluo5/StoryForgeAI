import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { CreateModelInput, UpdateModelInput, Model } from '@storyforge/contracts';
import { ModelEntity } from '../database/model.entity';

// ───────────────────────────── 实体 ↔ 契约映射 ─────────────────────────────

/**
 * 实体 → 契约模型。
 * input_price / output_price 为 numeric(12,4)，TypeORM 映射为 string，契约要求 number，用 Number() 转换。
 */
function toModel(entity: ModelEntity): Model {
  return {
    id: entity.id,
    author_id: entity.author_id,
    name: entity.name,
    provider: entity.provider as Model['provider'],
    model_id: entity.model_id,
    context_window: entity.context_window,
    supports_tools: entity.supports_tools,
    supports_vision: entity.supports_vision,
    input_price: Number(entity.input_price),
    output_price: Number(entity.output_price),
    currency: entity.currency,
    status: entity.status as Model['status'],
    sort_order: entity.sort_order,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

@Injectable()
export class ModelService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // ═══════════════════════════════════════════════════════════════════
  // 列表 / 详情
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 列出作者的全部模型：keyword（name ILIKE）+ status 过滤 + 分页。
   * 排序：sort_order ASC（小的在前），同权重按 created_at DESC。
   */
  async listModels(
    authorId: string,
    query: { keyword?: string; status?: string; page?: number; page_size?: number }
  ): Promise<{ models: Model[]; total: number; page: number; page_size: number }> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const qb = this.dataSource
      .getRepository(ModelEntity)
      .createQueryBuilder('m')
      .where('m.author_id = :authorId', { authorId });

    if (query.status) {
      qb.andWhere('m.status = :status', { status: query.status });
    }
    if (query.keyword) {
      qb.andWhere('m.name ILIKE :keyword', { keyword: `%${query.keyword}%` });
    }

    const [entities, total] = await qb
      .orderBy('m.sort_order', 'ASC')
      .addOrderBy('m.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return { models: entities.map(toModel), total, page, page_size: pageSize };
  }

  /**
   * 获取单个模型详情。
   */
  async getModel(authorId: string, modelId: string): Promise<Model> {
    const entity = await this.dataSource.getRepository(ModelEntity).findOneBy({
      id: modelId,
      author_id: authorId
    });
    if (!entity) throw new NotFoundException('模型不存在');
    return toModel(entity);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 创建 / 更新 / 删除
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 创建模型：同作者 model_id 唯一（预检查，避免撞唯一约束抛裸 QueryFailedError）。
   */
  async createModel(authorId: string, input: CreateModelInput): Promise<Model> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ModelEntity);
      // 同作者能力标识唯一：预检查
      const dup = await repo.findOneBy({ author_id: authorId, model_id: input.model_id });
      if (dup) throw new ConflictException({ message: '同模型标识已存在' });

      const entity = repo.create();
      entity.id = randomUUID();
      entity.author_id = authorId;
      entity.name = input.name;
      entity.provider = input.provider ?? 'other';
      entity.model_id = input.model_id;
      entity.context_window = input.context_window ?? 0;
      entity.supports_tools = input.supports_tools ?? false;
      entity.supports_vision = input.supports_vision ?? false;
      entity.input_price = String(input.input_price ?? 0);
      entity.output_price = String(input.output_price ?? 0);
      entity.currency = input.currency ?? 'USD';
      entity.status = input.status ?? 'active';
      entity.sort_order = input.sort_order ?? 0;

      await manager.save(entity);
      return toModel(entity);
    });
  }

  /**
   * 更新模型：白名单字段 + 同 model_id 预检查（排除自身）。
   * status 仅 active/disabled（契约已约束，无 archived）。
   */
  async updateModel(authorId: string, modelId: string, input: UpdateModelInput): Promise<Model> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ModelEntity);
      const entity = await repo.findOneBy({ id: modelId, author_id: authorId });
      if (!entity) throw new NotFoundException('模型不存在');

      if (input.model_id !== undefined) {
        if (input.model_id !== entity.model_id) {
          const dup = await repo.findOneBy({ author_id: authorId, model_id: input.model_id });
          if (dup && dup.id !== modelId) {
            throw new ConflictException({ message: '同模型标识已存在' });
          }
        }
        entity.model_id = input.model_id;
      }
      if (input.name !== undefined) entity.name = input.name;
      if (input.provider !== undefined) entity.provider = input.provider;
      if (input.context_window !== undefined) entity.context_window = input.context_window;
      if (input.supports_tools !== undefined) entity.supports_tools = input.supports_tools;
      if (input.supports_vision !== undefined) entity.supports_vision = input.supports_vision;
      if (input.input_price !== undefined) entity.input_price = String(input.input_price);
      if (input.output_price !== undefined) entity.output_price = String(input.output_price);
      if (input.currency !== undefined) entity.currency = input.currency;
      if (input.status !== undefined) entity.status = input.status;
      if (input.sort_order !== undefined) entity.sort_order = input.sort_order;

      await manager.save(entity);
      return toModel(entity);
    });
  }

  /**
   * 删除模型：直接硬删（静态目录资源，无归档/回滚，不校验引用）。
   */
  async deleteModel(authorId: string, modelId: string): Promise<{ deleted: true; id: string }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ModelEntity);
      const entity = await repo.findOneBy({ id: modelId, author_id: authorId });
      if (!entity) throw new NotFoundException('模型不存在');

      await repo.remove(entity);
      return { deleted: true, id: modelId };
    });
  }
}
