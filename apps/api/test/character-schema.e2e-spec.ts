import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { AuthorEntity } from '../src/database/author.entity';
import { seedCharacterRelationTypes } from '../src/database/character-relation-type.seed';
import { destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

// M3c-2 数据层断言：14 张表、关键 CHECK / 唯一键 / 部分唯一索引与 23 类关系类型种子
const CHARACTER_TABLES = [
  'characters',
  'character_aliases',
  'character_relation_types',
  'character_relations',
  'character_views',
  'character_view_nodes',
  'character_growth_events',
  'character_avatar_assets',
  'character_ai_drafts',
  'character_ai_candidate_items',
  'character_portability_jobs',
  'character_text_anchors',
  'character_archive_scans',
  'plot_node_character_owners'
];

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected at least one row');
  return row;
}

describe('character schema migrations', () => {
  let dataSource: DataSource;
  let authorId: string;
  let workId: string;

  beforeAll(async () => {
    dataSource = createDataSource(testDatabaseUrl());
    await resetTestDatabase(dataSource);
    const author = await dataSource.getRepository(AuthorEntity).save({
      id: randomUUID(),
      email: `character-schema-${randomUUID()}@example.com`,
      display_name: 'Character Schema',
      password_hash: 'test-only-hash'
    });
    authorId = author.id;
    const works: Array<{ id: string }> = await dataSource.query(
      "INSERT INTO works (id, author_id, title) VALUES (gen_random_uuid(), $1, '角色断言作品') RETURNING id",
      [authorId]
    );
    workId = first(works).id;
  });

  afterAll(async () => {
    await destroyTestDatabase(dataSource);
  });

  async function createCharacter(extra: { status?: string; merged_into_id?: string | null; archived_at?: Date | null } = {}) {
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO characters (id, work_id, name, name_key, status, merged_into_id, archived_at)
       VALUES (gen_random_uuid(), $1, '角色', '角色', $2, $3, $4) RETURNING id`,
      [workId, extra.status ?? 'active', extra.merged_into_id ?? null, extra.archived_at ?? null]
    );
    return first(rows).id;
  }

  async function createRelationType(): Promise<string> {
    const rows: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO character_relation_types (id, work_id, code, label, group_key, group_label)
       VALUES (gen_random_uuid(), $1, $2, '自定义', 'other', '其他') RETURNING id`,
      [workId, `custom_${randomUUID().slice(0, 8)}`]
    );
    return first(rows).id;
  }

  async function createRelation(sourceId: string, targetId: string, typeId: string, pairKey = 'pair-a') {
    await dataSource.query(
      `INSERT INTO character_relations
         (id, work_id, source_id, target_id, type_id, directed, pair_key, label, color, tag)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, true, $5, '父', '#336699', '父')`,
      [workId, sourceId, targetId, typeId, pairKey]
    );
  }

  it('creates the 14 character tables explicitly without synchronize', async () => {
    const rows: Array<{ table_name: string }> = await dataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [CHARACTER_TABLES]
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([...CHARACTER_TABLES].sort());
    expect(dataSource.options.synchronize).toBe(false);
  });

  it('extends ai_tasks.scope with character and keeps the CHECK closed', async () => {
    const insertTask = (scope: string) =>
      dataSource.query(
        `INSERT INTO ai_tasks
           (id, idempotency_key, work_id, scope, tool, input_summary, base_version, status, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'character_extract', '{}'::jsonb, 0, 'queued', $4)`,
        [`scope-${randomUUID()}`, workId, scope, authorId]
      );
    await expect(insertTask('character')).resolves.toBeDefined();
    await expect(insertTask('unknown_scope')).rejects.toThrow();
  });

  it('seeds 23 relation types per work idempotently and keeps 5 builtin groups', async () => {
    await seedCharacterRelationTypes(dataSource, workId);
    await seedCharacterRelationTypes(dataSource, workId);
    const counts: Array<{ total: string; groups: string }> = await dataSource.query(
      `SELECT count(*)::text AS total, count(DISTINCT group_key)::text AS groups
       FROM character_relation_types WHERE work_id = $1 AND is_builtin = true`,
      [workId]
    );
    expect(first(counts)).toEqual({ total: '23', groups: '5' });
  });

  it('enforces character status CHECK constraints', async () => {
    await expect(createCharacter({ status: 'merged' })).rejects.toThrow();
    await expect(createCharacter({ status: 'archived' })).rejects.toThrow();
    await expect(createCharacter({ status: 'unknown' })).rejects.toThrow();
    const target = await createCharacter();
    const merged = await createCharacter({ status: 'merged', merged_into_id: target });
    expect(merged).toBeDefined();
  });

  it('rejects duplicate alias keys for the same character', async () => {
    const characterId = await createCharacter();
    const insertAlias = () =>
      dataSource.query(
        `INSERT INTO character_aliases (id, work_id, character_id, alias, alias_key)
         VALUES (gen_random_uuid(), $1, $2, '小名', '小名')`,
        [workId, characterId]
      );
    await insertAlias();
    await expect(insertAlias()).rejects.toThrow();
  });

  it('rejects self relations and duplicate pair + type relations', async () => {
    const source = await createCharacter();
    const target = await createCharacter();
    const typeId = await createRelationType();

    await expect(createRelation(source, source, typeId)).rejects.toThrow();
    await createRelation(source, target, typeId, 'pair-b');
    await expect(createRelation(source, target, typeId, 'pair-b')).rejects.toThrow();
    // 同一对角色换类型可并存
    const otherType = await createRelationType();
    await expect(createRelation(source, target, otherType, 'pair-b')).resolves.toBeUndefined();
  });

  it('allows only one default view and one active avatar per scope', async () => {
    const insertView = (isDefault: boolean) =>
      dataSource.query(
        `INSERT INTO character_views (id, work_id, name, is_default)
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [workId, `视图-${randomUUID().slice(0, 8)}`, isDefault]
      );
    await insertView(true);
    await expect(insertView(true)).rejects.toThrow();
    await expect(insertView(false)).resolves.toBeDefined();

    const characterId = await createCharacter();
    const insertAvatar = (status: string) =>
      dataSource.query(
        `INSERT INTO character_avatar_assets
           (id, work_id, character_id, status, mime, byte_size, content_hash)
         VALUES (gen_random_uuid(), $1, $2, $3, 'image/png', 128, $4)`,
        [workId, characterId, status, 'a'.repeat(64)]
      );
    await insertAvatar('active');
    await expect(insertAvatar('active')).rejects.toThrow();
    await expect(insertAvatar('pending')).resolves.toBeDefined();
    await expect(insertAvatar('image/png')).rejects.toThrow();
  });

  it('enforces anchor tuple uniqueness and single running scan per character', async () => {
    const characterId = await createCharacter();
    const volumes: Array<{ id: string }> = await dataSource.query(
      "INSERT INTO volumes (id, work_id, title, position) VALUES (gen_random_uuid(), $1, '第一卷', 0) RETURNING id",
      [workId]
    );
    const chapters: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO chapters (id, work_id, volume_id, title, position, document, content_hash)
       VALUES (gen_random_uuid(), $1, $2, '第一章', 0, '{}'::jsonb, $3) RETURNING id`,
      [workId, first(volumes).id, 'b'.repeat(64)]
    );
    const insertScan = () =>
      dataSource.query<Array<{ id: string }>>(
        `INSERT INTO character_archive_scans (id, work_id, character_id, requested_by)
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
        [workId, characterId, authorId]
      );
    const scans = await insertScan();
    await expect(insertScan()).rejects.toThrow();

    const paragraphPid = randomUUID();
    const insertAnchor = () =>
      dataSource.query(
        `INSERT INTO character_text_anchors
           (id, work_id, character_id, chapter_id, scan_id, paragraph_pid, matched_name, excerpt, excerpt_hash)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '角色', '摘录', $6)`,
        [workId, characterId, first(chapters).id, first(scans).id, paragraphPid, 'c'.repeat(64)]
      );
    await insertAnchor();
    await expect(insertAnchor()).rejects.toThrow();
  });

  it('enforces plot owner node + character uniqueness without touching plot nodes', async () => {
    const characterId = await createCharacter();
    const trees: Array<{ id: string }> = await dataSource.query(
      "INSERT INTO plot_trees (id, work_id, title) VALUES (gen_random_uuid(), $1, '剧情树') RETURNING id",
      [workId]
    );
    const nodes: Array<{ id: string }> = await dataSource.query(
      "INSERT INTO plot_nodes (id, tree_id, title) VALUES (gen_random_uuid(), $1, '节点') RETURNING id",
      [first(trees).id]
    );
    const insertOwner = () =>
      dataSource.query(
        `INSERT INTO plot_node_character_owners (id, work_id, node_id, character_id, is_exclusive)
         VALUES (gen_random_uuid(), $1, $2, $3, true)`,
        [workId, first(nodes).id, characterId]
      );
    await insertOwner();
    await expect(insertOwner()).rejects.toThrow();
    const nodeCount: Array<{ total: string }> = await dataSource.query('SELECT count(*)::text AS total FROM plot_nodes');
    expect(first(nodeCount).total).toBe('1');
  });

  it('rolls back and re-applies the five character migrations', async () => {
    for (let index = 0; index < 5; index += 1) {
      await dataSource.undoLastMigration();
    }
    const afterDown: Array<{ table_name: string }> = await dataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [CHARACTER_TABLES]
    );
    expect(afterDown).toEqual([]);
    const scopeDef: Array<{ definition: string }> = await dataSource.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'ai_tasks_scope_check'"
    );
    expect(scopeDef[0]?.definition).not.toContain("'character'");

    await dataSource.runMigrations();
    const afterUp: Array<{ table_name: string }> = await dataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [CHARACTER_TABLES]
    );
    expect(afterUp.map((row) => row.table_name).sort()).toEqual([...CHARACTER_TABLES].sort());
    const seeded: Array<{ total: string }> = await dataSource.query(
      'SELECT count(*)::text AS total FROM character_relation_types WHERE work_id = $1 AND is_builtin = true',
      [workId]
    );
    expect(first(seeded).total).toBe('23');
  });
});
