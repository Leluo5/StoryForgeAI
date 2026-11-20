import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource, In } from 'typeorm';
import { PlotNodeCharacterOwnerEntity } from '../database/plot-node-character-owner.entity';
import { CharacterEntity } from '../database/character.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';

const OWNERS_MAX = 10;

export interface OwnerEntry {
  character_id: string;
  is_exclusive?: boolean;
}

export interface NodeOwnerRow {
  character_id: string;
  is_exclusive: boolean;
  character_status: string;
}

export interface SetOwnersResult {
  node_id: string;
  work_id: string;
  owners: OwnerEntry[];
  hidden: boolean;
  exclusive_archived: boolean;
}

export interface ExclusiveArchivedStats {
  total_nodes: number;
  exclusive_archived_nodes: number;
  hidden_nodes: number;
}

// ──────────────────── 隐藏判定纯函数 ────────────────────

/**
 * 节点是否「专属归属者全部已归档」从而在读取期隐藏：
 *  - 无专属归属 → 永不隐藏（共享节点）
 *  - 有专属归属且全部 archived/merged → 隐藏
 *  - 任一专属归属者 active → 不隐藏
 * 隐藏只作用于节点本身，不级联子节点、不改 parent_id/sibling_order/plot_links。
 */
export function computeHidden(owners: NodeOwnerRow[]): boolean {
  const exclusive = owners.filter((o) => o.is_exclusive);
  if (exclusive.length === 0) return false;
  return exclusive.every((o) => o.character_status !== 'active');
}

