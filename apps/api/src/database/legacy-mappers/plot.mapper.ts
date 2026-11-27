import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EntityManager } from 'typeorm';
import { PlotTreeEntity } from '../plot-tree.entity';
import { PlotNodeEntity } from '../plot-node.entity';
import { PlotLinkEntity } from '../plot-link.entity';
import { resolveNewId } from './id-map';

// M4-T11 剧情树域映射：data/projects/plot/<id>.json → plot_trees + plot_nodes + plot_links。
// 真实数据源：plot 文件无显式 work_id/外键，需按 project 关联推断归属。
// 推断规则：遍历 data/projects/*.json，若 plot 的任一 role_id 出现在某 project.roles 则归属该 project；
// 否则若全局唯一 project 则归属之；仍无法判定则跳过（不落孤儿外键）。
// links[] 旧结构为空数组（节点父子层级经 parent_id 表达），本域不产生 plot_link 行。

interface LegacyPlotNodeSource {
  id: string;
  label: string;
  type?: string;
  content?: string;
  parent_id?: string | null;
  source?: string;
  position?: { x?: number; y?: number };
  tags?: string[];
  role_id?: string | null;
}

interface LegacyPlotSource {
  id: string;
  name?: string;
  source?: string;
  root_node_id?: string | null;
  nodes?: LegacyPlotNodeSource[];
  links?: Array<{
    source_id: string;
    target_id: string;
    type?: string;
    label?: string | null;
  }>;
  created_at?: string;
  updated_at?: string;
}

export interface PlotMigrateResult {
  trees: number;
  nodes: number;
  links: number;
  skipped: number;
  undetermined: number;
}

function toDate(value?: string): Date {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * 推断 plot 归属 work：优先按 role_id 命中 project.roles，否则唯一 project 兜底。
 * 返回 work 旧 ID 或 null（无法判定）。
 */
async function inferPlotWorkId(
  sourceDir: string,
  plot: LegacyPlotSource
): Promise<string | null> {
  const projectsDir = path.join(sourceDir, 'projects');
  let projectFiles: string[];
  try {
    projectFiles = (await fs.readdir(projectsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  if (projectFiles.length === 0) return null;

  const roleIds = new Set((plot.nodes ?? []).map((n) => n.role_id).filter((x): x is string => !!x));
  for (const file of projectFiles) {
    const raw = JSON.parse(await fs.readFile(path.join(projectsDir, file), 'utf8')) as {
      id?: string;
      roles?: Array<{ id?: string }>;
    };
    if (!raw.id) continue;
    const projectRoleIds = new Set((raw.roles ?? []).map((r) => r.id).filter((x): x is string => !!x));
    for (const roleId of roleIds) {
      if (projectRoleIds.has(roleId)) return raw.id;
    }
  }

  // 无 role 命中：仅当全局唯一 project 时归属
  if (projectFiles.length === 1) {
    const onlyProject = projectFiles[0];
    if (!onlyProject) return null;
    const raw = JSON.parse(
      await fs.readFile(path.join(projectsDir, onlyProject), 'utf8')
    ) as { id?: string };
    return raw.id ?? null;
  }
  return null;
}

/**
 * 迁移剧情树域：projects/plot/<id>.json → plot_tree + plot_nodes。
 * plot_tree UNIQUE(work_id)，幂等：按 tree.id（resolveNewId('plot_tree', id)）查重。
 */
export async function migratePlots(
  tx: EntityManager,
  sourceDir: string
): Promise<PlotMigrateResult> {
  const plotDir = path.join(sourceDir, 'projects', 'plot');
  const result: PlotMigrateResult = { trees: 0, nodes: 0, links: 0, skipped: 0, undetermined: 0 };

  let files: string[];
  try {
    files = (await fs.readdir(plotDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return result; // plot 目录缺失 → 无可迁数据
  }

  for (const file of files) {
    const plot = JSON.parse(await fs.readFile(path.join(plotDir, file), 'utf8')) as LegacyPlotSource;
    if (!plot.id) continue;

    const treeId = await resolveNewId(tx, 'plot_tree', plot.id);
    const existing = await tx.findOne(PlotTreeEntity, { where: { id: treeId } });
    if (existing) {
      result.skipped += 1;
      continue;
    }

    const workLegacyId = await inferPlotWorkId(sourceDir, plot);
    if (!workLegacyId) {
      result.undetermined += 1;
      continue; // 无法判定归属，跳过（不落孤儿）
    }
    const workId = await resolveNewId(tx, 'work', workLegacyId);

    await tx.save(PlotTreeEntity, {
      id: treeId,
      work_id: workId,
      title: plot.name ?? '未命名剧情',
      source: plot.source ?? 'manual',
      schema_version: 1,
      version: 1,
      created_at: toDate(plot.created_at),
      updated_at: toDate(plot.updated_at)
    });
    result.trees += 1;

    const nodeIdMap = new Map<string, string>();
    for (const node of plot.nodes ?? []) {
      if (!node.id) continue;
      const newId = await resolveNewId(tx, 'plot_node', node.id);
      nodeIdMap.set(node.id, newId);
    }

    for (const node of plot.nodes ?? []) {
      if (!node.id) continue;
      const newId = nodeIdMap.get(node.id)!;
      const parentNewId = node.parent_id ? nodeIdMap.get(node.parent_id) ?? null : null;
      // 节点角色引用：经 resolveNewId 映射（角色可能未迁，映射仍稳定，无外键强约束风险由引用校验兜底）
      await tx.save(PlotNodeEntity, {
        id: newId,
        tree_id: treeId,
        parent_id: parentNewId,
        sibling_order: 0,
        title: node.label,
        summary: node.type === 'main' ? node.content || null : null,
        content: node.content ?? '',
        attributes: { role_id: node.role_id ? await resolveNewId(tx, 'character', node.role_id) : null },
        position_x: node.position?.x ?? 0,
        position_y: node.position?.y ?? 0,
        group_id: null,
        origin: node.source ?? 'manual',
        created_at: toDate(plot.created_at),
        updated_at: toDate(plot.updated_at)
      });
      result.nodes += 1;
    }

    // links[]：旧结构为空，但仍兼容非空（防数据演进）
    for (const link of plot.links ?? []) {
      if (!link.source_id || !link.target_id) continue;
      const sourceNew = nodeIdMap.get(link.source_id);
      const targetNew = nodeIdMap.get(link.target_id);
      if (!sourceNew || !targetNew) continue;
      await tx.save(PlotLinkEntity, {
        id: await resolveNewId(tx, 'plot_link', `${plot.id}:${link.source_id}:${link.target_id}`),
        tree_id: treeId,
        source_id: sourceNew,
        target_id: targetNew,
        type: link.type === 'non_linear' ? 'non_linear' : 'linear',
        label: link.label ?? null,
        created_at: toDate(plot.created_at)
      });
      result.links += 1;
    }
  }

  return result;
}
