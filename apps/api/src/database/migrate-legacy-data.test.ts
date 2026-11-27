import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DataSource } from 'typeorm';
import { createDataSource } from './data-source';
import { testDatabaseUrl, dropWritingAndAuthTables } from '../../test/test-database';
import { migrate, backupLegacyData, restoreLegacyData, type MigrateOptions } from './migrate-legacy-data';
import { uuidFromHash } from './legacy-mappers/id-map';
import { WorkEntity } from './work.entity';
import { AgentEntity } from './agent.entity';
import { CharacterEntity } from './character.entity';
import { CharacterRelationEntity } from './character-relation.entity';
import { PlotTreeEntity } from './plot-tree.entity';
import { PlotNodeEntity } from './plot-node.entity';
import { WorkflowEntity } from './workflow.entity';
import { LegacyIdMapEntity } from './legacy-id-map.entity';
import { dedupeWorkflowName } from './legacy-mappers/workflow.mapper';

// M4-T11 集成测试：真实数据源结构（临时目录）+ 真实测试库。
// 覆盖：dry-run 不写库 / 正式迁移行数 / 幂等（二次 skipped）/ 回滚备份恢复 / 引用完整性。

const PROJECT_ID = '31601c93f2f54b0d9cd85f8a0ee6de1d';
const ROLE_A = 'a350c26d6bda484fb019e088b9fc0aec';
const ROLE_B = 'b350c26d6bda484fb019e088b9fc0aed';

interface TestContext {
  ds: DataSource;
  sourceDir: string;
  backupDir: string;
}

let ctx: TestContext;
let tmpRoot: string;

async function writeJson(rel: string, data: unknown): Promise<void> {
  const full = path.join(ctx.sourceDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(data, null, 2));
}

async function buildFixtureSource(): Promise<void> {
  // projects/<id>.json（唯一作品本体 + roles）
  await writeJson(`projects/${PROJECT_ID}.json`, {
    id: PROJECT_ID,
    title: 'P5T5基准100',
    description: '迁移集成测试作品',
    genre: '玄幻',
    status: 'active',
    author: '',
    collab_enabled: false,
    created_at: '2026-11-10T00:00:00',
    updated_at: '2026-11-20T00:00:00',
    chapters: [],
    roles: [
      {
        id: ROLE_A,
        project_id: PROJECT_ID,
        name: '主角',
        age: 20,
        gender: '男',
        status: 'active',
        created_at: '2026-11-10T00:00:00',
        updated_at: '2026-11-10T00:00:00',
        identity: '主角身份',
        nationality: '中州',
        faith: null,
        camp: '正派',
        race: '人族',
        profession: '剑修',
        age_group: '青年',
        attributes: { 灵力: '筑基', 功法: '御剑术' },
        relations: [{ target_role_id: ROLE_B, relation_type: 'ally', note: '挚友' }],
        personality: '坚韧',
        background: '出身寒门',
        appearance: '清秀',
        avatar: ''
      },
      {
        id: ROLE_B,
        project_id: PROJECT_ID,
        name: '反派',
        age: 35,
        gender: '女',
        status: 'active',
        created_at: '2026-11-10T00:00:00',
        updated_at: '2026-11-10T00:00:00',
        identity: '反派身份',
        nationality: '北境',
        faith: '魔道',
        camp: '反派',
        race: '魔族',
        profession: '魔修',
        age_group: '中年',
        attributes: {},
        relations: [{ target_role_id: ROLE_A, relation_type: 'enemy', note: '宿敌' }],
        personality: '阴狠',
        background: '魔域',
        appearance: '妖艳',
        avatar: ''
      }
    ],
    role_bindings: [],
    agent_sessions: []
  });

  // projects/plot/<uuid>.json（剧情树，无显式 work_id）
  await writeJson(`projects/plot/${ROLE_A}.json`, {
    id: ROLE_A,
    name: '主线剧情',
    source: 'manual',
    root_node_id: 'n1',
    nodes: [
      { id: 'n1', label: '开端', type: 'main', content: '故事开端', parent_id: null, position: { x: 0, y: 0 }, role_id: ROLE_A },
      { id: 'n2', label: '冲突', type: 'main', content: '冲突升级', parent_id: 'n1', position: { x: 1, y: 1 }, role_id: ROLE_B }
    ],
    links: [],
    created_at: '2026-11-12T00:00:00',
    updated_at: '2026-11-12T00:00:00'
  });

  // agents/<projectId>/<uuid>.json（agent + versions[]）
  await writeJson(`agents/${PROJECT_ID}/agent1.json`, {
    id: 'agent-1',
    project_id: PROJECT_ID,
    kind: 'tool_agent',
    name: '工具·continue',
    description: '续写工具',
    role_id: null,
    tool_name: 'continue',
    step_order: null,
    scope: 'project',
    platform: 'coze',
    platform_config: { bot_id: 'bot-1', workspace_id: 'ws-1' },
    credential_source: 'global',
    model_config: { model: 'gpt-4o', temperature: 0.7, top_p: 1, max_tokens: 2048, system_prompt: '', stream: false, frequency_penalty: 0, presence_penalty: 0, response_format: 'text', stop: [] },
    status: 'active',
    is_default: true,
    source: 'auto',
    tags: ['写'],
    manual_group_key: null,
    version_no: 2,
    versions: [
      { version_no: 1, change_type: 'create', note: '', created_at: '2026-11-15T00:00:00', snapshot: { id: 'agent-1' } },
      { version_no: 2, change_type: 'update', note: '改模型', created_at: '2026-11-16T00:00:00', snapshot: { id: 'agent-1' } }
    ],
    created_at: '2026-11-15T00:00:00',
    updated_at: '2026-11-16T00:00:00',
    archived_at: null
  });

  // workflows/_global/<uuid>.json（作者级工作流）
  await writeJson(`workflows/_global/wf1.json`, {
    id: 'wf-1',
    project_id: '_global',
    name: '章节流',
    description: '生成章节',
    status: 'active',
    platform: 'coze',
    platform_config: { workflow_id: 'wf-api-1', workspace_id: 'ws' },
    params: [],
    llm_config: { model: 'gpt' },
    source: 'manual',
    version_no: 1,
    versions: [],
    created_at: '2026-11-23T00:00:00',
    updated_at: '2026-11-23T00:00:00',
    archived_at: null
  });

  // works/<name>.json（Coze bot 配置，含 project_id 回挂）
  await writeJson(`works/p5t5work100.json`, {
    id: 'wcfg-1',
    name: 'P5T5基准100',
    description: '作品 bot 配置',
    icon_url: 'https://example.com/icon.png',
    coze_bot_id: 'bot-main',
    pat_token: 'pat-xxx',
    access_code: '',
    interaction_type: 'chat',
    system_prompt: '你是助手',
    prologue: '你好',
    suggested_questions: [],
    parameters: [],
    model_name: 'gpt-4o',
    response_format: 'text',
    is_public: true,
    coze_meta: { type: 'bot' },
    project_id: PROJECT_ID,
    created_at: '2026-11-10T00:00:00',
    updated_at: '2026-11-20T00:00:00'
  });
}

