import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { DataSource } from 'typeorm';
import { AppDataSource } from './data-source';
import { ensureLegacyAuthor, migrateWorks } from './legacy-mappers/work.mapper';
import { migrateAgents } from './legacy-mappers/agent.mapper';
import { migrateCharacters } from './legacy-mappers/character.mapper';
import { migratePlots } from './legacy-mappers/plot.mapper';
import { migrateWorkflows } from './legacy-mappers/workflow.mapper';
import { verifyMigration, type VerifyReport } from './legacy-verify';

// M4-T11 旧数据分类映射与迁移脚本。
// CLI 入口：tsx apps/api/src/database/migrate-legacy-data.ts [--dry-run] [--source <dir>] [--backup <dir>] [--restore <dir>]
// 时序约束（方案 R6）：正式迁移须在 M4-T13 P0 冻结后；dry-run 可提前任意时刻。
// 边界安全：备份自动、幂等去重、父域先迁、禁 synchronize、dry-run 不写库、每域一事务、失败退出非 0。

export interface MigrateOptions {
  source: string;
  backup: string | undefined;
  dryRun: boolean;
  restore: string | undefined;
}

export interface DomainResult {
  domain: string;
  inserted: number;
  skipped: number;
  detail: Record<string, number>;
}

export interface MigrateReport {
  domains: DomainResult[];
  verify: VerifyReport;
  backupDir: string | undefined;
}

function parseArgs(argv: string[]): MigrateOptions {
  const opts: MigrateOptions = { source: './data', dryRun: false, backup: undefined, restore: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--source') opts.source = argv[++i] ?? opts.source;
    else if (arg === '--backup') opts.backup = argv[++i];
    else if (arg === '--restore') opts.restore = argv[++i];
  }
  return opts;
}

/** 递归复制目录（备份 data/） */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(srcPath, destPath);
    else if (entry.isFile()) await fs.copyFile(srcPath, destPath);
  }
}

/** 备份 data/ 到 backupDir，返回目标路径 */
export async function backupLegacyData(source: string, backupDir?: string): Promise<string> {
  if (!backupDir) {
    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    backupDir = `${source.replace(/[\\/]$/, '')}.backup-${ts}`;
  }
  await copyDir(source, backupDir);
  return backupDir;
}

/** 恢复备份：将 backupDir 内容覆盖回 source */
export async function restoreLegacyData(source: string, backupDir: string): Promise<void> {
  const stat = await fs.stat(backupDir);
  if (!stat.isDirectory()) throw new Error(`备份目录不存在: ${backupDir}`);
  // 覆盖式恢复：先清空 source，再复制 backup 内容
  await fs.rm(source, { recursive: true, force: true });
  await fs.mkdir(source, { recursive: true });
  await copyDir(backupDir, source);
}

/** 主迁移流程 */
export async function migrate(
  opts: MigrateOptions,
  dataSource: DataSource = AppDataSource
): Promise<MigrateReport> {
  // 1. 备份（正式执行才备份）
  let backupDir: string | undefined;
  if (!opts.dryRun) {
    backupDir = await backupLegacyData(opts.source, opts.backup);
  }

  // 2. 域定义（父域先迁：author 兜底 → work → agent → character → plot → workflow）
  const domains: Array<{
    domain: string;
    runner: (tx: typeof dataSource.manager) => Promise<{
      inserted: number;
      skipped: number;
      detail: Record<string, number>;
    }>;
  }> = [
    {
      domain: 'work',
      runner: async (tx) => {
        await ensureLegacyAuthor(tx);
        const r = await migrateWorks(tx, opts.source);
        return {
          inserted: r.works,
          skipped: r.skipped,
          detail: { works: r.works, volumes: r.volumes, chapters: r.chapters }
        };
      }
    },
    {
      domain: 'agent',
      runner: async (tx) => {
        const authorId = await ensureLegacyAuthor(tx);
        const r = await migrateAgents(tx, opts.source, authorId);
        return {
          inserted: r.agents,
          skipped: r.skipped,
          detail: { agents: r.agents, versions: r.versions }
        };
      }
    },
    {
      domain: 'character',
      runner: async (tx) => {
        const r = await migrateCharacters(tx, opts.source);
        return {
          inserted: r.characters,
          skipped: r.skipped,
          detail: {
            characters: r.characters,
            relations: r.relations,
            relationTypes: r.relationTypes
          }
        };
      }
    },
    {
      domain: 'plot',
      runner: async (tx) => {
        const r = await migratePlots(tx, opts.source);
        return {
          inserted: r.trees,
          skipped: r.skipped,
          detail: { trees: r.trees, nodes: r.nodes, links: r.links, undetermined: r.undetermined }
        };
      }
    },
    {
      domain: 'workflow',
      runner: async (tx) => {
        const author = await ensureLegacyAuthor(tx);
        const r = await migrateWorkflows(tx, opts.source, author);
        return {
          inserted: r.workflows,
          skipped: r.skipped,
          detail: { workflows: r.workflows }
        };
      }
    }
  ];

  const report: MigrateReport = {
    domains: [],
    verify: { ok: true, errors: [], rows: {} },
    backupDir: undefined
  };

  if (opts.dryRun) {
    // dry-run：单事务执行全部域后统一回滚（跨域 FK 引用需在回滚前可见），仅统计不写库。
    const stats = await dataSource
      .transaction(async (tx) => {
        const results: DomainResult[] = [];
        for (const d of domains) {
          const s = await d.runner(tx);
          results.push({ domain: d.domain, ...s });
        }
        // 强制回滚：抛特殊标记携带统计
        throw { __rollback: true, results };
      })
      .catch((e) => {
        if (e && (e as { __rollback?: boolean }).__rollback) {
          return (e as { results: DomainResult[] }).results;
        }
        throw e;
      });
    report.domains.push(...stats);
  } else {
    // 正式：每域一事务，失败回滚该域，退出非 0（由调用方抛错）
    for (const d of domains) {
      const s = await dataSource.transaction((tx) => d.runner(tx));
      report.domains.push({ domain: d.domain, ...s });
    }
  }

  // 3. 校验（dry-run 仅查引用完整性，跳过行数对比；正式迁移两者都查，失败抛错）
  report.verify = await verifyMigration(dataSource, opts.source, !opts.dryRun);
  report.backupDir = backupDir;
  if (!report.verify.ok && !opts.dryRun) {
    throw new Error(`迁移校验失败: ${report.verify.errors.join('; ')}`);
  }
  return report;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.restore) {
    await restoreLegacyData(opts.source, opts.restore);
    console.log(`[restore] 已从 ${opts.restore} 恢复到 ${opts.source}`);
    return;
  }

  await AppDataSource.initialize();
  try {
    const report = await migrate(opts);
    if (opts.dryRun) {
      console.log('[dry-run] 未写入数据库，以下为将迁移的统计：');
    } else {
      console.log(`[migrate] 备份目录: ${report.backupDir}`);
    }
    for (const d of report.domains) {
      console.log(
        `[migrate] ${d.domain}: ${d.inserted} inserted, ${d.skipped} skipped, ${JSON.stringify(d.detail)}`
      );
    }
    console.log(`[verify] ok=${report.verify.ok} rows=${JSON.stringify(report.verify.rows)}`);
    if (!report.verify.ok) {
      console.error('[verify] errors:');
      for (const e of report.verify.errors) console.error(`  - ${e}`);
    }
  } finally {
    await AppDataSource.destroy();
  }
}

// 直接运行入口（非 import 时执行）
if (require.main === module) {
  main().catch((e) => {
    console.error('[migrate] 失败:', e);
    process.exitCode = 1;
  });
}
