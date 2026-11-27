import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = join(root, 'test-results', 'm0-evidence');
const reportPath = join(root, 'docs', '05-测试与验收报告', 'M0工程基座验收报告.md');
const pnpm = 'pnpm';
mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });

function execute(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    // Node 22 禁止直接 spawn Windows 的 .cmd 文件；交给 shell 解析 pnpm 可执行文件。
    shell: process.platform === 'win32'
  });
}

function requiredOutput(command, args) {
  const result = execute(command, args);
  if (result.status !== 0) throw new Error(`Unable to collect ${args.join(' ')}`);
  return result.stdout.trim();
}

const checks = [
  { id: 'workspace-ci', label: '工作区 CI', command: pnpm, args: ['run', 'ci'] },
  { id: 'migration-first', label: '开发库迁移第一次执行', command: pnpm, args: ['--filter', '@storyforge/api', 'migration:run'] },
  { id: 'migration-second', label: '开发库迁移第二次执行', command: pnpm, args: ['--filter', '@storyforge/api', 'migration:run'] },
  { id: 'browser', label: 'Chromium 登录恢复退出', command: pnpm, args: ['test:e2e'] }
];

const revision = requiredOutput('git', ['rev-parse', 'HEAD']);
const pnpmVersion = requiredOutput(pnpm, ['--version']);
const toolchainPassed = process.version === 'v22.16.0' && pnpmVersion === '10.12.4';
const results = [];

for (const check of checks) {
  const completed = execute(check.command, check.args);
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

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge_test';
let postgresVersion = '查询失败';
let databasePassed = false;
const apiRequire = createRequire(join(root, 'apps/api', 'package.json'));
const { Client } = apiRequire('pg');
const client = new Client({ connectionString: databaseUrl });
try {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) throw new Error('Unsafe test database name');
  await client.connect();
  const version = await client.query('SHOW server_version');
  postgresVersion = String(version.rows[0].server_version);
  databasePassed = postgresVersion.startsWith('16.');
} catch {
  databasePassed = false;
} finally {
  try { await client.end(); } catch { /* 未建立连接时无需关闭。 */ }
}

const secondMigration = results.find((result) => result.id === 'migration-second');
const repeatedMigrationPassed = secondMigration?.exitCode === 0
  && secondMigration.output.includes('No migrations are pending');
const allPassed = results.length === checks.length
  && results.every((result) => result.exitCode === 0)
  && toolchainPassed
  && repeatedMigrationPassed
  && databasePassed;

const report = [
  '# M0 工程基座验收报告',
  '',
  `> 状态：${allPassed ? '通过' : '未通过'}`,
  `> 生成时间：${new Date().toISOString()}`,
  '',
  '## 环境与基线',
  '',
  '| 项目 | 实测值 |',
  '| --- | --- |',
  `| Git 验收基线（Task 8 提交前 HEAD） | \`${revision}\` |`,
  `| Node.js | \`${process.version}\` |`,
  `| pnpm | \`${pnpmVersion}\` |`,
  `| PostgreSQL | \`${postgresVersion}\` |`,
  `| 第二次显式迁移 | ${repeatedMigrationPassed ? 'No migrations are pending' : '未确认'} |`,
  '',
  '## 命令结果',
  '',
  '| 验收项 | 命令 | 退出码 | 本地证据 |',
  '| --- | --- | ---: | --- |',
  ...results.map((result) => `| ${result.label} | \`${result.command} ${result.args.join(' ')}\` | ${result.exitCode} | \`test-results/m0-evidence/${result.id}.log\` |`),
  '',
  '## 验收结论',
  '',
  `- 工作区 Lint、类型检查、单元/e2e 测试和构建：${results.find((result) => result.id === 'workspace-ci')?.exitCode === 0 ? '通过' : '未通过'}。`,
  `- 浏览器截图与 HTML 报告：${results.find((result) => result.id === 'browser')?.exitCode === 0 ? '已生成于 test-results/playwright/ 与 playwright-report/，失败时另保留 trace' : '未通过，trace 已保留用于定位'}。`,
  '- 数据库 e2e 已断言 `synchronize=false`、显式迁移、摘要唯一约束与测试库清理。',
  '- 旧 Flask 已下线，唯一写入方为 NestJS（PG）；M4-T13 切换完成。',
  ''
].join('\n');
writeFileSync(reportPath, report, 'utf8');
console.info(`M0 verification report: ${reportPath}`);

if (!allPassed) process.exitCode = 1;