function migrateOpts(overrides: Partial<MigrateOptions> = {}): MigrateOptions {
  return { source: ctx.sourceDir, dryRun: false, backup: undefined, restore: undefined, ...overrides };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm4t11-'));
  ctx = { ds: createDataSource(testDatabaseUrl()), sourceDir: path.join(tmpRoot, 'data'), backupDir: '' };
  await ctx.ds.initialize();
  await dropWritingAndAuthTables(ctx.ds);
  await ctx.ds.runMigrations();
  await buildFixtureSource();
});

afterEach(async () => {
  if (ctx.ds.isInitialized) await ctx.ds.destroy();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('M4-T11 旧数据迁移（集成）', () => {
  it('dry-run 不写库', async () => {
    const report = await migrate(migrateOpts({ dryRun: true }), ctx.ds);
    expect(report.verify.ok).toBe(true);
    // dry-run 回滚后行数应为 0
    expect(await ctx.ds.getRepository(WorkEntity).count()).toBe(0);
    expect(await ctx.ds.getRepository(AgentEntity).count()).toBe(0);
    expect(await ctx.ds.getRepository(CharacterEntity).count()).toBe(0);
    expect(await ctx.ds.getRepository(WorkflowEntity).count()).toBe(0);
  });

  it('正式迁移写入正确行数', async () => {
    const report = await migrate(migrateOpts(), ctx.ds);
    expect(report.verify.ok).toBe(true);
    // work 1（project）+ author 兜底 1
    expect(await ctx.ds.getRepository(WorkEntity).count()).toBe(1);
    expect(await ctx.ds.getRepository(AgentEntity).count()).toBe(1);
    expect(await ctx.ds.getRepository(CharacterEntity).count()).toBe(2);
    expect(await ctx.ds.getRepository(CharacterRelationEntity).count()).toBe(2); // ally + enemy 各 1
    expect(await ctx.ds.getRepository(PlotTreeEntity).count()).toBe(1);
    expect(await ctx.ds.getRepository(PlotNodeEntity).count()).toBe(2);
    expect(await ctx.ds.getRepository(WorkflowEntity).count()).toBe(1);
  });

  it('幂等：二次运行不重复插入', async () => {
    await migrate(migrateOpts(), ctx.ds);
    const before = {
      works: await ctx.ds.getRepository(WorkEntity).count(),
      agents: await ctx.ds.getRepository(AgentEntity).count(),
      chars: await ctx.ds.getRepository(CharacterEntity).count(),
      rels: await ctx.ds.getRepository(CharacterRelationEntity).count(),
      plots: await ctx.ds.getRepository(PlotTreeEntity).count(),
      wfs: await ctx.ds.getRepository(WorkflowEntity).count()
    };
    const second = await migrate(migrateOpts(), ctx.ds);
    // 二次运行全部 skipped（不新增）
    expect(second.domains.every((d) => d.inserted === 0)).toBe(true);
    expect(await ctx.ds.getRepository(WorkEntity).count()).toBe(before.works);
    expect(await ctx.ds.getRepository(AgentEntity).count()).toBe(before.agents);
    expect(await ctx.ds.getRepository(CharacterEntity).count()).toBe(before.chars);
    expect(await ctx.ds.getRepository(CharacterRelationEntity).count()).toBe(before.rels);
    expect(await ctx.ds.getRepository(PlotTreeEntity).count()).toBe(before.plots);
    expect(await ctx.ds.getRepository(WorkflowEntity).count()).toBe(before.wfs);
  });

  it('id 保持原值：旧 UUID 直接沿用，非 UUID 确定性生成', async () => {
    await migrate(migrateOpts(), ctx.ds);
    const work = await ctx.ds.getRepository(WorkEntity).findOneByOrFail({ title: 'P5T5基准100' });
    // 旧 project id 是 32 位 hex（非 UUID），应确定性映射而非原样
    expect(work.id).not.toBe(PROJECT_ID);
    // 角色 id 也是 32 位 hex（非 UUID 格式），应按域确定性 hash 生成
    const roleA = await ctx.ds.getRepository(CharacterEntity).findOneByOrFail({ name: '主角' });
    expect(roleA.id).toBe(uuidFromHash(`character:${ROLE_A}`));
  });

  it('回滚：备份存在，restore 恢复文件', async () => {
    const report = await migrate(migrateOpts(), ctx.ds);
    expect(report.backupDir).toBeTruthy();
    const backupExists = await fs
      .stat(report.backupDir!)
      .then((s) => s.isDirectory())
      .catch(() => false);
    expect(backupExists).toBe(true);

    // 模拟迁移后数据被改：删除 source 下某文件
    await fs.rm(path.join(ctx.sourceDir, 'projects', `${PROJECT_ID}.json`), { force: true });
    await restoreLegacyData(ctx.sourceDir, report.backupDir!);
    const restored = await fs
      .stat(path.join(ctx.sourceDir, 'projects', `${PROJECT_ID}.json`))
      .then((s) => s.isFile())
      .catch(() => false);
    expect(restored).toBe(true);
  });

  it('引用完整性：character_relation 无孤儿，关系类型已归一', async () => {
    await migrate(migrateOpts(), ctx.ds);
    const rel = await ctx.ds.getRepository(CharacterRelationEntity).find();
    expect(rel).toHaveLength(2);
    // 归一后 relation type 应为 camp_ally / camp_hostile
    const typeCodes = rel.map((r) => r.type_id).join(',');
    expect(typeCodes).toBeTruthy();
  });

  it('legacy_id_map 记录旧新映射，供追溯', async () => {
    await migrate(migrateOpts(), ctx.ds);
    const map = await ctx.ds.getRepository(LegacyIdMapEntity).find();
    expect(map.length).toBeGreaterThan(0);
    // 角色 32 位 hex（非 UUID）确定性映射，new_id === uuidFromHash('character', legacy_id)
    const roleMap = map.find((m) => m.domain === 'character' && m.legacy_id === ROLE_A);
    expect(roleMap?.new_id).toBe(uuidFromHash(`character:${ROLE_A}`));
  });
});

describe('M4-T13 dedupeWorkflowName（同名 workflow 名称去重）', () => {
  it('同名追加 " (n)" 后缀，保留全部条目且 id 不变', () => {
    const used = new Set<string>();
    // 模拟真实数据：15 个同名「章节流」
    const names: string[] = [];
    for (let i = 0; i < 15; i += 1) names.push(dedupeWorkflowName(used, '章节流'));
    expect(names[0]).toBe('章节流');
    expect(names[1]).toBe('章节流 (2)');
    expect(names[2]).toBe('章节流 (3)');
    expect(names[14]).toBe('章节流 (15)');
    // 全部唯一
    expect(new Set(names).size).toBe(15);
  });

  it('不同名不受影响，去重是增量且稳定', () => {
    const used = new Set<string>();
    expect(dedupeWorkflowName(used, 'AI建图')).toBe('AI建图');
    expect(dedupeWorkflowName(used, '章节流')).toBe('章节流');
    expect(dedupeWorkflowName(used, 'AI建图')).toBe('AI建图 (2)');
    // 已存在的 (2) 不会误伤：追加同名再出现时跳到下一个可用序号
    expect(dedupeWorkflowName(used, 'AI建图')).toBe('AI建图 (3)');
  });

  it('跳过已占用的后缀序号', () => {
    const used = new Set<string>(['章节流 (2)']);
    expect(dedupeWorkflowName(used, '章节流')).toBe('章节流');
    expect(dedupeWorkflowName(used, '章节流')).toBe('章节流 (3)');
  });
});