@Injectable()
export class PlotOwnerService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  // ──────────────── 私有守卫 ────────────────

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  private async assertNodeInWork(manager: EntityManager, workId: string, nodeId: string): Promise<void> {
    const node = await manager
      .getRepository(PlotNodeEntity)
      .createQueryBuilder('n')
      .innerJoin(PlotTreeEntity, 't', 't.id = n.tree_id AND t.work_id = :workId', { workId })
      .where('n.id = :nodeId', { nodeId })
      .getOne();
    if (!node) throw new NotFoundException('剧情节点不存在');
  }

  /**
   * 校验归属角色列表：
   *  - 去重 + ≤ 10
   *  - 必须同作品
   *  - 必须 active（archived/merged → 409）
   */
  private async validateOwners(
    manager: EntityManager,
    workId: string,
    characterIds: string[]
  ): Promise<CharacterEntity[]> {
    const unique = Array.from(new Set(characterIds));
    if (unique.length > OWNERS_MAX) {
      throw new UnprocessableEntityException({ code: 'PLOT_OWNERS_TOO_MANY', max: OWNERS_MAX });
    }
    if (unique.length === 0) return [];
    const repo = manager.getRepository(CharacterEntity);
    const characters = await repo.find({ where: { id: In(unique), work_id: workId } });
    if (characters.length !== unique.length) {
      throw new NotFoundException('归属角色不存在或跨作品');
    }
    const invalid = characters.filter((c) => c.status !== 'active');
    if (invalid.length > 0) {
      throw new ConflictException({
        code: 'PLOT_OWNER_CHARACTER_ARCHIVED',
        character_ids: invalid.map((c) => c.id),
        message: '角色已归档或已合并，不可作为归属者'
      });
    }
    return characters;
  }

  // ──────────────── 读：归属列表 + 隐藏判定 ────────────────

  async list(authorId: string, workId: string, nodeId: string): Promise<{ owners: OwnerEntry[]; hidden: boolean }> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    await this.assertNodeInWork(this.dataSource.manager, workId, nodeId);
    const rows = await this.loadOwnersWithStatus(this.dataSource.manager, nodeId);
    return { owners: rows.map((r) => ({ character_id: r.character_id, is_exclusive: r.is_exclusive })), hidden: computeHidden(rows) };
  }

  async bulkList(authorId: string, workId: string, nodeIds: string[]): Promise<Map<string, { owners: OwnerEntry[]; hidden: boolean }>> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    if (nodeIds.length === 0) return new Map();
    const nodes = await this.dataSource
      .getRepository(PlotNodeEntity)
      .createQueryBuilder('n')
      .innerJoin(PlotTreeEntity, 't', 't.id = n.tree_id AND t.work_id = :workId', { workId })
      .where('n.id IN (:...nodeIds)', { nodeIds })
      .getMany();
    const existing = new Set(nodes.map((n) => n.id));
    const owners = await this.dataSource.getRepository(PlotNodeCharacterOwnerEntity).find({
      where: { node_id: In(nodeIds) }
    });
    if (owners.length === 0) {
      const result = new Map<string, { owners: OwnerEntry[]; hidden: boolean }>();
      for (const id of existing) result.set(id, { owners: [], hidden: false });
      return result;
    }
    const characterIds = Array.from(new Set(owners.map((o) => o.character_id)));
    const chars = await this.dataSource.getRepository(CharacterEntity).find({ where: { id: In(characterIds) } });
    const statusByChar = new Map(chars.map((c) => [c.id, c.status]));
    const grouped = new Map<string, NodeOwnerRow[]>();
    for (const owner of owners) {
      const list = grouped.get(owner.node_id) ?? [];
      list.push({
        character_id: owner.character_id,
        is_exclusive: owner.is_exclusive,
        character_status: statusByChar.get(owner.character_id) ?? 'unknown'
      });
      grouped.set(owner.node_id, list);
    }
    const result = new Map<string, { owners: OwnerEntry[]; hidden: boolean }>();
    for (const nodeId of existing) {
      const rows = grouped.get(nodeId) ?? [];
      result.set(nodeId, { owners: rows.map((r) => ({ character_id: r.character_id, is_exclusive: r.is_exclusive })), hidden: computeHidden(rows) });
    }
    return result;
  }

  async exclusiveArchivedStats(authorId: string, workId: string): Promise<ExclusiveArchivedStats> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    const allNodes = await this.dataSource
      .getRepository(PlotNodeEntity)
      .createQueryBuilder('n')
      .innerJoin(PlotTreeEntity, 't', 't.id = n.tree_id AND t.work_id = :workId', { workId })
      .getMany();
    const rows = await this.dataSource
      .getRepository(PlotNodeCharacterOwnerEntity)
      .createQueryBuilder('o')
      .where('o.work_id = :workId', { workId })
      .getMany();
    if (rows.length === 0) return { total_nodes: allNodes.length, exclusive_archived_nodes: 0, hidden_nodes: 0 };
    const charIds = Array.from(new Set(rows.map((r) => r.character_id)));
    const chars = await this.dataSource.getRepository(CharacterEntity).find({ where: { id: In(charIds) } });
    const statusByChar = new Map(chars.map((c) => [c.id, c.status]));
    const grouped = new Map<string, NodeOwnerRow[]>();
    for (const owner of rows) {
      const list = grouped.get(owner.node_id) ?? [];
      list.push({
        character_id: owner.character_id,
        is_exclusive: owner.is_exclusive,
        character_status: statusByChar.get(owner.character_id) ?? 'unknown'
      });
      grouped.set(owner.node_id, list);
    }
    let exclusiveArchivedNodes = 0;
    let hiddenNodes = 0;
    for (const [nodeId, nodeRows] of grouped) {
      if (!allNodes.some((n) => n.id === nodeId)) continue;
      const hasExclusive = nodeRows.some((r) => r.is_exclusive);
      if (hasExclusive) exclusiveArchivedNodes += 1;
      if (computeHidden(nodeRows)) hiddenNodes += 1;
    }
    return { total_nodes: allNodes.length, exclusive_archived_nodes: exclusiveArchivedNodes, hidden_nodes: hiddenNodes };
  }

  // ──────────────── 写：整组替换 / 单条删除 ────────────────

  /**
   * A6/Q4 差异更新：
   * - 请求中的 active 角色新增/更新；
   * - 未出现的 active 角色删除其归属；
   * - archived / merged 角色归属行一律保留；
   * - 空数组只清空 active 归属。
   */
  async set(
    authorId: string,
    workId: string,
    nodeId: string,
    entries: OwnerEntry[]
  ): Promise<SetOwnersResult> {
    // 前置去重：按 character_id 保留首个 entry（避免撞 UNIQUE 约束）
    const deduped: OwnerEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.character_id)) continue;
      seen.add(entry.character_id);
      deduped.push(entry);
    }
    const characters = await this.validateOwners(this.dataSource.manager, workId, deduped.map((e) => e.character_id));
    const normalized = deduped.map((e) => ({ character_id: e.character_id, is_exclusive: e.is_exclusive ?? true }));

    const saved = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      await this.assertNodeInWork(manager, workId, nodeId);

      const repo = manager.getRepository(PlotNodeCharacterOwnerEntity);
      const existing = await repo.find({ where: { node_id: nodeId } });
      const existingCharIds = Array.from(new Set(existing.map((r) => r.character_id)));
      const existingChars = existingCharIds.length
        ? await manager.getRepository(CharacterEntity).find({ where: { id: In(existingCharIds) } })
        : [];
      const statusByChar = new Map(existingChars.map((c) => [c.id, c.status]));

      const requestedIds = new Set(normalized.map((e) => e.character_id));
      const removeIds = existing
        .filter((row) => {
          if (requestedIds.has(row.character_id)) return true; // 请求中：先删后插以更新 is_exclusive
          return (statusByChar.get(row.character_id) ?? 'unknown') === 'active';
        })
        .map((row) => row.id);
      if (removeIds.length > 0) {
        await repo.delete({ id: In(removeIds) });
      }
      for (const entry of normalized) {
        await repo.save(
          repo.create({
            id: randomUUID(),
            work_id: workId,
            node_id: nodeId,
            character_id: entry.character_id,
            is_exclusive: entry.is_exclusive
          })
        );
      }

      await this.audit.record(
        authorId,
        'plot_node_owners_set',
        'plot_node',
        nodeId,
        { count: normalized.length },
        workId,
        manager
      );

      // 返回写后全量归属（含保留的归档行）
      const rows = await this.loadOwnersWithStatus(manager, nodeId);
      return {
        node_id: nodeId,
        work_id: workId,
        owners: rows.map((r) => ({ character_id: r.character_id, is_exclusive: r.is_exclusive })),
        hidden: computeHidden(rows),
        exclusive_archived: computeHidden(rows)
      };
    });
    return saved;
  }

  async remove(authorId: string, workId: string, nodeId: string, characterId: string): Promise<{ node_id: string; removed: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      await this.assertNodeInWork(manager, workId, nodeId);
      // A6/Q4：归档角色的归属行保留，只有在恢复角色后才能主动移除
      const owner = await manager
        .getRepository(PlotNodeCharacterOwnerEntity)
        .findOneBy({ node_id: nodeId, character_id: characterId });
      if (owner) {
        const character = await manager
          .getRepository(CharacterEntity)
          .findOneBy({ id: characterId, work_id: workId });
        if (character && character.status !== 'active') {
          throw new ConflictException({
            code: 'PLOT_OWNER_CHARACTER_ARCHIVED',
            message: '归档角色的归属需先恢复角色后再移除'
          });
        }
      }
      const result = await manager
        .getRepository(PlotNodeCharacterOwnerEntity)
        .delete({ node_id: nodeId, character_id: characterId });
      const removed = (result.affected ?? 0) > 0;
      if (removed) {
        await this.audit.record(
          authorId,
          'plot_node_owner_remove',
          'plot_node',
          nodeId,
          { character_id: characterId },
          workId,
          manager
        );
      }
      return { node_id: nodeId, removed };
    });
  }

  // ──────────────── 私有查询：归属 + 角色状态 ────────────────

  private async loadOwnersWithStatus(manager: EntityManager, nodeId: string): Promise<NodeOwnerRow[]> {
    const owners = await manager.getRepository(PlotNodeCharacterOwnerEntity).find({ where: { node_id: nodeId } });
    if (owners.length === 0) return [];
    const charIds = Array.from(new Set(owners.map((o) => o.character_id)));
    const chars = await manager.getRepository(CharacterEntity).find({ where: { id: In(charIds) } });
    const statusByChar = new Map(chars.map((c) => [c.id, c.status]));
    return owners.map((o) => ({
      character_id: o.character_id,
      is_exclusive: o.is_exclusive,
      character_status: statusByChar.get(o.character_id) ?? 'unknown'
    }));
  }
}
