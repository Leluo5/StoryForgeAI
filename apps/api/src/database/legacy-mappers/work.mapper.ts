import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EntityManager } from 'typeorm';
import { AuthorEntity } from '../author.entity';
import { WorkEntity } from '../work.entity';
import { resolveNewId } from './id-map';

// M4-T11 作品域映射：data/projects/<id>.json → works 表。
// 真实数据源：project 为唯一作品本体；works/<name>.json 为 Coze bot 配置（可按 project_id 回挂）。
// 旧数据无 author 概念（project.author 为空字符串），WorkEntity.author_id 非空必填，
// 故创建迁移专用兜底作者并复用其 id。volumes/chapters 数据源为空（chapters 空数组），不产生行。

/** 迁移专用兜底作者（旧数据无 author，用于满足 author_id NOT NULL 外键） */
export const LEGACY_AUTHOR_EMAIL = 'legacy-migrate@local';
const LEGACY_AUTHOR_KEY = 'author:legacy-migrate';

/** data/projects/<id>.json 源结构（仅声明用到的字段） */
export interface LegacyProjectSource {
  id: string;
  title: string;
  description?: string;
  genre?: string;
  status?: string;
  author?: string;
  collab_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
  chapters?: unknown[];
}

/** data/works/<name>.json 源结构（Coze bot 配置，仅声明用到的字段） */
export interface LegacyWorkConfigSource {
  id?: string;
  name?: string;
  description?: string;
  icon_url?: string;
  coze_bot_id?: string;
  coze_workflow_id?: string;
  pat_token?: string;
  access_code?: string;
  interaction_type?: string;
  system_prompt?: string;
  prologue?: string;
  suggested_questions?: unknown[];
  parameters?: unknown[];
  model_name?: string;
  response_format?: string;
  is_public?: boolean;
  coze_meta?: Record<string, unknown>;
  project_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WorkMigrateResult {
  works: number;
  volumes: number;
  chapters: number;
  skipped: number;
}

/**
 * 确保迁移专用兜底作者存在（幂等），返回其 id。
 * password_hash 置为不可登录哨兵值；display_name 标识迁移来源。
 */
export async function ensureLegacyAuthor(tx: EntityManager): Promise<string> {
  const existing = await tx.findOne(AuthorEntity, { where: { email: LEGACY_AUTHOR_EMAIL } });
  if (existing) return existing.id;

  const id = await resolveNewId(tx, 'author', LEGACY_AUTHOR_KEY);
  await tx.save(AuthorEntity, {
    id,
    email: LEGACY_AUTHOR_EMAIL,
    display_name: '迁移用户',
    password_hash: '!legacy-migrate!' // 不可登录哨兵
  });
  return id;
}

function toDate(value?: string): Date {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * 迁移作品域：projects/<id>.json → works。
 * volumes/chapters 数据源为空，本函数不产生 volume/chapter 行（返回 0）。
 * 幂等：按 work.id（resolveNewId('work', projectId)）查重，已存在则 skipped。
 */
export async function migrateWorks(
  tx: EntityManager,
  sourceDir: string
): Promise<WorkMigrateResult> {
  const projectsDir = path.join(sourceDir, 'projects');
  const worksDir = path.join(sourceDir, 'works');
  const result: WorkMigrateResult = { works: 0, volumes: 0, chapters: 0, skipped: 0 };

  let projectFiles: string[] = [];
  try {
    projectFiles = (await fs.readdir(projectsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return result; // projects 目录缺失 → 无可迁数据
  }

  // 读取 works 配置索引：project_id → workConfig（作品 bot 配置回挂）
  let workConfigs = new Map<string, LegacyWorkConfigSource>();
  try {
    const workFiles = (await fs.readdir(worksDir)).filter((f) => f.endsWith('.json'));
    for (const file of workFiles) {
      const raw = JSON.parse(await fs.readFile(path.join(worksDir, file), 'utf8')) as LegacyWorkConfigSource;
      if (raw.project_id) workConfigs.set(raw.project_id, raw);
    }
  } catch {
    workConfigs = new Map();
  }

  const authorId = await ensureLegacyAuthor(tx);

  for (const file of projectFiles) {
    const raw = JSON.parse(
      await fs.readFile(path.join(projectsDir, file), 'utf8')
    ) as LegacyProjectSource;
    if (!raw.id) continue;

    const workId = await resolveNewId(tx, 'work', raw.id);
    const existing = await tx.findOne(WorkEntity, { where: { id: workId } });
    if (existing) {
      result.skipped += 1;
      continue;
    }

    const cfg = workConfigs.get(raw.id);
    const description = cfg?.description ?? raw.description ?? '';
    const iconUrl = cfg?.icon_url ?? '';
    const cozeBotId = cfg?.coze_bot_id || null;
    const patToken = cfg?.pat_token || null;
    const systemPrompt = cfg?.system_prompt || null;
    const prologue = cfg?.prologue || null;
    const modelName = cfg?.model_name || null;
    const responseFormat = cfg?.response_format || null;

    await tx.save(WorkEntity, {
      id: workId,
      author_id: authorId,
      title: raw.title,
      description,
      status: (raw.status as 'active' | 'archived') ?? 'active',
      is_public: cfg?.is_public ?? true,
      access_code: cfg?.access_code ?? '',
      coze_bot_id: cozeBotId,
      pat_token: patToken,
      interaction_type: cfg?.interaction_type ?? 'chat',
      system_prompt: systemPrompt,
      prologue,
      suggested_questions: cfg?.suggested_questions ?? [],
      parameters: cfg?.parameters ?? [],
      model_name: modelName,
      response_format: responseFormat,
      icon_url: iconUrl,
      coze_meta: cfg?.coze_meta ?? {},
      project_id: workId, // 旧 project 无独立表，映射自身 id 作项目归属
      created_at: toDate(raw.created_at),
      updated_at: toDate(raw.updated_at)
    });
    result.works += 1;
  }

  return result;
}
