import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本地全量/分阶段执行需要 .env；报告聚合模式只读证据文件，不依赖 node_modules。
// 旧 Python 链路（Flask / pytest / legacy 作业）已于 M4-T14 归零；CI 门禁现为纯 Node 质量链。
if (process.env.M1_REPORT_ONLY !== '1') {
  try {
    await import('dotenv/config');
  } catch {
    // 未安装 dotenv 时忽略：CI 环境变量已由作业级 env 提供
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = join(root, 'test-results', 'm1-evidence');
const reportPath = join(root, 'docs', '05-测试与验收报告', 'M1写作基座验收报告.md');
const postgresVersionPath = join(evidenceDirectory, 'postgres-version.txt');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge_test';

// CI 并行化支持：
// - M1_STAGES=quality,unit-test 只在当前作业执行指定检查项，日志格式与全量运行完全一致；
// - M1_REPORT_ONLY=1 只聚合各作业上传的证据并渲染报告，不重复执行任何检查。
const reportOnly = process.env.M1_REPORT_ONLY === '1';
const requestedStages = (process.env.M1_STAGES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const databaseStageIds = new Set(['docker', 'migration-fresh', 'migration-second', 'knowledge-migration', 'browser', 'database-failure']);

mkdirSync(evidenceDirectory, { recursive: true });
if (!reportOnly) mkdirSync(dirname(reportPath), { recursive: true });

function fatal(message) {
  console.error(message);
  process.exit(1);
}
function execute(command, args, env = process.env) {
  return spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
    // Node 22 禁止直接 spawn Windows 的 .cmd 文件；交给 shell 解析 pnpm
    shell: process.platform === 'win32'
  });
}
function requiredOutput(command, args) {
  const result = execute(command, args);
  if (result.status !== 0) throw new Error(`Unable to collect ${args.join(' ')}`);
  return result.stdout.trim();
}
function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// 检查项清单：本地全量验收顺序；CI 中按作业拆分执行，报告顺序与此一致
const allChecks = [
  { id: 'docker', label: 'PostgreSQL 16 测试服务', command: 'docker', args: ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', 'postgres', '--wait'] },
  { id: 'quality', label: '静态质量门禁（lint / typecheck / build）', command: pnpm, args: ['run', 'quality'] },
  { id: 'unit-test', label: '单元与 API E2E 测试', command: pnpm, args: ['run', 'test'] },
  { id: 'migration-fresh', label: '测试库清表与完整显式迁移', command: pnpm, args: ['--filter', '@storyforge/api', 'test:prepare'], env: undefined },
  { id: 'migration-second', label: '显式迁移幂等重跑', command: pnpm, args: ['--filter', '@storyforge/api', 'migration:run'], env: undefined },
  { id: 'knowledge-migration', label: 'M3c-3 知识库迁移双跑（空库 + 存量库 up/down + 结构断言）', command: pnpm, args: ['--filter', '@storyforge/api', 'exec', 'tsx', 'src/database/verify-knowledge-migrations.ts'], env: undefined },
  { id: 'browser', label: 'M0/M1 Chromium 浏览器验收', command: pnpm, args: ['test:e2e'], env: undefined },
  { id: 'database-failure', label: '保存中行锁等待与数据库重启', command: 'node', args: ['scripts/verify-m1-db-failure.mjs'], env: undefined }
];

const unknownStages = requestedStages.filter((id) => !allChecks.some((check) => check.id === id));
if (unknownStages.length > 0) {
  fatal(`Unknown M1_STAGES: ${unknownStages.join(', ')}；可用值：${allChecks.map((check) => check.id).join(', ')}`);
}

const selectedChecks = reportOnly
  ? allChecks
  : requestedStages.length > 0
    ? allChecks.filter((check) => requestedStages.includes(check.id))
    : allChecks;
const touchesDatabase = !reportOnly && selectedChecks.some((check) => databaseStageIds.has(check.id));

if (touchesDatabase) {
  if (process.env.M1_ALLOW_DATABASE_RESTART !== '1') {
    fatal('M1 verification requires M1_ALLOW_DATABASE_RESTART=1 for the disposable test database service');
  }
  if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
    fatal('TEST_DATABASE_URL must end in _test');
  }
}

const testEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
  M1_ALLOW_DATABASE_RESTART: '1'
};
const stageChecks = selectedChecks.map((check) =>
  check.env === undefined && databaseStageIds.has(check.id) ? { ...check, env: testEnv } : check
);

