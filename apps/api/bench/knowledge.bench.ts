// M3c-3 知识库 T41 性能验收基准脚本（D26）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §11.6、03-任务规划.md T41
// 目标：全局 2000 + 作品 500 条基准；测列表检索 P50/P95、作品相似度检索 P95、备份 2000 条耗时。
// 门禁：全局列表 P50≤200ms / P95≤1000ms；作品相似度 P95≤1000ms；备份 2000 条 ≤60s。
// 幂等：脚本以 owner_id=固定种子作者 清理既有数据再插入（重复跑不重复插、结果可复现）。
// 运行：pnpm --filter @storyforge/api bench（依赖 postgres 5433 + 迁移已 up）
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createDataSource } from '../src/database/data-source';
import { KnowledgeEntryEntity } from '../src/database/knowledge-entry.entity';
import { KnowledgeEntryEmbeddingEntity } from '../src/database/knowledge-entry-embedding.entity';
import { KnowledgeEntriesService } from '../src/knowledge/entries.service';
import { KnowledgeBackupService } from '../src/knowledge/knowledge-backup.service';
import { findSimilar, type EmbeddingRecord } from '../src/knowledge/similarity';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5433/storyforge_test';
const AUTHOR_ID = '00000000-0000-4000-8000-000000000b41';
const WORK_ID = '00000000-0000-4000-8000-000000000b42';
const GLOBAL_N = 2000;
const WORK_N = 500;
const SIM_TOP_K = 10;
const SIM_THRESHOLD = 0.35;
const SIM_MAX = 3;
const DIM = 1024;

process.env.STORYFORGE_BACKUP_DIR = join(process.cwd(), 'data', 'kb-bench-backups');
process.env.DATABASE_URL = DATABASE_URL;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function ms(start: number): number {
  return Number((performance.now() - start).toFixed(2));
}

function makeVec(seed: number): number[] {
  // 确定性伪随机：固定种子 → 相同向量（幂等可复现）
  const v = new Array<number>(DIM);
  let x = seed + 1;
  for (let i = 0; i < DIM; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v[i] = (x / 2147483648) * 2 - 1;
  }
  return v;
}

