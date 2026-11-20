import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource, In } from 'typeorm';
import { CharacterEntity } from '../database/character.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import { CharacterViewEntity } from '../database/character-view.entity';
import { CharacterViewNodeEntity } from '../database/character-view-node.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';

export interface BoardResult {
  view: CharacterViewEntity;
  members: CharacterEntity[];
  relations: CharacterRelationEntity[];
  relation_types: CharacterRelationTypeEntity[];
  /** 视图成员行（含未排布成员与 sort_index），供 board 响应组装 layout */
  nodes: CharacterViewNodeEntity[];
  layouts: Map<string, { x: number; y: number }>;
  layout_ignored: number;
}

export interface ViewCreateInput {
  name: string;
  filters?: Record<string, unknown> | null;
  auto_add_active?: boolean;
}

export interface ViewUpdateInput {
  name?: string;
  filters?: Record<string, unknown> | null;
  version?: number;
}

export interface LayoutUpsertInput {
  character_id: string;
  x: number;
  y: number;
  arranged?: boolean;
  sort_index?: number;
}

// F2 §2.2.5、§2.2.6、§4.3、§5.2 视图与布局服务
// - 每作品一张默认视图（代码层创建时自动建立；DB 部分唯一索引兜底）
// - 默认视图不可删除（409）
// - board 单次查询拉满：无 N+1
// - 布局 upsert 幂等；未知成员输入忽略并返回计数；不推进版本
@Injectable()
export class CharacterViewService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  private async assertViewOwned(manager: EntityManager, viewId: string, workId: string): Promise<CharacterViewEntity> {
    const v = await manager.getRepository(CharacterViewEntity).findOneBy({ id: viewId, work_id: workId });
    if (!v) throw new NotFoundException('视图不存在');
    return v;
  }

  // ──────────────────── 确保默认视图存在 ────────────────────

  private async ensureDefaultView(manager: EntityManager, workId: string): Promise<CharacterViewEntity> {
    const repo = manager.getRepository(CharacterViewEntity);
    let def = await repo.findOneBy({ work_id: workId, is_default: true });
    if (def) return def;
    def = await repo.save(
      repo.create({
        id: randomUUID(),
        work_id: workId,
        name: '默认视图',
        is_default: true,
        filters: {},
        version: 1,
        sort_order: 0
      })
    );
    return def;
  }

  // ──────────────────── 1. 列表 ────────────────────

  async list(authorId: string, workId: string): Promise<CharacterViewEntity[]> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      await this.ensureDefaultView(manager, workId);
    });
    return this.dataSource
      .getRepository(CharacterViewEntity)
      .find({ where: { work_id: workId }, order: { is_default: 'DESC', sort_order: 'ASC', created_at: 'ASC' } });
  }

  // ──────────────────── 2. 创建 ────────────────────

  async create(
    authorId: string,
    workId: string,
    input: ViewCreateInput
  ): Promise<CharacterViewEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      await this.ensureDefaultView(manager, workId);

      const viewRepo = manager.getRepository(CharacterViewEntity);
      const saved = await viewRepo.save(
        viewRepo.create({
          id: randomUUID(),
          work_id: workId,
          name: input.name.trim() || '未命名视图',
          is_default: false,
          filters: input.filters ?? {},
          version: 1,
          sort_order: 100
        })
      );

      // 默认加入全部 active 角色
      if (input.auto_add_active !== false) {
        const chars = await manager
          .getRepository(CharacterEntity)
          .find({ where: { work_id: workId, status: 'active' } });
        if (chars.length) {
          const nodes = chars.map((c, idx) =>
            manager.getRepository(CharacterViewNodeEntity).create({
              id: randomUUID(),
              view_id: saved.id,
              character_id: c.id,
              x: null,
              y: null,
              arranged: false,
              sort_index: idx
            })
          );
          await manager.getRepository(CharacterViewNodeEntity).save(nodes);
        }
      }

      await this.audit.record(
        authorId, 'character_view_create', 'character_view', saved.id,
        { name: saved.name, auto_add_active: input.auto_add_active !== false },
        workId, manager
      );
      return saved;
    });
  }

  // ──────────────────── 3. 更新 ────────────────────

  async update(
    authorId: string,
    workId: string,
    viewId: string,
    input: ViewUpdateInput
  ): Promise<CharacterViewEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const view = await this.assertViewOwned(manager, viewId, workId);

      if (input.version !== undefined && input.version !== view.version) {
        throw new ConflictException({
          code: 'VIEW_VERSION_CONFLICT',
          message: `版本冲突：预期 ${input.version}，实际 ${view.version}`
        });
      }
      if (input.name !== undefined && input.name.trim()) view.name = input.name.trim();
      if (input.filters !== undefined) view.filters = input.filters ?? {};
      view.version = view.version + 1;

      const saved = await manager.getRepository(CharacterViewEntity).save(view);
      await this.audit.record(
        authorId, 'character_view_update', 'character_view', saved.id,
        { name: saved.name, version: saved.version }, workId, manager
      );
      return saved;
    });
  }

  // ──────────────────── 4. 删除 ────────────────────

  async delete(authorId: string, workId: string, viewId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const view = await this.assertViewOwned(manager, viewId, workId);
      if (view.is_default) {
        throw new ConflictException({ code: 'VIEW_DEFAULT_UNDELETABLE', message: '默认视图不可删除' });
      }
      await manager.getRepository(CharacterViewNodeEntity).delete({ view_id: viewId });
      await manager.getRepository(CharacterViewEntity).delete({ id: viewId });
      await this.audit.record(
        authorId, 'character_view_delete', 'character_view', viewId,
        { name: view.name }, workId, manager
      );
    });
  }

  // ──────────────────── 5. 成员：add / remove ────────────────────

  async addMember(
    authorId: string,
    workId: string,
    viewId: string,
    characterIds: string[]
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const view = await this.assertViewOwned(manager, viewId, workId);
      const charRepo = manager.getRepository(CharacterEntity);
      const nodeRepo = manager.getRepository(CharacterViewNodeEntity);

      const added: string[] = [];
      for (const cid of characterIds) {
        const char = await charRepo.findOneBy({ id: cid, work_id: workId });
        if (!char) continue;
        const existing = await nodeRepo.findOneBy({ view_id: viewId, character_id: cid });
        if (existing) continue;
        await nodeRepo.save(
          nodeRepo.create({
            id: randomUUID(),
            view_id: viewId,
            character_id: cid,
            x: null,
            y: null,
            arranged: false,
            sort_index: 0
          })
        );
        added.push(cid);
      }
      await this.audit.record(
        authorId, 'character_view_add_member', 'character_view', view.id,
        { added_count: added.length, view_id: view.id }, workId, manager
      );
      return added.length;
    });
  }

  async removeMember(
    authorId: string,
    workId: string,
    viewId: string,
    characterIds: string[]
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const view = await this.assertViewOwned(manager, viewId, workId);
      const nodeRepo = manager.getRepository(CharacterViewNodeEntity);
      const result = await nodeRepo
        .createQueryBuilder()
        .delete()
        .where('view_id = :viewId AND character_id IN (:...ids)', { viewId, ids: characterIds })
        .execute();
      const removed = result.affected ?? 0;
      if (removed > 0) {
        await this.audit.record(
          authorId, 'character_view_remove_member', 'character_view', view.id,
          { removed_count: removed }, workId, manager
        );
      }
      return removed;
    });
  }

  // ──────────────────── 6. 布局 upsert ────────────────────

  async upsertLayout(
    authorId: string,
    workId: string,
    viewId: string,
    layouts: LayoutUpsertInput[]
  ): Promise<{ updated: number; ignored: number }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const view = await this.assertViewOwned(manager, viewId, workId);
      const nodeRepo = manager.getRepository(CharacterViewNodeEntity);

      const updatedChars = new Set<string>();
      for (const it of layouts) updatedChars.add(it.character_id);
      const existingNodes = await nodeRepo.find({
        where: { view_id: viewId, character_id: In([...updatedChars]) }
      });
      const nodeMap = new Map(existingNodes.map((n) => [n.character_id, n]));

      let updated = 0;
      let ignored = 0;
      for (const it of layouts) {
        const node = nodeMap.get(it.character_id);
        if (!node) {
          ignored++;
          continue;
        }
        node.x = it.x;
        node.y = it.y;
        node.arranged = it.arranged ?? true;
        if (it.sort_index !== undefined) node.sort_index = it.sort_index;
        await nodeRepo.save(node);
        updated++;
      }
      // 重要：布局 upsert 不推进 view.version
      await this.audit.record(
        authorId, 'character_view_layout_upsert', 'character_view', view.id,
        { updated, ignored }, workId, manager
      );
      return { updated, ignored };
    });
  }

  // ──────────────────── 7. Board 单次读全 ────────────────────

  async getBoard(
    authorId: string,
    workId: string,
    viewId: string,
    options: { include_archived?: boolean } = {}
  ): Promise<BoardResult> {
    const includeArchived = options.include_archived === true;
    const manager = this.dataSource.manager;

    await this.assertOwnedWork(manager, authorId, workId);
    const view = await this.assertViewOwned(manager, viewId, workId);

    // 单次查询拉满：nodes + characters + relations + relation_types
    const [nodes, chars, rels, types] = await Promise.all([
      manager.getRepository(CharacterViewNodeEntity).find({ where: { view_id: viewId } }),
      manager.getRepository(CharacterEntity).find({
        where: includeArchived
          ? { work_id: workId }
          : { work_id: workId, status: 'active' }
      }),
      manager.getRepository(CharacterRelationEntity).find({ where: { work_id: workId } }),
      manager.getRepository(CharacterRelationTypeEntity).find({ where: { work_id: workId } })
    ]);

    const memberIds = new Set(nodes.map((n) => n.character_id));
    const members = chars.filter((c) => memberIds.has(c.id));

    const layouts = new Map<string, { x: number; y: number }>();
    let layoutIgnored = 0;
    for (const c of chars) {
      if (!memberIds.has(c.id)) {
        // 未加入视图的角色不计数
        continue;
      }
    }
    for (const n of nodes) {
      const hasChar = chars.some((c) => c.id === n.character_id);
      if (!hasChar) {
        layoutIgnored++;
        continue;
      }
      if (n.x !== null && n.y !== null) {
        layouts.set(n.character_id, { x: n.x, y: n.y });
      }
    }

    // 过滤出只涉及本 board 成员的关系
    const memberIdSet = new Set(members.map((m) => m.id));
    const relations = rels.filter((r) => memberIdSet.has(r.source_id) && memberIdSet.has(r.target_id));

    return {
      view,
      members,
      relations,
      relation_types: types,
      nodes,
      layouts,
      layout_ignored: layoutIgnored
    };
  }
}
