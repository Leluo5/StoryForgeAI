import { resolve } from 'node:path';
import { config } from 'dotenv';
import type { DataSource } from 'typeorm';

config({ path: resolve(__dirname, '../../../.env') });

export const DEFAULT_TEST_DATABASE_URL = 'postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge_test';

export function assertTestDatabaseUrl(value: string): void {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, '');
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !database.endsWith('_test')) {
    throw new Error('Test database URL must use PostgreSQL and a database name ending in _test');
  }
}

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  assertTestDatabaseUrl(value);
  return value;
}

function assertTestDataSource(dataSource: DataSource): void {
  const url = (dataSource.options as { url?: string }).url;
  if (!url) throw new Error('Test data source must be created from a PostgreSQL URL');
  assertTestDatabaseUrl(url);
}

export async function dropWritingAndAuthTables(dataSource: DataSource): Promise<void> {
  assertTestDataSource(dataSource);
  // M3c-2 角色版图表（先删引用表，按 FK 依赖倒序）
  await dataSource.query('DROP TABLE IF EXISTS character_text_anchors CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_archive_scans CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS plot_node_character_owners CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_portability_jobs CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_ai_candidate_items CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_ai_drafts CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_avatar_assets CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_growth_events CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_view_nodes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_views CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_relations CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_relation_types CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS character_aliases CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS characters CASCADE');
  // M3c 剧情表（先删引用表，按 FK 依赖倒序）
  await dataSource.query('DROP TABLE IF EXISTS plot_generation_drafts CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS derivation_candidates CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS derivation_steps CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS derivation_sessions CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS plot_links CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS plot_nodes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS plot_groups CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS plot_trees CASCADE');
  // M3b Agent 配置与管理表（先删引用表，按 FK 依赖倒序：ai_tools→ai_agents）
  await dataSource.query('DROP TABLE IF EXISTS ai_tools CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS ai_agents CASCADE');
  // M3a AI 创作基座表（先删引用表，按 FK 依赖倒序）
  await dataSource.query('DROP TABLE IF EXISTS ai_task_events CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS ai_tasks CASCADE');
  // M2 变更协作表（先删引用表，按 FK 依赖倒序）
  await dataSource.query('DROP TABLE IF EXISTS audit_logs CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS notifications CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS todos CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS comment_threads CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS version_snapshots CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS revision_sets CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS chapter_changes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS chapters CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS volumes CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS works CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS sessions CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS authors CASCADE');
  await dataSource.query('DROP TABLE IF EXISTS migrations CASCADE');
}

export async function resetTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) await dataSource.initialize();
  await dropWritingAndAuthTables(dataSource);
  await dataSource.runMigrations();
}

export async function clearAuthTables(dataSource: DataSource): Promise<void> {
  assertTestDataSource(dataSource);
  // ai_tools / ai_agents 显式列入 TRUNCATE，避免「TRUNCATE authors CASCADE」沿 FK 链
  // （authors→ai_agents→ai_tools）递归清空全局工具种子。所有表一次性显式列出，CASCADE 不再波及额外表。
  await dataSource.query(
    'TRUNCATE TABLE ai_tools, ai_agents, ai_task_events, ai_tasks, audit_logs, notifications, todos, comment_threads, version_snapshots, revision_sets, chapter_changes, chapters, volumes, works, sessions, authors RESTART IDENTITY CASCADE'
  );
  // 重新预置全局权威工具（与迁移种子一致，幂等），保证每个用例工具清单可用。
  await dataSource.query(`
    INSERT INTO ai_tools (id, tool_id, name, description, enabled)
    VALUES
      (gen_random_uuid(), 'continue', '续写', '延续当前章节内容', true),
      (gen_random_uuid(), 'polish', '润色', '优化语句与表达', true),
      (gen_random_uuid(), 'expand', '扩写', '丰富细节与描写', true),
      (gen_random_uuid(), 'rewrite', '改写', '重写指定段落', true),
      (gen_random_uuid(), 'plot_derivation', '剧情推衍', '基于剧情节点推衍下一步走向', true),
      (gen_random_uuid(), 'plot_generate', '剧情结构生成', '从大纲或正文生成剧情树草稿', true),
      (gen_random_uuid(), 'character_extract', '角色关系抽取', '从章节或作品文本中抽取角色与关系候选', true),
      (gen_random_uuid(), 'character_growth_extract', '成长事件抽取', '从章节或作品文本中抽取角色成长事件候选', true),
      (gen_random_uuid(), 'character_avatar_generate', '角色头像生成', '根据角色档案生成头像资产', true)
    ON CONFLICT (tool_id) DO NOTHING
  `);
}

export async function destroyTestDatabase(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) return;
  await dropWritingAndAuthTables(dataSource);
  await dataSource.destroy();
}
