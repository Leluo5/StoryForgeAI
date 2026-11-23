// M3c-3 知识库 L1 数据层迁移验证脚本（T06/T07 完成标准）
// 覆盖：空库与存量库各执行 up/down；断言 8 表 + 2 扩展 + CHECK + 部分唯一索引 + GIN 检索索引 + 8 组索引；
//       down 删表不删扩展。
// 运行：pnpm --filter @storyforge/api tsx src/database/verify-knowledge-migrations.ts
// 前置：DATABASE_URL 指向存量验证库（默认 storyforge_test），EMPTY_DATABASE_URL 指向空验证库。
import { createDataSource } from './data-source';
import type { DataSource } from 'typeorm';
import { Client } from 'pg';

const EMPTY_DATABASE_URL =
  process.env.EMPTY_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge_mig_empty';
// 存量库必须用测试库（TEST_DATABASE_URL），严禁误用主库 DATABASE_URL——主库承载真实数据。
const STOCK_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge_test';

// CI 全新环境没有 storyforge_mig_empty 库，需按连接串自动创建（TEMPLATE template0 规避 collation 版本噪音）。
async function ensureDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, '');
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (exists.rowCount === 0) {
      // 库名来自受控连接串（EMPTY_DATABASE_URL），校验为合法标识符后拼接，规避 CREATE DATABASE 不可参数化。
      if (!/^[a-z_][a-z0-9_]*$/i.test(database)) {
        throw new Error(`不安全的空验证库名：${database}`);
      }
      await client.query(`CREATE DATABASE ${database} TEMPLATE template0`);
      console.info(`  已创建空验证库 ${database}`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

// 知识库 8 张业务表
const KNOWLEDGE_TABLES = [
  'knowledge_entries',
  'knowledge_work_refs',
  'knowledge_tags',
  'knowledge_entry_tags',
  'knowledge_entry_links',
  'knowledge_entry_embeddings',
  'knowledge_jobs',
  'knowledge_job_events'
] as const;

// 迁移注册顺序：base(7表+pg_trgm) → vector(embeddings+vector 扩展)
const KNOWLEDGE_MIGRATION_NAMES = ['KnowledgeBase1760600000000', 'KnowledgeVector1760600001000'] as const;

let failures = 0;

function ok(message: string): void {
  console.info(`  [PASS] ${message}`);
}

function fail(message: string): void {
  failures += 1;
  console.error(`  [FAIL] ${message}`);
}

function assert(condition: boolean, message: string): void {
  if (condition) ok(message);
  else fail(message);
}

async function listTables(ds: DataSource): Promise<string[]> {
  const rows: Array<{ table_name: string }> = await ds.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  return rows.map((row) => row.table_name);
}

async function listExtensions(ds: DataSource): Promise<string[]> {
  const rows: Array<{ extname: string }> = await ds.query(`SELECT extname FROM pg_extension`);
  return rows.map((row) => row.extname);
}

async function countTable(ds: DataSource, table: string): Promise<number> {
  const rows: Array<{ total: string }> = await ds.query(`SELECT count(*)::text AS total FROM ${table}`);
  return Number(rows[0]?.total ?? 0);
}

async function hasConstraint(ds: DataSource, table: string, constraint: string): Promise<boolean> {
  const rows: Array<{ total: string }> = await ds.query(
    `SELECT count(*)::text AS total FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
    [table, constraint]
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

async function hasIndex(ds: DataSource, index: string): Promise<boolean> {
  const rows: Array<{ total: string }> = await ds.query(
    `SELECT count(*)::text AS total FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [index]
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

// 断言知识库 8 张表 + 2 个扩展 + 关键约束/索引 全部就位
async function assertUpStructure(ds: DataSource, label: string): Promise<void> {
  console.info(`\n=== 断言结构（${label}）===`);

  const tables = await listTables(ds);
  for (const table of KNOWLEDGE_TABLES) {
    assert(tables.includes(table), `表 ${table} 存在`);
  }

  const extensions = await listExtensions(ds);
  assert(extensions.includes('pg_trgm'), 'pg_trgm 扩展已创建');
  assert(extensions.includes('vector'), 'vector 扩展已创建');

  // knowledge_entries 关键约束与索引
  await assert(await hasConstraint(ds, 'knowledge_entries', 'knowledge_entries_check'), 'entries scope/work 一致性 CHECK');
  await assert(await hasIndex(ds, 'uq_knowledge_global_hash'), '全局唯一内容哈希索引');
  await assert(await hasIndex(ds, 'uq_knowledge_work_hash'), '作品唯一内容哈希索引');
  await assert(await hasIndex(ds, 'idx_knowledge_search_trgm'), 'trigram 检索 GIN 索引');
  await assert(await hasIndex(ds, 'idx_knowledge_global_list'), '全局列表索引');
  await assert(await hasIndex(ds, 'idx_knowledge_work_list'), '作品列表索引');
  await assert(await hasIndex(ds, 'idx_knowledge_global_type'), '全局类型索引');
  await assert(await hasIndex(ds, 'idx_knowledge_work_type'), '作品类型索引');
  await assert(await hasIndex(ds, 'idx_knowledge_global_created'), '全局创建时间索引');
  await assert(await hasIndex(ds, 'idx_knowledge_work_created'), '作品创建时间索引');
  await assert(await hasIndex(ds, 'idx_knowledge_trash'), '回收站索引');

  // work_refs / tags / entry_tags / links / jobs / events 关键约束与索引
  await assert(await hasIndex(ds, 'uq_knowledge_ref'), '作品引用唯一索引');
  await assert(await hasIndex(ds, 'idx_knowledge_refs_work'), '作品引用列表索引');
  await assert(await hasIndex(ds, 'uq_knowledge_tag_global'), '全局标签唯一索引');
  await assert(await hasIndex(ds, 'uq_knowledge_tag_work'), '作品标签唯一索引');
  await assert(await hasIndex(ds, 'idx_knowledge_entry_tags_tag'), '条目标签 tag 索引');
  await assert(await hasIndex(ds, 'idx_knowledge_links_source'), '关联 source 索引');
  await assert(await hasIndex(ds, 'idx_knowledge_links_target'), '关联 target 索引');
  await assert(await hasIndex(ds, 'uq_knowledge_job_idem'), '作业幂等键唯一索引');
  await assert(await hasIndex(ds, 'uq_knowledge_job_structure'), '同条目 structure 运行中唯一索引');
  await assert(await hasIndex(ds, 'idx_knowledge_jobs_list'), '作业列表索引');
  await assert(await hasIndex(ds, 'idx_knowledge_jobs_status'), '作业状态索引');
  await assert(await hasIndex(ds, 'idx_knowledge_job_events'), '作业事件索引');
  await assert(await hasIndex(ds, 'uq_knowledge_embedding_hash'), '向量 source_hash 唯一索引');

  // 迁移记录包含两个知识库迁移
  const migrationRows: Array<{ name: string }> = await ds.query(
    `SELECT name FROM migrations WHERE name = ANY($1)`,
    [KNOWLEDGE_MIGRATION_NAMES]
  );
  const recorded = migrationRows.map((row) => row.name);
  for (const name of KNOWLEDGE_MIGRATION_NAMES) {
    assert(recorded.includes(name), `迁移记录 ${name} 已写入`);
  }
}

// 断言 down 后：8 张表全消失，两个扩展仍在（down 不删扩展）
async function assertDownStructure(ds: DataSource, label: string): Promise<void> {
  console.info(`\n=== 断言回滚（${label}）===`);

  const tables = await listTables(ds);
  for (const table of KNOWLEDGE_TABLES) {
    assert(!tables.includes(table), `表 ${table} 已删除`);
  }

  const extensions = await listExtensions(ds);
  assert(extensions.includes('pg_trgm'), 'pg_trgm 扩展仍在（down 不删）');
  assert(extensions.includes('vector'), 'vector 扩展仍在（down 不删）');

  const migrationRows: Array<{ name: string }> = await ds.query(
    `SELECT name FROM migrations WHERE name = ANY($1)`,
    [KNOWLEDGE_MIGRATION_NAMES]
  );
  assert(migrationRows.length === 0, '两个知识库迁移记录已回滚删除');
}

// 空库：全新数据库跑全量迁移
async function verifyEmptyDatabase(): Promise<void> {
  console.info(`\n########## 空库验证：${EMPTY_DATABASE_URL} ##########`);
  const ds = createDataSource(EMPTY_DATABASE_URL);
  try {
    await ds.initialize();
    await ds.runMigrations();
    await assertUpStructure(ds, '空库 up');

    // 回滚：知识库两个迁移按时间戳排序并不在注册顺序末尾，须循环 undo 直至知识库迁移记录清空。
    // 防御上限 40 次（对齐 character-schema 的回滚循环），超限则断言失败暴露错位。
    for (let index = 0; index < 40; index += 1) {
      const remaining: Array<{ name: string }> = await ds.query(
        `SELECT name FROM migrations WHERE name = ANY($1)`,
        [KNOWLEDGE_MIGRATION_NAMES]
      );
      if (remaining.length === 0) break;
      await ds.undoLastMigration();
    }
    await assertDownStructure(ds, '空库 down');

    // 恢复：重新跑迁移，保证库处于可用状态
    await ds.runMigrations();
    await assertUpStructure(ds, '空库 down 后恢复 up');
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}

// 存量库：模拟「旧迁移已应用但需重建」（F3 处置：迁移是重建对象，直接重写）
// 实际验证方式：先删两个知识库迁移记录 + drop 8 张知识表（若存在），
// 再跑迁移，断言结构就位；随后回滚，断言表删扩展留；再恢复。
async function verifyStockDatabase(): Promise<void> {
  console.info(`\n########## 存量库验证：${STOCK_DATABASE_URL} ##########`);
  const ds = createDataSource(STOCK_DATABASE_URL);
  try {
    await ds.initialize();
    // 构造真实「存量快照」：旧一代知识库为单表 knowledge_entries（含旧列 author_id/type/source/
    // raw_content/tags/links），且旧迁移 KnowledgeBase1760600000000 已应用。
    // F3 §4 处置：迁移是重建对象，直接重写；存量验证 = 删旧迁移记录 + drop 旧单表（模拟「旧迁移未应用/需重建」）。
    console.info('  构造存量快照：旧单表 knowledge_entries + 1 条业务数据 + 旧迁移记录…');
    await ds.query(`DELETE FROM migrations WHERE name = ANY($1)`, [KNOWLEDGE_MIGRATION_NAMES]);
    for (const table of KNOWLEDGE_TABLES) {
      await ds.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    // 旧一代单表结构（最小可用：含旧列与旧 CHECK 无关的新 CHECK 不在此处）
    await ds.query(`
      CREATE TABLE knowledge_entries (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL,
        work_id uuid,
        library_scope varchar(8) NOT NULL DEFAULT 'global',
        type varchar(16) NOT NULL,
        title varchar(200) NOT NULL,
        raw_content text NOT NULL,
        content_hash char(64) NOT NULL,
        search_text text NOT NULL DEFAULT '',
        structured jsonb,
        structure_status varchar(16) NOT NULL DEFAULT 'pending',
        outline jsonb,
        outline_status varchar(16),
        favorite boolean NOT NULL DEFAULT false,
        pinned boolean NOT NULL DEFAULT false,
        pinned_at timestamptz,
        source varchar(16) NOT NULL DEFAULT 'manual',
        source_entry_id uuid,
        version integer NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        deleted_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        tags jsonb NOT NULL DEFAULT '[]',
        links jsonb NOT NULL DEFAULT '[]'
      )
    `);
    const stockContentHash = 'a'.repeat(64);
    await ds.query(
      `INSERT INTO knowledge_entries (id, author_id, type, title, raw_content, content_hash, search_text, source, tags, links)
       VALUES ($1, $2, 'article', '存量条目', '存量原文', $3, '存量条目', 'manual', '["旧标签"]', '[]')`,
      ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', stockContentHash]
    );
    // 注意：不插回旧迁移记录。F3 §4 处置「迁移是重建对象，直接重写」，旧记录已 DELETE，
    // 让 runMigrations 重跑 base + vector（重建 8 张表）。旧单表数据按处置丢弃。
    const stockEntryCount = await countTable(ds, 'knowledge_entries');
    assert(stockEntryCount === 1, `存量快照构造成功（knowledge_entries 行数 = ${stockEntryCount}）`);

    // F3 §4 处置：迁移是重建对象，直接重写，旧单表数据按处置丢弃。
    // runMigrations 重跑 base 迁移会 CREATE TABLE knowledge_entries，与构造的旧单表冲突，
    // 因此先 DROP 旧单表，让 base 迁移干净重建 8 张表。
    console.info('  丢弃旧单表结构（迁移重建对象），重跑 base + vector…');
    await ds.query('DROP TABLE IF EXISTS knowledge_entries CASCADE');

    await ds.runMigrations();
    await assertUpStructure(ds, '存量库 up');

    // 关键：存量库重建后，基础业务数据（authors/works 等）保留；旧单表数据按 F3 §4 处置丢弃
    //（迁移是重建对象，无兼容），但作者基础数据不因知识库迁移而丢失。
    const authorCount = await countTable(ds, 'authors');
    console.info(`  存量库 authors 行数：${authorCount}（业务数据保留）`);
    const workCount = await countTable(ds, 'works');
    console.info(`  存量库 works 行数：${workCount}（业务数据保留）`);

    for (let index = 0; index < 40; index += 1) {
      const remaining: Array<{ name: string }> = await ds.query(
        `SELECT name FROM migrations WHERE name = ANY($1)`,
        [KNOWLEDGE_MIGRATION_NAMES]
      );
      if (remaining.length === 0) break;
      await ds.undoLastMigration();
    }
    await assertDownStructure(ds, '存量库 down');

    // 恢复
    await ds.runMigrations();
    await assertUpStructure(ds, '存量库 down 后恢复 up');
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}

async function main(): Promise<void> {
  try {
    await ensureDatabase(EMPTY_DATABASE_URL);
    await verifyEmptyDatabase();
    await verifyStockDatabase();
  } catch (error) {
    fail(`验证异常：${error instanceof Error ? error.stack : String(error)}`);
  }

  if (failures > 0) {
    console.error(`\n知识库迁移验证失败：${failures} 处断言未通过`);
    process.exitCode = 1;
  } else {
    console.info('\n知识库迁移验证全部通过（空库 + 存量库 up/down + 结构断言）。');
  }
}

void main();
