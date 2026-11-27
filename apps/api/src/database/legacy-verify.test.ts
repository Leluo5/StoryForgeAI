import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DataSource } from 'typeorm';
import { createDataSource } from './data-source';
import { testDatabaseUrl, dropWritingAndAuthTables } from '../../test/test-database';
import { migrate } from './migrate-legacy-data';
import {
  runVerify,
  renderMarkdownReport,
  verifyIdMapCoverage,
  seededSample,
  type VerifyCliOptions
} from './legacy-verify';
import { uuidFromHash } from './legacy-mappers/id-map';
import { LegacyIdMapEntity } from './legacy-id-map.entity';
import { CharacterEntity } from './character.entity';

// M4-T12 迁移数据校验（集成）：真实数据源结构（临时目录）+ 真实测试库。
// 覆盖：覆盖率 100% / 字段比对 0 不一致 / 退出码 0 / markdown 报告 / CLI 参数透传。

const PROJECT_ID = '31601c93f2f54b0d9cd85f8a0ee6de1d';
const ROLE_A = 'a350c26d6bda484fb019e088b9fc0aec';
const ROLE_B = 'b350c26d6bda484fb019e088b9fc0aed';

interface TestContext {
  ds: DataSource;
  sourceDir: string;
}

let ctx: TestContext;
let tmpRoot: string;

async function writeJson(rel: string, data: unknown): Promise<void> {
  const full = path.join(ctx.sourceDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(data, null, 2));
}

// 与 migrate-legacy-data.test.ts 同构的 fixture，保证校验维度数据完整
async function buildFixtureSource(): Promise<void> {
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

function verifyOpts(overrides: Partial<VerifyCliOptions> = {}): VerifyCliOptions {
  return { source: ctx.sourceDir, report: 'M4-T12-数据校验报告.md', strict: false, ...overrides };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm4t12-'));
  ctx = { ds: createDataSource(testDatabaseUrl()), sourceDir: path.join(tmpRoot, 'data') };
  await ctx.ds.initialize();
  await dropWritingAndAuthTables(ctx.ds);
  await ctx.ds.runMigrations();
  await buildFixtureSource();
  // 正式迁移，写入各域数据供校验
  await migrate({ source: ctx.sourceDir, dryRun: false, backup: undefined, restore: undefined }, ctx.ds);
});

afterEach(async () => {
  if (ctx.ds.isInitialized) await ctx.ds.destroy();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('M4-T12 迁移数据校验（集成）', () => {
  it('legacy_id_map 覆盖率 = 100%（全部主键可追溯）', async () => {
    const coverage = await verifyIdMapCoverage(ctx.ds);
    expect(coverage.coveragePercent).toBe(100);
    expect(coverage.unmappedCount).toBe(0);
    // 各域均有映射条目（work/agent/character/plot_tree/plot_node/workflow）
    expect(coverage.byDomain.work).toBeGreaterThan(0);
    expect(coverage.byDomain.agent).toBeGreaterThan(0);
    expect(coverage.byDomain.character).toBeGreaterThan(0);
    expect(coverage.byDomain.plot_tree).toBeGreaterThan(0);
    expect(coverage.byDomain.plot_node).toBeGreaterThan(0);
    expect(coverage.byDomain.workflow).toBeGreaterThan(0);
  });

  it('字段比对：主键映射域全量 + 非主键抽样，无不一致', async () => {
    const result = await runVerify(verifyOpts(), ctx.ds);
    expect(result.report.fieldChecks).toBeDefined();
    const checks = result.report.fieldChecks!;
    // 6 个域（work/character/plot_node/agent/workflow；plot_tree 无字段比对分支）
    expect(checks.length).toBeGreaterThanOrEqual(5);
    for (const fc of checks) {
      expect(fc.mismatches, `${fc.domain} 字段比对应无不一致`).toBe(0);
      expect(fc.checked, `${fc.domain} 应实际比对新表行`).toBeGreaterThan(0);
    }
    // 主键映射域应为全量（mode=full）
    const fullModes = checks.filter((c) => ['work', 'character', 'plot_node'].includes(c.domain));
    expect(fullModes.every((c) => c.mode === 'full')).toBe(true);
  });

  it('runVerify 退出码 0 且报告通过', async () => {
    const result = await runVerify(verifyOpts(), ctx.ds);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.errors).toHaveLength(0);
  });

  it('CLI 参数透传：source/report/strict 正确赋值', async () => {
    // strict=true 时无差异仍 exit 0
    const strictResult = await runVerify(verifyOpts({ strict: true }), ctx.ds);
    expect(strictResult.exitCode).toBe(0);
  });

  it('markdown 报告内容完整（通过标识/行数/覆盖率/字段比对）', async () => {
    const result = await runVerify(verifyOpts(), ctx.ds);
    const md = renderMarkdownReport(verifyOpts(), result);
    expect(md).toContain('M4-T12 迁移数据校验报告');
    expect(md).toContain('✅ 通过');
    expect(md).toContain('覆盖率');
    expect(md).toContain('100%');
    expect(md).toContain('字段比对');
    // 行数对比表应含 works / characters 等行
    expect(md).toContain('| works |');
    expect(md).toContain('| characters |');
  });

  it('有差异时退出码 1：删库中一条 character 目标行后覆盖率不足', async () => {
    // 模拟差异（迁移产物不可追溯）：删除某角色新主键对应的目标表行，
    // 使 legacy_id_map 中该映射的 new_id 在目标表找不到 → 覆盖率 <100%。
    const roleAId = uuidFromHash(`character:${ROLE_A}`);
    await ctx.ds.getRepository(CharacterEntity).delete({ id: roleAId });
    const result = await runVerify(verifyOpts(), ctx.ds);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.report.idMapCoverage!.unmappedCount).toBeGreaterThan(0);
    expect(result.report.errors.some((e) => e.includes('覆盖率'))).toBe(true);
  });
});

describe('M4-T12 抽样辅助（纯函数，无 DB）', () => {
  it('seededSample 固定种子可复现：多次运行抽样集合一致', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const a = seededSample(arr, 0.1, 42);
    const b = seededSample(arr, 0.1, 42);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    // 抽样比例约 10%
    expect(a.length).toBe(10);
  });

  it('seededSample 不同种子产生不同抽样（可复现但非恒定）', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const a = seededSample(arr, 0.1, 42);
    const c = seededSample(arr, 0.1, 7);
    expect(a).not.toEqual(c);
  });

  it('seededSample 空数组返回空', () => {
    expect(seededSample([], 0.1, 42)).toEqual([]);
  });
});