async function collectPostgresVersion() {
  try {
    const apiRequire = createRequire(join(root, 'apps/api', 'package.json'));
    const { Client } = apiRequire('pg');
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const version = await client.query('SHOW server_version');
      const value = String(version.rows[0].server_version);
      writeFileSync(postgresVersionPath, `${value}\n`, 'utf8');
      return value;
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch {
    return '查询失败';
  }
}

const results = [];
if (reportOnly) {
  // 只读各并行作业已上传的证据日志，缺失即视为失败，避免报告在证据不全时“假通过”
  for (const check of allChecks) {
    const logPath = join(evidenceDirectory, `${check.id}.log`);
    if (!existsSync(logPath)) {
      results.push({ ...check, exitCode: 1, output: `${check.id}.log 证据缺失：对应 CI 作业未执行或未上传产物` });
      continue;
    }
    const output = readFileSync(logPath, 'utf8');
    const matched = output.match(/^exit_code=(\d+)$/m);
    results.push({ ...check, exitCode: matched ? Number(matched[1]) : 1, output });
  }
} else {
  for (const check of stageChecks) {
    const completed = execute(check.command, check.args, check.env ?? process.env);
    // Windows 下 pnpm 是 .cmd，需由 shell 解析
    const output = [completed.stdout, completed.stderr].filter(Boolean).join('\n');
    const exitCode = completed.status ?? 1;
    writeFileSync(
      join(evidenceDirectory, `${check.id}.log`),
      `$ ${check.command} ${check.args.join(' ')}\nexit_code=${exitCode}\n${output}`,
      'utf8'
    );
    if (output) process.stdout.write(`${output}\n`);
    results.push({ ...check, exitCode, output });
    if (exitCode !== 0) break;
  }
}

let postgresVersion = '查询失败';
if (reportOnly) {
  postgresVersion = existsSync(postgresVersionPath) ? readFileSync(postgresVersionPath, 'utf8').trim() : '查询失败';
} else if (results.some((result) => result.id === 'docker' && result.exitCode === 0)) {
  postgresVersion = await collectPostgresVersion();
}

// 分阶段执行（CI 并行作业）只关心本作业的结果，不渲染整份报告；汇总报告由 M1_REPORT_ONLY 作业统一生成
if (!reportOnly) {
  const failed = results.find((result) => result.exitCode !== 0);
  const summary = results.map((result) => `${result.id}=${result.exitCode}`).join(', ');
  if (requestedStages.length > 0) {
    console.info(`M1 stage verification: ${summary}`);
    process.exitCode = failed ? 1 : 0;
  } else {
    console.info(`M1 checks: ${summary}`);
    if (failed) {
      console.info(`M1 full run stopped at ${failed.id}`);
      process.exitCode = 1;
    }
    await renderReport();
  }
} else {
  await renderReport();
}

async function renderReport() {
  const revision = requiredOutput('git', ['rev-parse', 'HEAD']);
  let pnpmVersion;
  try {
    pnpmVersion = requiredOutput(pnpm, ['--version']);
  } catch {
    // 某些 Windows 终端无法在子进程里解析 pnpm.cmd，退回 package.json 中锁定的版本
    const manager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager;
    pnpmVersion = String(manager ?? '').split('@')[1] ?? 'unknown';
  }

  const databasePassed = postgresVersion.startsWith('16.');
  const repeatedMigration = results.find((result) => result.id === 'migration-second');
  const repeatedMigrationPassed = repeatedMigration?.exitCode === 0
    && repeatedMigration.output.includes('No migrations are pending');
  const performancePath = join(evidenceDirectory, 'performance.json');
  const databaseFailurePath = join(evidenceDirectory, 'db-failure.json');
  const performance = existsSync(performancePath) ? json(performancePath) : undefined;
  const databaseFailure = existsSync(databaseFailurePath) ? json(databaseFailurePath) : undefined;
  const performancePassed = performance?.schema_version === 1
    && performance.m5_gate_claimed === false
    && performance.hardware?.cpu_model
    && performance.browser?.version
    && performance.dataset?.initial_characters === 10_000
    && performance.network?.included === true
    && performance.metrics?.input_wall_ms?.samples?.length === 20
    && performance.metrics?.chapter_open_wall_ms?.samples?.length === 5;
  const databaseFailurePassed = databaseFailure?.passed === true
    && databaseFailure.row_lock_observed === true
    && databaseFailure.database_restarted_while_save_waiting === true
    && databaseFailure.after_failure?.version === 0
    && databaseFailure.after_failure?.chapter_changes === 0
    && databaseFailure.retry?.server_version === 1
    && databaseFailure.idempotent_replay?.chapter_changes === 1;
  const toolchainPassed = process.version === 'v22.16.0' && pnpmVersion === '10.12.4';
  const allPassed = results.length === allChecks.length
    && results.every((result) => result.exitCode === 0)
    && repeatedMigrationPassed
    && databasePassed
    && performancePassed
    && databaseFailurePassed
    && toolchainPassed;
  const browserResult = results.find((result) => result.id === 'browser');
  const browserPassed = browserResult?.exitCode === 0;
  // 只有真正执行过的验收才标记通过/未通过，前置步骤失败导致的跳过必须显示“未执行”
  const browserLabel = browserResult ? (browserPassed ? '通过' : '未通过') : '未执行';
  const databaseFailureLabel = !databaseFailure ? '未执行'
    : databaseFailurePassed ? '通过；无半提交，重试和幂等重放均为一个版本/一条变更' : '未通过';
  const blocked = results.find((result) => result.exitCode !== 0);

  const report = [
    '# M1 写作基座验收报告',
    '',
    `> 状态：${allPassed ? '通过' : '未通过'}`,
    `> 生成时间：${new Date().toISOString()}`,
    '',
    '## 环境与基线',
    '',
    '| 项目 | 实测值 |',
    '| --- | --- |',
    `| Git 验收基线（Task 14 提交前 HEAD） | \`${revision}\` |`,
    `| Node.js / pnpm | \`${process.version}\` / \`${pnpmVersion}\` |`,
    `| PostgreSQL | \`${postgresVersion}\` |`,
    `| 重复显式迁移 | ${repeatedMigrationPassed ? 'No migrations are pending' : '未确认'} |`,
    '',
    '## 命令结果',
    '',
    '| 验收项 | 命令 | 退出码 | 本地证据 |',
    '| --- | --- | ---: | --- |',
    ...results.map((result) => `| ${result.label} | \`${result.command} ${result.args.join(' ')}\` | ${result.exitCode} | \`test-results/m1-evidence/${result.id}.log\` |`),
    '',
    '## 写作、恢复与冲突验收',
    '',
    `- 作品创建、富文本/Markdown、自动保存、深链和 WAL 导出：${browserLabel}。`,
    `- 真实 Chromium 进程崩溃后 IndexedDB pending 恢复：${browserLabel}。`,
    `- 409 三方正文保留、人工选择、多标签 TTL/fencing：${browserLabel}。`,
    `- 断网、非法 Markdown、配额、WAL 损坏和服务端恢复：${browserLabel}。`,
    `- 375/768/1024/1440、键盘/dialog 焦点及 axe-core：${browserLabel}。`,
    `- 保存事务等待真实行锁时重启 PostgreSQL：${databaseFailureLabel}。`,
    ...(blocked ? ['', '## 阻塞原因', '', `\`${blocked.command} ${blocked.args.join(' ')}\` 退出码 ${blocked.exitCode}：${cell(blocked.output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') || '无输出')}`] : []),
    '',
    '## M1 性能基线（不是 M5 门槛结论）',
    '',
    '| 项目 | 实测值 |',
    '| --- | --- |',
    `| 硬件 | ${performance ? cell(`${performance.hardware.cpu_model}; ${performance.hardware.logical_cpus} logical CPUs; ${performance.hardware.memory_bytes} bytes; ${performance.hardware.platform} ${performance.hardware.release}`) : '未采集'} |`,
    `| 浏览器 | ${performance ? cell(`${performance.browser.name} ${performance.browser.version}`) : '未采集'} |`,
    `| 数据集 | ${performance ? cell(JSON.stringify(performance.dataset)) : '未采集'} |`,
    `| 是否含网络 | ${performance ? cell(`${performance.network.included}; ${performance.network.kind}`) : '未采集'} |`,
    `| 输入 wall time P95 | ${performance ? `${performance.metrics.input_wall_ms.p95} ms（含 Playwright 协议，不是 M5 Event Timing 门槛）` : '未采集'} |`,
    `| 打开章节 wall time P95 | ${performance ? `${performance.metrics.chapter_open_wall_ms.p95} ms（含回环网络）` : '未采集'} |`,
    '',
    'M1 不宣称千级章节导航虚拟化、最新两个主版本四浏览器兼容或 M5 正式性能/发布门槛已经完成。上述数值只用于后续里程碑对比。',
    '',
    '## 边界确认',
    '',
    '- ProseMirror JSON 是唯一正文；Markdown 经共享白名单转换；服务端在行锁事务内按 change_id 幂等保存。',
    '- 本地 WAL 只确认连续边界；409 不静默覆盖；租约为 15 秒 TTL、5 秒 heartbeat，并使用 fencing token。',
    '- 旧 Flask、JSON 业务数据和旧 UI 已迁移归零；唯一写入方为 NestJS（PG），旧 Python 链路已下线。',
    '- M2+ 修订、评论、AI、剧情、知识库和旧数据切换均不属于本次通过范围。',
    ''
  ].join('\n');
  writeFileSync(reportPath, report, 'utf8');
  console.info(`M1 verification report: ${reportPath}`);
  if (!allPassed) process.exitCode = 1;
}
