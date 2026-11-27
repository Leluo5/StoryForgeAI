import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EntityManager } from 'typeorm';
import { WorkflowEntity } from '../workflow.entity';
import { resolveNewId } from './id-map';

// M4-T11 工作流域映射：data/workflows/_global/*.json → ai_workflows。
// 真实数据源：workflows 文件 project_id 为 '_global' 字符串（作者级，非作品 ID）。
// WorkflowEntity.work_id 为 nullable，作者级（_global）置 null；author_id 用迁移兜底作者。
// works/*.json 的 Coze bot 配置在 work.mapper 处理（有 project_id 回挂作品）。

/** data/workflows/_global/*.json 源结构（仅声明用到的字段） */
export interface LegacyWorkflowSource {
  id: string;
  project_id?: string;
  name: string;
  description?: string | null;
  status?: string;
  platform?: string;
  platform_config?: Record<string, unknown>;
  params?: unknown[];
  llm_config?: Record<string, unknown> | null;
  source?: string;
  icon_url?: string;
  version_no?: number;
  versions?: unknown[];
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
}

export interface WorkflowMigrateResult {
  workflows: number;
  skipped: number;
}

function toDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 同作者同名 workflow 名称去重（M4-T13 真实数据缺陷修复）。
 * 旧 JSON 允许同名（按 id 区分），但 ai_workflows 表有 (author_id, name) 唯一约束
 * （uq_ai_workflows_author_name）。真实数据 15 个「章节流」全部同名，直接写入即冲突。
 * 对已使用的 name 追加 " (2)"、" (3)" 后缀，保留全部条目且 id 不变。
 * 纯函数：迁移与校验（legacy-verify）共用，保证两侧期望 name 一致。
 */
export function dedupeWorkflowName(usedNames: Set<string>, name: string): string {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  let n = 2;
  let candidate = `${name} (${n})`;
  while (usedNames.has(candidate)) {
    n += 1;
    candidate = `${name} (${n})`;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * 迁移工作流域：workflows/_global/*.json → ai_workflows。
 * 幂等：按 workflow.id（resolveNewId('workflow', id)）查重。
 * project_id 为 '_global' → work_id 置 null（作者级）；否则按作品解析。
 */
export async function migrateWorkflows(
  tx: EntityManager,
  sourceDir: string,
  authorId: string
): Promise<WorkflowMigrateResult> {
  const workflowsDir = path.join(sourceDir, 'workflows', '_global');
  const result: WorkflowMigrateResult = { workflows: 0, skipped: 0 };

  let files: string[];
  try {
    files = (await fs.readdir(workflowsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return result; // workflows/_global 目录缺失 → 无可迁数据
  }

  // 同作者同名去重（真实数据 15 个同名「章节流」；表约束 (author_id,name) 唯一）
  const usedNames = new Set<string>();

  for (const file of files) {
    const raw = JSON.parse(
      await fs.readFile(path.join(workflowsDir, file), 'utf8')
    ) as LegacyWorkflowSource;
    if (!raw.id) continue;

    const wfId = await resolveNewId(tx, 'workflow', raw.id);
    const existing = await tx.findOne(WorkflowEntity, { where: { id: wfId } });
    if (existing) {
      result.skipped += 1;
      continue;
    }

    // project_id '_global' → 作者级（work_id null）；非 '_global' 且非空 → 按作品解析
    let workId: string | null = null;
    if (raw.project_id && raw.project_id !== '_global') {
      workId = await resolveNewId(tx, 'work', raw.project_id);
    }

    // 名称去重：同作者同名追加 " (n)" 后缀，满足 uq_ai_workflows_author_name
    const finalName = dedupeWorkflowName(usedNames, raw.name);

    await tx.save(WorkflowEntity, {
      id: wfId,
      author_id: authorId,
      work_id: workId,
      name: finalName,
      description: raw.description ?? null,
      status: raw.status ?? 'active',
      platform: raw.platform ?? 'coze',
      platform_config: raw.platform_config ?? {},
      llm_config: raw.llm_config ?? null,
      source: raw.source ?? 'manual',
      version_no: raw.version_no ?? 1,
      versions: raw.versions ?? [],
      created_at: toDate(raw.created_at) ?? new Date(),
      updated_at: toDate(raw.updated_at) ?? new Date(),
      archived_at: toDate(raw.archived_at)
    });
    result.workflows += 1;
  }

  return result;
}
