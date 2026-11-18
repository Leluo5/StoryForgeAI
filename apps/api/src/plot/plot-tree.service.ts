import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager, QueryDeepPartialEntity } from 'typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import {
  type PlotGroup,
  type PlotLink,
  type PlotNode,
  type PlotTree,
  type PlotTreeResponse,
  type PlotNodeAttributes
} from '@storyforge/contracts';
import { WorkEntity } from '../database/work.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotLinkEntity } from '../database/plot-link.entity';
import { PlotGroupEntity } from '../database/plot-group.entity';
import { AuditService } from '../revision/audit.service';
import { assertLinearAcyclic, assertParentAcyclic } from './plot-cycle';
import { PlotImportError, validateImportPayload } from './plot-import';

export interface CreateTreeInput {
  title?: string | undefined;
}

export interface UpdateTreeInput {
  title: string;
  expected_version?: number | undefined;
}

export interface CreateNodeInput {
  title: string;
  summary?: string | null | undefined;
  content?: string | undefined;
  attributes?: PlotNodeAttributes | undefined;
  position: { x: number; y: number };
  parent_id?: string | null | undefined;
  sibling_order?: number | undefined;
  group_id?: string | null | undefined;
  origin?: string | undefined;
  expected_version?: number | undefined;
}

export interface UpdateNodeInput {
  title?: string | undefined;
  summary?: string | null | undefined;
  content?: string | undefined;
  attributes?: PlotNodeAttributes | undefined;
  expected_version?: number | undefined;
}

export interface MoveNodeInput {
  parent_id: string | null;
  sibling_order?: number | undefined;
  expected_version?: number | undefined;
}

export interface AssignGroupInput {
  group_id: string | null;
  expected_version?: number | undefined;
}

export interface PositionsInput {
  positions: Array<{ node_id: string; x: number; y: number }>;
}

export interface CreateLinkInput {
  source_id: string;
  target_id: string;
  type: 'linear' | 'non_linear';
  label?: string | null | undefined;
  expected_version?: number | undefined;
}

export interface CreateGroupInput {
  name: string;
  kind: 'group' | 'swimlane';
  order_index?: number | undefined;
  expected_version?: number | undefined;
}

export interface UpdateGroupInput {
  name?: string | undefined;
  order_index?: number | undefined;
  expected_version?: number | undefined;
}

// 导入导出结构（schema_version=1）。导入时 id 全部重建，只用于表达引用关系
export interface ExportPlotNode {
  id?: string | undefined;
  parent_id?: string | null | undefined;
  sibling_order: number;
  title: string;
  summary?: string | null | undefined;
  content: string;
  attributes: PlotNodeAttributes;
  position: { x: number; y: number };
  group_id?: string | null | undefined;
  origin: PlotNode['origin'];
}

export interface ExportPlotLink {
  source_id: string;
  target_id: string;
  type: PlotLink['type'];
  label?: string | null | undefined;
}

export interface ExportPlotGroup {
  id?: string | undefined;
  name: string;
  kind: PlotGroup['kind'];
  order_index?: number | undefined;
}

export interface ExportPlotTree {
  schema_version: 1;
  exported_at?: string | undefined;
  tree: { title: string };
  nodes: ExportPlotNode[];
  links: ExportPlotLink[];
  groups: ExportPlotGroup[];
}