async function main(): Promise<void> {
  const ds = createDataSource(DATABASE_URL);
  await ds.initialize();

  const entryRepo = ds.getRepository(KnowledgeEntryEntity);
  const embRepo = ds.getRepository(KnowledgeEntryEmbeddingEntity);

  // 预建作者 + 作品（幂等 upsert，供归属校验与 work scope 查询）
  console.log(`[bench] 预建作者/作品（owner=${AUTHOR_ID}, work=${WORK_ID}）...`);
  await ds.query(
    `INSERT INTO authors (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [AUTHOR_ID, `kb-bench-${AUTHOR_ID}@example.com`, 'KB Bench', 'x']
  );
  await ds.query(
    `INSERT INTO works (id, author_id, title, description) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [WORK_ID, AUTHOR_ID, 'KB 基准作品', '']
  );

  console.log(`[bench] 数据源就绪，幂等清理 owner=${AUTHOR_ID} ...`);
  await embRepo.createQueryBuilder().delete().where('owner_id = :a', { a: AUTHOR_ID }).execute();
  await entryRepo.createQueryBuilder().delete().where('owner_id = :a', { a: AUTHOR_ID }).execute();

  // 构造数据：2000 全局 + 500 作品（含向量）
  console.log(`[bench] 插入 ${GLOBAL_N} 全局 + ${WORK_N} 作品条目（含向量）...`);
  const entries: KnowledgeEntryEntity[] = [];
  const embeddings: KnowledgeEntryEmbeddingEntity[] = [];
  for (let i = 0; i < GLOBAL_N; i++) {
    const id = randomUUID();
    const text = `全局素材 ${i} 内容：${'这是一段较长原文。'.repeat((i % 40) + 1)}`;
    entries.push(entryRepo.create({
      id, owner_id: AUTHOR_ID, library_scope: 'global', work_id: null,
      entry_type: 'article', title: `全局条目 ${i}`, title_key: `全局条目 ${i}`.toLowerCase(),
      original_text: text,
      content_hash: createHash('sha256').update(text).digest('hex'),
      search_text: `全局条目 ${i} ${text.slice(0, 200)}`, origin: 'manual', version: 1
    }));
    embeddings.push(embRepo.create({
      entry_id: id, owner_id: AUTHOR_ID, model: 'mock-bge-m3-1024', dim: DIM,
      embedding: `[${makeVec(i).join(',')}]`, source_hash: createHash('sha256').update(text).digest('hex')
    }));
  }
  for (let i = 0; i < WORK_N; i++) {
    const id = randomUUID();
    const text = `作品素材 ${i} 内容：${'灵感片段。'.repeat((i % 60) + 1)}`;
    entries.push(entryRepo.create({
      id, owner_id: AUTHOR_ID, library_scope: 'work', work_id: WORK_ID,
      entry_type: 'inspiration', title: `作品条目 ${i}`, title_key: `作品条目 ${i}`.toLowerCase(),
      original_text: text,
      content_hash: createHash('sha256').update(text).digest('hex'),
      search_text: `作品条目 ${i} ${text.slice(0, 200)}`, origin: 'manual', version: 1
    }));
    embeddings.push(embRepo.create({
      entry_id: id, owner_id: AUTHOR_ID, model: 'mock-bge-m3-1024', dim: DIM,
      embedding: `[${makeVec(GLOBAL_N + i).join(',')}]`, source_hash: createHash('sha256').update(text).digest('hex')
    }));
  }
  await entryRepo.save(entries);
  await embRepo.save(embeddings);
  console.log(`[bench] 数据就绪：${GLOBAL_N} 全局 + ${WORK_N} 作品，向量 ${GLOBAL_N + WORK_N} 条`);

  const entriesSvc = new KnowledgeEntriesService(ds);
  const backupSvc = new KnowledgeBackupService(ds);

  // ① 全局列表检索：100 次，每次带关键词命中（触发 ILIKE + 分页）
  console.log('[bench] ① 全局列表检索（2000 条，含关键词）...');
  const listSamples: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    await entriesSvc.listEntries(AUTHOR_ID, { scope: 'global', keyword: `全局条目 ${i % 200}`, limit: 50 });
    listSamples.push(ms(t0));
  }
  listSamples.sort((a, b) => a - b);
  const listP50 = percentile(listSamples, 50);
  const listP95 = percentile(listSamples, 95);

  // ② 作品相似度检索：500 条候选拉取 + findSimilar，30 次
  console.log('[bench] ② 作品相似度检索（500 条向量候选 + findSimilar）...');
  const simSamples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const rows = await embRepo.createQueryBuilder('e')
      .innerJoin('knowledge_entries', 'k', 'k.id = e.entry_id')
      .where('e.owner_id = :a AND k.library_scope = :s AND k.work_id = :w', { a: AUTHOR_ID, s: 'work', w: WORK_ID })
      .select(['e.entry_id', 'e.embedding'])
      .getMany();
    const candidates: EmbeddingRecord[] = rows.map((r) => ({
      entry_id: r.entry_id, embedding: JSON.parse(r.embedding) as number[],
      library_scope: 'work', work_id: WORK_ID, owner_id: AUTHOR_ID, deleted_at: null
    }));
    findSimilar(makeVec(500 + i), candidates, { topK: SIM_TOP_K, threshold: SIM_THRESHOLD, maxResults: SIM_MAX });
    simSamples.push(ms(t0));
  }
  simSamples.sort((a, b) => a - b);
  const simP95 = percentile(simSamples, 95);

  // ③ 备份 2000 条：createBackup（含 gzip 落盘）
  console.log('[bench] ③ 备份 2000 条（gzip 落盘）...');
  const t0 = performance.now();
  const backup = await backupSvc.createBackup(AUTHOR_ID, { scope: 'global' });
  const backupMs = ms(t0);
  const backupOk = backup.entry_count >= GLOBAL_N;

  // 输出
  console.log('\n══════════ M3c-3 知识库 T41 性能基准 ══════════');
  console.log(`全局列表检索  P50=${listP50}ms  P95=${listP95}ms   门禁 P50≤200 / P95≤1000`);
  console.log(`作品相似度    P95=${simP95}ms                        门禁 P95≤1000`);
  console.log(`备份 2000 条  ${backupMs}ms（entry_count=${backup.entry_count}）  门禁 ≤60000ms`);
  const pass =
    listP50 <= 200 && listP95 <= 1000 && simP95 <= 1000 && backupMs <= 60000 && backupOk;
  console.log(`结果：${pass ? '✅ PASS' : '❌ FAIL'}`);
  console.log('══════════════════════════════════════════════');

  await ds.destroy();
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[bench] 失败：', err);
  process.exitCode = 1;
});
