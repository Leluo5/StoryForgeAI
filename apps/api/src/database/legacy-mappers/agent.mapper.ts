import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EntityManager } from 'typeorm';
import { AgentEntity } from '../agent.entity';
import { AgentVersionEntity } from '../../agent/agent-version.entity';
import { resolveNewId } from './id-map';

// M4-T11 Agent 域映射：data/agents/<projectId>/*.json → ai_agents + agent_version。
// 真实数据源：每 project 一个目录，agent 文件含 versions[]（快照）→ agent_version 表行。
// 旧 agent 无 author 概念，author_id 用迁移兜底作者（复用 work.mapper 的 ensureLegacyAuthor）。

/** data/agents/<projectId>/*.json 源结构（仅声明用到的字段） */
export interface LegacyAgentSource {
  id: string;
  project_id?: string;
  kind?: string;
  name: string;
  description?: string;
  role_id?: string | null;
  tool_name?: string | null;
  step_order?: number | null;
  scope?: string;
  platform?: string;
  platform_config?: Record<string, unknown>;
  credential_source?: string;
  model_config?: {
    model?: string;
    [key: string]: unknown;
  };
  status?: string;
  is_default?: boolean;
  source?: string;
  tags?: string[];
  manual_group_key?: string | null;
  version_no?: number;
  versions?: Array<{
    version_no: number;
    change_type?: string;
    note?: string;
    created_at?: string;
    snapshot?: Record<string, unknown>;
  }>;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
}

export interface AgentMigrateResult {
  agents: number;
  versions: number;
  skipped: number;
}

function toDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 迁移 Agent 域：agents/<projectId>/*.json → ai_agents（含 agent_version）。
 * 幂等：按 agent.id（resolveNewId('agent', id)）查重，已存在则 skipped（含其版本）。
 */
export async function migrateAgents(
  tx: EntityManager,
  sourceDir: string,
  authorId: string
): Promise<AgentMigrateResult> {
  const agentsRoot = path.join(sourceDir, 'agents');
  const result: AgentMigrateResult = { agents: 0, versions: 0, skipped: 0 };

  let projectDirs: string[] = [];
  try {
    projectDirs = (await fs.readdir(agentsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return result; // agents 目录缺失 → 无可迁数据
  }

  for (const projectDir of projectDirs) {
    const dir = path.join(agentsRoot, projectDir);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as LegacyAgentSource;
      if (!raw.id) continue;

      const agentId = await resolveNewId(tx, 'agent', raw.id);
      const existing = await tx.findOne(AgentEntity, { where: { id: agentId } });
      if (existing) {
        result.skipped += 1;
        continue;
      }

      const modelConfig = raw.model_config ?? {};
      const modelId =
        typeof modelConfig.model === 'string' && modelConfig.model.trim() !== ''
          ? modelConfig.model
          : 'mock';

      // 作品归属：旧 agent 的 project_id 经 resolveNewId('work', projectId) 映射；
      // 该 work 可能尚未迁移（agent 域与 work 域独立事务），但 project_id 仅作归属标识。
      let projectId: string | null = null;
      if (raw.project_id) {
        projectId = await resolveNewId(tx, 'work', raw.project_id);
      }

      await tx.save(AgentEntity, {
        id: agentId,
        author_id: authorId,
        name: raw.name,
        platform: raw.platform ?? 'mock',
        model_id: modelId,
        model_config: modelConfig,
        status: raw.status ?? 'active',
        is_default: raw.is_default ?? false,
        project_id: projectId,
        kind: raw.kind ?? 'legacy',
        description: raw.description ?? '',
        role_id: raw.role_id ?? null,
        tool_name: raw.tool_name ?? null,
        step_order: raw.step_order ?? null,
        scope: raw.scope ?? 'project',
        platform_config: raw.platform_config ?? {},
        source: raw.source ?? 'manual',
        tags: raw.tags ?? [],
        manual_group_key: raw.manual_group_key ?? null,
        credential_source: raw.credential_source ?? 'global',
        version_no: raw.version_no ?? 1,
        created_at: toDate(raw.created_at) ?? new Date(),
        updated_at: toDate(raw.updated_at) ?? new Date(),
        archived_at: toDate(raw.archived_at)
      });
      result.agents += 1;

      // 版本快照 → agent_version 表行（versions[] 可能为空，但当前 version_no 至少 1）
      const versions = raw.versions ?? [];
      if (versions.length === 0) {
        // 无历史快照时补一行当前版本，保持 version_no 指向有效行
        await tx.save(AgentVersionEntity, {
          agent_id: agentId,
          version_no: raw.version_no ?? 1,
          action: 'create',
          note: '',
          snapshot: { ...raw, versions: undefined }
        });
        result.versions += 1;
      } else {
        for (const v of versions) {
          await tx.save(AgentVersionEntity, {
            agent_id: agentId,
            version_no: v.version_no,
            action: v.change_type ?? 'update',
            note: v.note ?? '',
            snapshot: v.snapshot ?? {},
            created_at: toDate(v.created_at) ?? new Date()
          });
          result.versions += 1;
        }
      }
    }
  }

  return result;
}