function mapTree(entity: PlotTreeEntity): PlotTree {
  return {
    id: entity.id,
    work_id: entity.work_id,
    title: entity.title,
    source: entity.source as PlotTree['source'],
    schema_version: entity.schema_version,
    version: entity.version,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

function mapNode(entity: PlotNodeEntity): PlotNode {
  return {
    id: entity.id,
    tree_id: entity.tree_id,
    parent_id: entity.parent_id,
    sibling_order: entity.sibling_order,
    title: entity.title,
    summary: entity.summary,
    content: entity.content,
    attributes: entity.attributes as PlotNodeAttributes,
    position: { x: entity.position_x, y: entity.position_y },
    group_id: entity.group_id,
    origin: entity.origin as PlotNode['origin'],
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

function mapLink(entity: PlotLinkEntity): PlotLink {
  return {
    id: entity.id,
    tree_id: entity.tree_id,
    source_id: entity.source_id,
    target_id: entity.target_id,
    type: entity.type,
    label: entity.label,
    created_at: entity.created_at.toISOString()
  };
}

function mapGroup(entity: PlotGroupEntity): PlotGroup {
  return {
    id: entity.id,
    tree_id: entity.tree_id,
    name: entity.name,
    kind: entity.kind as PlotGroup['kind'],
    order_index: entity.order_index,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === '23505';
}

@Injectable()
export class PlotTreeService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  /** 校验作品归属；不存在或不属于当前作者一律 404，避免泄露存在性 */
  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  private async findTree(manager: EntityManager, workId: string): Promise<PlotTreeEntity | null> {
    return manager.getRepository(PlotTreeEntity).findOneBy({ work_id: workId });
  }

  private async requireTree(manager: EntityManager, workId: string): Promise<PlotTreeEntity> {
    const tree = await this.findTree(manager, workId);
    if (!tree) throw new NotFoundException('剧情树不存在');
    return tree;
  }

  /** 结构写操作：作品归属 + 树行锁 + 乐观版本校验 */
  private async withLockedTree<T>(
    authorId: string,
    workId: string,
    expectedVersion: number | undefined,
    handler: (manager: EntityManager, tree: PlotTreeEntity) => Promise<T>
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const tree = await manager
        .getRepository(PlotTreeEntity)
        .createQueryBuilder('t')
        .setLock('pessimistic_write')
        .where('t.work_id = :workId', { workId })
        .getOne();
      if (!tree) throw new NotFoundException('剧情树不存在');
      if (expectedVersion !== undefined && expectedVersion !== tree.version) {
        throw new ConflictException({ code: 'PLOT_VERSION_CONFLICT', current_version: tree.version });
      }
      return handler(manager, tree);
    });
  }

  /** 结构变更推进版本号，返回新版本 */
  private async bumpVersion(manager: EntityManager, tree: PlotTreeEntity): Promise<number> {
    const next = tree.version + 1;
    await manager.getRepository(PlotTreeEntity).update({ id: tree.id }, { version: next, updated_at: new Date() });
    tree.version = next;
    return next;
  }

  private async requireNode(manager: EntityManager, treeId: string, nodeId: string): Promise<PlotNodeEntity> {
    const node = await manager.getRepository(PlotNodeEntity).findOneBy({ id: nodeId, tree_id: treeId });
    if (!node) throw new NotFoundException('剧情节点不存在');
    return node;
  }

  private async nextSiblingOrder(
    manager: EntityManager,
    treeId: string,
    parentId: string | null
  ): Promise<number> {
    const qb = manager
      .getRepository(PlotNodeEntity)
      .createQueryBuilder('n')
      .select('COALESCE(MAX(n.sibling_order), -1)', 'max')
      .where('n.tree_id = :treeId', { treeId });
    if (parentId) qb.andWhere('n.parent_id = :parentId', { parentId });
    else qb.andWhere('n.parent_id IS NULL');
    const row = await qb.getRawOne<{ max: string | null }>();
    return Number(row?.max ?? -1) + 1;
  }

  async getTree(authorId: string, workId: string): Promise<PlotTreeResponse> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    const tree = await this.findTree(this.dataSource.manager, workId);
    if (!tree) return { tree: null, nodes: [], links: [], groups: [] };
    const [nodes, links, groups] = await Promise.all([
      this.dataSource.getRepository(PlotNodeEntity).find({
        where: { tree_id: tree.id },
        order: { sibling_order: 'ASC', created_at: 'ASC' }
      }),
      this.dataSource.getRepository(PlotLinkEntity).find({ where: { tree_id: tree.id } }),
      this.dataSource.getRepository(PlotGroupEntity).find({
        where: { tree_id: tree.id },
        order: { order_index: 'ASC', created_at: 'ASC' }
      })
    ]);
    return {
      tree: mapTree(tree),
      nodes: nodes.map(mapNode),
      links: links.map(mapLink),
      groups: groups.map(mapGroup)
    };
  }

  async createTree(authorId: string, workId: string, input: CreateTreeInput): Promise<PlotTreeResponse> {
    const created = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const existing = await this.findTree(manager, workId);
      if (existing) throw new ConflictException({ code: 'PLOT_TREE_EXISTS' });
      const repository = manager.getRepository(PlotTreeEntity);
      const entity = repository.create({
        id: randomUUID(),
        work_id: workId,
        title: input.title?.trim() || '主线剧情',
        source: 'manual',
        schema_version: 1,
        version: 1
      });
      return repository.save(entity);
    });
    await this.audit.record(authorId, 'plot_tree_create', 'plot_tree', created.id, { title: created.title }, workId);
    return this.getTree(authorId, workId);
  }

  async updateTree(authorId: string, workId: string, input: UpdateTreeInput): Promise<PlotTreeResponse> {
    await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      await manager.getRepository(PlotTreeEntity).update({ id: tree.id }, { title: input.title, updated_at: new Date() });
      await this.bumpVersion(manager, tree);
    });
    await this.audit.record(authorId, 'plot_tree_update', 'plot_tree', null, { title: input.title }, workId);
    return this.getTree(authorId, workId);
  }

  async createNode(authorId: string, workId: string, input: CreateNodeInput): Promise<{ node: PlotNode; version: number }> {
    const result = await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      let parentId = input.parent_id ?? null;
      if (parentId) {
        const parent = await manager.getRepository(PlotNodeEntity).findOneBy({ id: parentId, tree_id: tree.id });
        if (!parent) throw new NotFoundException('父节点不存在');
      }
      if (input.group_id) {
        const group = await manager.getRepository(PlotGroupEntity).findOneBy({ id: input.group_id, tree_id: tree.id });
        if (!group) throw new NotFoundException('分组不存在');
      }
      const siblingOrder =
        input.sibling_order ?? (await this.nextSiblingOrder(manager, tree.id, parentId));
      const repository = manager.getRepository(PlotNodeEntity);
      const entity = repository.create({
        id: randomUUID(),
        tree_id: tree.id,
        parent_id: parentId,
        sibling_order: siblingOrder,
        title: input.title,
        summary: input.summary ?? null,
        content: input.content ?? '',
        attributes: input.attributes ?? {},
        position_x: input.position.x,
        position_y: input.position.y,
        group_id: input.group_id ?? null,
        origin: input.origin ?? 'manual'
      });
      const saved = await repository.save(entity);
      const version = await this.bumpVersion(manager, tree);
      return { node: mapNode(saved), version };
    });
    await this.audit.record(authorId, 'plot_node_create', 'plot_node', result.node.id, { title: result.node.title }, workId);
    return result;
  }

  async updateNode(
    authorId: string,
    workId: string,
    nodeId: string,
    input: UpdateNodeInput
  ): Promise<{ node: PlotNode; version: number }> {
    const result = await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      await this.requireNode(manager, tree.id, nodeId);
      const patch: QueryDeepPartialEntity<PlotNodeEntity> = { updated_at: new Date() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.summary !== undefined) patch.summary = input.summary;
      if (input.content !== undefined) patch.content = input.content;
      if (input.attributes !== undefined) {
        patch.attributes = input.attributes as NonNullable<QueryDeepPartialEntity<PlotNodeEntity>['attributes']>;
      }
      const repository = manager.getRepository(PlotNodeEntity);
      await repository.update({ id: nodeId, tree_id: tree.id }, patch);
      const saved = await repository.findOneByOrFail({ id: nodeId });
      const version = await this.bumpVersion(manager, tree);
      return { node: mapNode(saved), version };
    });
    await this.audit.record(authorId, 'plot_node_update', 'plot_node', nodeId, {}, workId);
    return result;
  }

  async moveNode(
    authorId: string,
    workId: string,
    nodeId: string,
    input: MoveNodeInput
  ): Promise<{ node: PlotNode; version: number }> {
    const result = await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      const node = await this.requireNode(manager, tree.id, nodeId);
      let parentId = input.parent_id ?? null;
      if (parentId) {
        const parent = await manager.getRepository(PlotNodeEntity).findOneBy({ id: parentId, tree_id: tree.id });
        if (!parent) throw new NotFoundException('父节点不存在');
        const all = await manager.getRepository(PlotNodeEntity).find({ where: { tree_id: tree.id } });
        try {
          assertParentAcyclic(all, nodeId, parentId);
        } catch {
          throw new ConflictException({ code: 'PLOT_PARENT_CYCLE' });
        }
      }
      const siblingOrder =
        input.sibling_order ?? (await this.nextSiblingOrder(manager, tree.id, parentId));
      const repository = manager.getRepository(PlotNodeEntity);
      await repository.update(
        { id: node.id, tree_id: tree.id },
        { parent_id: parentId, sibling_order: siblingOrder, updated_at: new Date() }
      );
      const saved = await repository.findOneByOrFail({ id: node.id });
      const version = await this.bumpVersion(manager, tree);
      return { node: mapNode(saved), version };
    });
    await this.audit.record(authorId, 'plot_node_move', 'plot_node', nodeId, { parent_id: input.parent_id }, workId);
    return result;
  }

  async deleteNode(
    authorId: string,
    workId: string,
    nodeId: string,
    expectedVersion?: number
  ): Promise<{ deleted: number; version: number }> {
    const result = await this.withLockedTree(authorId, workId, expectedVersion, async (manager, tree) => {
      await this.requireNode(manager, tree.id, nodeId);
      const all = await manager.getRepository(PlotNodeEntity).find({ where: { tree_id: tree.id } });
      const children = new Map<string | null, string[]>();
      for (const node of all) {
        const list = children.get(node.parent_id) ?? [];
        list.push(node.id);
        children.set(node.parent_id, list);
      }
      let deleted = 0;
      const stack = [nodeId];
      while (stack.length > 0) {
        const current = stack.pop()!;
        deleted += 1;
        stack.push(...(children.get(current) ?? []));
      }
      await manager.getRepository(PlotNodeEntity).delete({ id: nodeId, tree_id: tree.id });
      const version = await this.bumpVersion(manager, tree);
      return { deleted, version };
    });
    await this.audit.record(authorId, 'plot_node_delete', 'plot_node', nodeId, { deleted: result.deleted }, workId);
    return result;
  }

  async assignGroup(
    authorId: string,
    workId: string,
    nodeId: string,
    input: AssignGroupInput
  ): Promise<{ node: PlotNode; version: number }> {
    const result = await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      await this.requireNode(manager, tree.id, nodeId);
      if (input.group_id) {
        const group = await manager.getRepository(PlotGroupEntity).findOneBy({ id: input.group_id, tree_id: tree.id });
        if (!group) throw new NotFoundException('分组不存在');
      }
      const repository = manager.getRepository(PlotNodeEntity);
      await repository.update(
        { id: nodeId, tree_id: tree.id },
        { group_id: input.group_id, updated_at: new Date() }
      );
      const saved = await repository.findOneByOrFail({ id: nodeId });
      const version = await this.bumpVersion(manager, tree);
      return { node: mapNode(saved), version };
    });
    await this.audit.record(authorId, 'plot_node_group', 'plot_node', nodeId, { group_id: input.group_id }, workId);
    return result;
  }

  /** 坐标更新不推进结构版本；不存在的节点直接忽略（幂等） */
  async updatePositions(authorId: string, workId: string, input: PositionsInput): Promise<{ updated: number }> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    const tree = await this.requireTree(this.dataSource.manager, workId);
    let updated = 0;
    await this.dataSource.transaction(async (manager) => {
      for (const position of input.positions) {
        const result = await manager
          .getRepository(PlotNodeEntity)
          .update({ id: position.node_id, tree_id: tree.id }, { position_x: position.x, position_y: position.y });
        updated += result.affected ?? 0;
      }
    });
    return { updated };
  }

  async createLink(
    authorId: string,
    workId: string,
    input: CreateLinkInput
  ): Promise<{ link: PlotLink; version: number }> {
    // DB 有 CHECK 约束兜底，这里提前拦截以返回可读的业务错误码
    if (input.source_id === input.target_id) {
      throw new ConflictException({ code: 'PLOT_LINK_SELF' });
    }
    const result = await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      await this.requireNode(manager, tree.id, input.source_id);
      await this.requireNode(manager, tree.id, input.target_id);
      if (input.type === 'linear') {
        const links = await manager.getRepository(PlotLinkEntity).find({
          where: { tree_id: tree.id, type: 'linear' }
        });
        try {
          assertLinearAcyclic(links, input.source_id, input.target_id);
        } catch {
          throw new ConflictException({ code: 'PLOT_LINK_CYCLE' });
        }
      }
      const repository = manager.getRepository(PlotLinkEntity);
      const entity = repository.create({
        id: randomUUID(),
        tree_id: tree.id,
        source_id: input.source_id,
        target_id: input.target_id,
        type: input.type,
        label: input.label ?? null
      });
      try {
        const saved = await repository.save(entity);
        const version = await this.bumpVersion(manager, tree);
        return { link: mapLink(saved), version };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException({ code: 'PLOT_LINK_EXISTS' });
        throw error;
      }
    });
    await this.audit.record(authorId, 'plot_link_create', 'plot_link', result.link.id, { type: input.type }, workId);
    return result;
  }

  async deleteLink(authorId: string, workId: string, linkId: string, expectedVersion?: number): Promise<{ version: number }> {
    const result = await this.withLockedTree(authorId, workId, expectedVersion, async (manager, tree) => {
      const link = await manager.getRepository(PlotLinkEntity).findOneBy({ id: linkId, tree_id: tree.id });
      if (!link) throw new NotFoundException('关联不存在');
      await manager.getRepository(PlotLinkEntity).delete({ id: linkId, tree_id: tree.id });
      const version = await this.bumpVersion(manager, tree);
      return { version };
    });
    await this.audit.record(authorId, 'plot_link_delete', 'plot_link', linkId, {}, workId);
    return result;
  }

  async createGroup(
    authorId: string,
    workId: string,
    input: CreateGroupInput
  ): Promise<{ group: PlotGroup; version: number }> {
    const result = await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      const repository = manager.getRepository(PlotGroupEntity);
      const entity = repository.create({
        id: randomUUID(),
        tree_id: tree.id,
        name: input.name,
        kind: input.kind,
        order_index: input.order_index ?? 0
      });
      try {
        const saved = await repository.save(entity);
        const version = await this.bumpVersion(manager, tree);
        return { group: mapGroup(saved), version };
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException({ code: 'PLOT_GROUP_NAME_EXISTS' });
        throw error;
      }
    });
    await this.audit.record(authorId, 'plot_group_create', 'plot_group', result.group.id, { name: input.name }, workId);
    return result;
  }

  async updateGroup(
    authorId: string,
    workId: string,
    groupId: string,
    input: UpdateGroupInput
  ): Promise<{ group: PlotGroup; version: number }> {
    const result = await this.withLockedTree(authorId, workId, input.expected_version, async (manager, tree) => {
      const repository = manager.getRepository(PlotGroupEntity);
      const group = await repository.findOneBy({ id: groupId, tree_id: tree.id });
      if (!group) throw new NotFoundException('分组不存在');
      const patch: Partial<PlotGroupEntity> = { updated_at: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.order_index !== undefined) patch.order_index = input.order_index;
      try {
        await repository.update({ id: groupId, tree_id: tree.id }, patch);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException({ code: 'PLOT_GROUP_NAME_EXISTS' });
        throw error;
      }
      const saved = await repository.findOneByOrFail({ id: groupId });
      const version = await this.bumpVersion(manager, tree);
      return { group: mapGroup(saved), version };
    });
    await this.audit.record(authorId, 'plot_group_update', 'plot_group', groupId, {}, workId);
    return result;
  }

  async deleteGroup(authorId: string, workId: string, groupId: string, expectedVersion?: number): Promise<{ version: number }> {
    const result = await this.withLockedTree(authorId, workId, expectedVersion, async (manager, tree) => {
      const group = await manager.getRepository(PlotGroupEntity).findOneBy({ id: groupId, tree_id: tree.id });
      if (!group) throw new NotFoundException('分组不存在');
      await manager.getRepository(PlotGroupEntity).delete({ id: groupId, tree_id: tree.id });
      const version = await this.bumpVersion(manager, tree);
      return { version };
    });
    await this.audit.record(authorId, 'plot_group_delete', 'plot_group', groupId, {}, workId);
    return result;
  }

  /** 导出整棵树（含分组与关联），供备份或跨作品复用 */
  async exportTree(authorId: string, workId: string): Promise<ExportPlotTree> {
    const snapshot = await this.getTree(authorId, workId);
    if (!snapshot.tree) throw new NotFoundException('剧情树不存在');
    return {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      tree: { title: snapshot.tree.title },
      nodes: snapshot.nodes.map((node) => ({
        id: node.id,
        parent_id: node.parent_id,
        sibling_order: node.sibling_order,
        title: node.title,
        summary: node.summary,
        content: node.content,
        attributes: node.attributes,
        position: node.position,
        group_id: node.group_id,
        origin: node.origin
      })),
      links: snapshot.links.map((link) => ({
        source_id: link.source_id,
        target_id: link.target_id,
        type: link.type,
        label: link.label
      })),
      groups: snapshot.groups.map((group) => ({
        id: group.id,
        name: group.name,
        kind: group.kind,
        order_index: group.order_index
      }))
    };
  }

  /**
   * 导入整棵树：先全量校验（失败 422 且不触碰现有树），再事务内重建。
   * 所有节点/分组/关联 id 均重建，仅保留引用关系；已有树时整棵替换并推进版本。
   */
  async importTree(authorId: string, workId: string, input: ExportPlotTree): Promise<PlotTreeResponse> {
    let plan;
    try {
      plan = validateImportPayload(input);
    } catch (error) {
      if (error instanceof PlotImportError) {
        throw new UnprocessableEntityException({ code: 'PLOT_IMPORT_INVALID', reason: error.reason });
      }
      throw error;
    }

    const treeId = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const treeRepository = manager.getRepository(PlotTreeEntity);
      let tree = await treeRepository
        .createQueryBuilder('t')
        .setLock('pessimistic_write')
        .where('t.work_id = :workId', { workId })
        .getOne();
      const title = input.tree?.title?.trim() || '导入剧情';
      if (!tree) {
        tree = await treeRepository.save(
          treeRepository.create({
            id: randomUUID(),
            work_id: workId,
            title,
            source: 'import',
            schema_version: 1,
            version: 1
          })
        );
      } else {
        // 节点删除会级联删除关联与推衍会话，避免残留脏引用
        await manager.getRepository(PlotNodeEntity).delete({ tree_id: tree.id });
        await manager.getRepository(PlotGroupEntity).delete({ tree_id: tree.id });
        await treeRepository.update(
          { id: tree.id },
          {
            title,
            source: 'import',
            schema_version: 1,
            version: tree.version + 1,
            updated_at: new Date()
          }
        );
        tree.title = title;
        tree.source = 'import';
        tree.version += 1;
      }

      // 先建分组，再建节点（父子关系第二遍回填，避免依赖插入顺序）
      const groupIds = new Map<string, string>();
      const groupRepository = manager.getRepository(PlotGroupEntity);
      for (const [index, group] of plan.groups.entries()) {
        const id = randomUUID();
        groupIds.set(group.key, id);
        await groupRepository.save(
          groupRepository.create({
            id,
            tree_id: tree.id,
            name: group.input.name,
            kind: group.input.kind,
            order_index: group.input.order_index ?? index
          })
        );
      }

      const nodeIds = new Map<string, string>();
      const nodeRepository = manager.getRepository(PlotNodeEntity);
      for (const node of plan.nodes) {
        const id = randomUUID();
        nodeIds.set(node.key, id);
        await nodeRepository.save(
          nodeRepository.create({
            id,
            tree_id: tree.id,
            parent_id: null,
            sibling_order: node.input.sibling_order ?? 0,
            title: node.input.title,
            summary: node.input.summary ?? null,
            content: node.input.content ?? '',
            attributes: node.input.attributes ?? {},
            position_x: node.input.position?.x ?? 0,
            position_y: node.input.position?.y ?? 0,
            group_id: node.groupKey ? groupIds.get(node.groupKey)! : null,
            origin: node.input.origin ?? 'import'
          })
        );
      }
      for (const node of plan.nodes) {
        if (!node.parentKey) continue;
        await nodeRepository.update(
          { id: nodeIds.get(node.key)!, tree_id: tree.id },
          { parent_id: nodeIds.get(node.parentKey)! }
        );
      }

      const linkRepository = manager.getRepository(PlotLinkEntity);
      for (const link of plan.links) {
        await linkRepository.save(
          linkRepository.create({
            id: randomUUID(),
            tree_id: tree.id,
            source_id: nodeIds.get(link.sourceKey)!,
            target_id: nodeIds.get(link.targetKey)!,
            type: link.input.type,
            label: link.input.label ?? null
          })
        );
      }
      return tree.id;
    });

    await this.audit.record(
      authorId,
      'plot_tree_import',
      'plot_tree',
      treeId,
      { nodes: plan.nodes.length, links: plan.links.length, groups: plan.groups.length },
      workId
    );
    return this.getTree(authorId, workId);
  }
}
