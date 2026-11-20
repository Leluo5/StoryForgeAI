#!/usr/bin/env node
/**
 * CI 免费额度用量统计与预警
 *
 * 用法：
 *   node scripts/ci-billing.mjs [--repo owner/name] [--limit 2000] [--warn 0.7] [--fail 0.85] [--json]
 *
 * 认证：优先 GH_TOKEN / GITHUB_TOKEN，否则回退 `gh auth token`（本地使用）。
 * 数据：GitHub Actions jobs API；计费分钟按“每个作业耗时向上取整到分钟”估算，
 *       与 GitHub 对私有仓库的计费口径一致。
 * 退出码：0=正常；1=达到 fail 阈值（用于定时任务告警）；2=缺少凭证或接口失败。
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const repo = arg('repo', process.env.GITHUB_REPOSITORY ?? 'Leluo5/StoryForgeAI');
const limit = Number(arg('limit', process.env.CI_FREE_MINUTES ?? '2000'));
const warnRatio = Number(arg('warn', '0.7'));
const failRatio = Number(arg('fail', '0.85'));
const asJson = argv.includes('--json');

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const token = resolveToken();
if (!token) {
  console.error('缺少 GitHub 凭证：请设置 GH_TOKEN/GITHUB_TOKEN，或先执行 gh auth login');
  process.exit(2);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'storyforge-ci-billing'
};

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${path} -> HTTP ${response.status}`);
  return response.json();
}

function minutes(ms) {
  return Math.ceil(ms / 60_000);
}

async function collectRuns(since) {
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await api(`/repos/${repo}/actions/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`);
    runs.push(...data.workflow_runs);
    if (runs.length >= data.total_count || data.workflow_runs.length < 100) break;
  }
  return runs;
}

async function main() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = monthStart.toISOString().slice(0, 10);

  const runs = await collectRuns(since);
  const completed = runs.filter((run) => run.status === 'completed');

  let billableMinutes = 0;
  const byWorkflow = new Map();
  const recent = [];

  for (const run of completed) {
    // 单次作业计费向上取整到分钟；timing API 对部分仓库返回 0，这里改为按 job 起止时间累加
    let cost = 0;
    try {
      const jobs = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      for (const job of jobs.jobs ?? []) {
        if (!job.started_at) continue;
        const endedAt = job.completed_at ? new Date(job.completed_at).getTime() : Date.now();
        cost += minutes(Math.max(0, endedAt - new Date(job.started_at).getTime()));
      }
    } catch {
      // 单个运行的 job 列表不可用时跳过，不影响整体统计
    }
    billableMinutes += cost;
    byWorkflow.set(run.name, (byWorkflow.get(run.name) ?? 0) + cost);

    const wallMs = new Date(run.updated_at).getTime() - new Date(run.created_at).getTime();
    recent.push({
      id: run.id,
      name: run.name,
      event: run.event,
      branch: run.head_branch,
      conclusion: run.conclusion,
      wall_seconds: Math.max(0, Math.round(wallMs / 1000)),
      billable_minutes: cost
    });
  }

  const ratio = limit > 0 ? billableMinutes / limit : 0;
  const level = ratio >= failRatio ? 'critical' : ratio >= warnRatio ? 'warning' : 'ok';

  const summary = {
    repo,
    month: since.slice(0, 7),
    runs: completed.length,
    billable_minutes: billableMinutes,
    free_minutes: limit,
    usage_ratio: Number(ratio.toFixed(3)),
    remaining_minutes: Math.max(0, limit - billableMinutes),
    level,
    by_workflow: Object.fromEntries([...byWorkflow.entries()].sort((a, b) => b[1] - a[1])),
    recent_runs: recent.slice(0, 10)
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const lines = [
      `## CI 免费额度用量（${summary.month}）`,
      '',
      '| 指标 | 数值 |',
      '| --- | --- |',
      `| 仓库 | ${repo} |`,
      `| 已完成运行次数 | ${summary.runs} |`,
      `| 计费分钟（估算） | ${summary.billable_minutes} / ${limit} |`,
      `| 使用率 | ${(ratio * 100).toFixed(1)}% |`,
      `| 剩余额度 | ${summary.remaining_minutes} 分钟 |`,
      '',
      '### 按工作流拆分',
      '',
      '| 工作流 | 计费分钟 |',
      '| --- | ---: |',
      ...Object.entries(summary.by_workflow).map(([name, value]) => `| ${name} | ${value} |`),
      '',
      '### 最近 10 次运行（墙钟时长 / 计费）',
      '',
      '| 运行 | 事件 | 分支 | 结论 | 墙钟秒 | 计费分钟 |',
      '| --- | --- | --- | --- | ---: | ---: |',
      ...recent.slice(0, 10).map(
        (run) => `| ${run.name} | ${run.event} | ${run.branch} | ${run.conclusion} | ${run.wall_seconds} | ${run.billable_minutes} |`
      ),
      ''
    ];
    const output = lines.join('\n');
    console.log(output);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${output}\n`);
    }
  }

  if (level === 'critical') {
    console.error(`CI 免费额度使用率 ${(ratio * 100).toFixed(1)}% 已超过 ${(failRatio * 100).toFixed(0)}% 告警线，请立即收敛 CI 触发范围或申请额度。`);
    process.exit(1);
  }
  if (level === 'warning') {
    console.warn(`CI 免费额度使用率 ${(ratio * 100).toFixed(1)}% 已超过 ${(warnRatio * 100).toFixed(0)}% 预警线。`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
