import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { clearAuthTables, destroyTestDatabase, resetTestDatabase, testDatabaseUrl } from './test-database';

const databaseUrl = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = databaseUrl;

// M3c-2 T21~T24 接口层 e2e：真实 PostgreSQL
describe('character endpoints (real PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let migrationDataSource: DataSource;
  let session: { cookie: string; csrf: string; token: string };
  let authorId: string;
  let workId: string;

  beforeAll(async () => {
    const [{ AppModule }, { configureApp }, { createDataSource }] = await Promise.all([
      import('../src/app.module'),
      import('../src/app.setup'),
      import('../src/database/data-source')
    ]);
    migrationDataSource = createDataSource(databaseUrl);
    await resetTestDatabase(migrationDataSource);

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = module.get(DataSource);
  });

  beforeEach(async () => {
    await clearAuthTables(dataSource);
    await bootstrap();
  });

  afterAll(async () => {
    await app.close();
    await destroyTestDatabase(migrationDataSource);
  });

  async function bootstrap(): Promise<void> {
    const [{ AuthorEntity }, { PasswordService }, { WorkService }] = await Promise.all([
      import('../src/database/author.entity'),
      import('../src/auth/password.service'),
      import('../src/writing/work.service')
    ]);
    const passwordHash = await new PasswordService().hash('correct horse');
    const author = await dataSource.getRepository(AuthorEntity).save({
      email: `character-author-${randomUUID()}@example.com`,
      display_name: 'Character Author',
      password_hash: passwordHash
    });
    authorId = author.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: author.email, password: 'correct horse' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    session = {
      cookie: cookies.find((c) => c.startsWith('storyforge_session='))!.split(';')[0]!,
      csrf: cookies.find((c) => c.startsWith('storyforge_csrf='))!.split(';')[0]!,
      token: login.body.data.csrf_token as string
    };

    const workService = new WorkService(dataSource);
    workId = (await workService.create(authorId, { title: '角色作品', description: '' })).work.id;
  }

  const get = (url: string) =>
    request(app.getHttpServer()).get(url).set('Cookie', [session.cookie, session.csrf]);
  const post = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const patch = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .patch(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const put = (url: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .put(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token)
      .send(body as object);
  const del = (url: string) =>
    request(app.getHttpServer())
      .delete(url)
      .set('Cookie', [session.cookie, session.csrf])
      .set('x-csrf-token', session.token);

  const charactersUrl = (id = workId) => `/api/v1/works/${id}/characters`;
  const workUrl = (id = workId) => `/api/v1/works/${id}`;

  async function createCharacter(name: string): Promise<string> {
    const response = await post(charactersUrl(), { name }).expect(201);
    return response.body.data.id as string;
  }

  async function waitForScans(): Promise<void> {
    const { CharacterArchiveScanEntity } = await import(
      '../src/database/character-archive-scan.entity'
    );
    const repo = dataSource.getRepository(CharacterArchiveScanEntity);
    for (let i = 0; i < 40; i += 1) {
      const pending = await repo.count({ where: { work_id: workId, status: 'pending' } });
      const running = await repo.count({ where: { work_id: workId, status: 'running' } });
      if (pending + running === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function getChapterId(): Promise<string> {
    const { ChapterEntity } = await import('../src/database/chapter.entity');
    return (await dataSource.getRepository(ChapterEntity).findOneByOrFail({ work_id: workId })).id;
  }

  async function getDefaultViewId(): Promise<string> {
    const res = await get(`${workUrl()}/character-views`).expect(200);
    const list = res.body.data as Array<{ id: string; is_default: boolean }>;
    const def = list.find((v) => v.is_default);
    if (!def) throw new Error('default view missing after ensure');
    return def.id;
  }

  async function createPlotTree(title = '主线'): Promise<string> {
    const r = await post(`/api/v1/works/${workId}/plot-tree`, { title }).expect(201);
    return r.body.data.tree.id as string;
  }

  async function createPlotNode(parentId: string | null, title: string): Promise<string> {
    const body: Record<string, unknown> = { title, summary: title };
    if (parentId) body.parent_id = parentId;
    const r = await post(`/api/v1/works/${workId}/plot-tree/nodes`, body).expect(201);
    return r.body.data.node.id as string;
  }

  async function seedAvatarAsset(
    characterId: string,
    status: 'active' | 'pending'
  ): Promise<string> {
    const { CharacterAvatarAssetEntity } = await import(
      '../src/database/character-avatar-asset.entity'
    );
    const repo = dataSource.getRepository(CharacterAvatarAssetEntity);
    const saved = await repo.save(
      repo.create({
        id: randomUUID(),
        work_id: workId,
        character_id: characterId,
        status,
        storage_kind: 'file',
        storage_path: null,
        mime: 'image/png',
        byte_size: 100,
        width: null,
        height: null,
        content_hash: '0'.repeat(64),
        task_id: null,
        error: null,
      })
    );
    return saved.id;
  }

  async function seedSucceededDraft(
    kind: 'characters_relations' | 'growth_events',
    itemPayloads: Array<Record<string, unknown>>
  ): Promise<{ draftId: string; itemIds: string[] }> {
    const created = await post(`/api/v1/works/${workId}/character-ai/drafts`, {
      kind,
      source: 'work'
    }).expect(202);
    const draftId = created.body.data.draft.id as string;
    const { CharacterAiDraftEntity } = await import('../src/database/character-ai-draft.entity');
    const { CharacterAiCandidateItemEntity } = await import(
      '../src/database/character-ai-candidate-item.entity'
    );
    await dataSource.getRepository(CharacterAiDraftEntity).update(draftId, { status: 'succeeded' });
    const itemRepo = dataSource.getRepository(CharacterAiCandidateItemEntity);
    const rows = itemPayloads.map((payload, i) =>
      itemRepo.create({
        id: randomUUID(),
        draft_id: draftId,
        item_index: i,
        kind: kind === 'characters_relations' ? 'character' : 'growth',
        payload,
        dependencies: [],
        suspected_duplicates: [],
        status: 'pending',
        resolution: null,
        resolved_entity_id: null,
        resolved_at: null,
      })
    );
    const saved = await itemRepo.save(rows);
    return { draftId, itemIds: saved.map((s) => s.id) };
  }

  function makeImportFile(
    wid: string,
    chars: Array<{ local_id: string; name: string }>
  ): Record<string, unknown> {
    return {
      schema_version: 2,
      exported_at: new Date().toISOString(),
      work: { id: wid, title: '导入作品' },
      relation_types: [],
      characters: chars.map((c) => ({
        local_id: c.local_id,
        name: c.name,
        identity: null,
        age: null,
        gender: null,
        personality: '',
        experience: '',
        country_region: null,
        faith: null,
        faction: null,
        race: null,
        occupation: null,
        age_band: null,
        attributes: [],
        aliases: [],
        origin: 'manual'
      })),
      relations: [],
      growth_events: [],
      views: []
    };
  }

  it('rejects unauthenticated reads (401) and writes without CSRF (403)', async () => {
    await request(app.getHttpServer()).get(charactersUrl()).expect(401);
    await request(app.getHttpServer()).post(charactersUrl()).send({ name: 'x' }).expect(401);
    await request(app.getHttpServer())
      .post(charactersUrl())
      .set('Cookie', [session.cookie, session.csrf])
      .send({ name: '林昭' })
      .expect(403);
  });

  it('validates payloads (422) and hides unknown works (404)', async () => {
    await post(charactersUrl(), { name: '' }).expect(422);
    await get(charactersUrl(randomUUID())).expect(404);
    await post(charactersUrl(randomUUID()), { name: '林昭' }).expect(404);
  });

  it('keeps duplicates and random static routes ahead of :characterId', async () => {
    const duplicates = await get(`${charactersUrl()}/duplicates`).expect(200);
    expect(duplicates.body.data.groups).toEqual([]);

    const random = await post(`${charactersUrl()}/random`, {}).expect(200);
    expect(typeof random.body.data.seed).toBe('string');
    expect(typeof random.body.data.dossier.name).toBe('string');
  });

  it('returns detail with relation summary and growth event count', async () => {
    const characterId = await createCharacter('林昭');
    const detail = await get(`${charactersUrl()}/${characterId}`).expect(200);
    expect(detail.body.data.character.id).toBe(characterId);
    expect(detail.body.data.relation_summary).toEqual({ total: 0 });
    expect(detail.body.data.growth_event_count).toBe(0);
  });

  it('archives with impact + pending scan and is idempotent on repeat', async () => {
    const characterId = await createCharacter('沈砚');
    const first = await post(`${charactersUrl()}/${characterId}/archive`, {}).expect(200);
    expect(first.body.data.character.status).toBe('archived');
    expect(first.body.data.version).toBe(2);
    expect(first.body.data.impact).toEqual({
      relations: 0,
      growth_events: 0,
      chapters: 1,
      exclusive_plot_nodes: 0
    });
    expect(first.body.data.scan.status).toBe('pending');
    expect(first.body.data.scan.total_chapters).toBe(1);

    const scanId = first.body.data.scan.id as string;
    const second = await post(`${charactersUrl()}/${characterId}/archive`, {}).expect(200);
    expect(second.body.data.changed).toBe(false);
    expect(second.body.data.scan.id).toBe(scanId);
    expect(second.body.data.version).toBe(2);
    await waitForScans();
  });

  it('restores an archived character and returns duplicate candidates', async () => {
    const first = await createCharacter('林昭');
    const second = await createCharacter('林昭');
    await post(`${charactersUrl()}/${first}/archive`, {}).expect(200);

    const restored = await post(`${charactersUrl()}/${first}/restore`, {}).expect(200);
    expect(restored.body.data.character.status).toBe('active');
    expect(restored.body.data.changed).toBe(true);
    const candidates = restored.body.data.duplicate_candidates as Array<{
      character_id: string;
      name: string;
      matched_on: string;
    }>;
    expect(candidates.some((c) => c.character_id === second && c.matched_on === 'name')).toBe(true);
    await waitForScans();
  });

  it('does not expose a purge/delete character route', async () => {
    const characterId = await createCharacter('无删除');
    await del(`${charactersUrl()}/${characterId}`).expect(404);
  });

  // ─────────────── 以下为 T22~T29 端点业务逻辑覆盖（增量追加，不改动既有用例） ───────────────

  describe('T22 relation types and relations', () => {
    it('lists seeded relation types and supports custom type CRUD', async () => {
      const list = await get(`${workUrl()}/character-relation-types`).expect(200);
      const types = list.body.data as Array<{ id: string; is_builtin: boolean }>;
      expect(types.length).toBeGreaterThan(0);
      expect(types.some((t) => t.is_builtin)).toBe(true);

      const created = await post(`${workUrl()}/character-relation-types`, {
        code: 'custom_rival',
        label: '宿敌',
        reverse_label: '宿敌',
        group_key: 'custom',
        group_label: '自定义',
      }).expect(201);
      const customId = created.body.data.id as string;
      expect(created.body.data.is_builtin).toBe(false);

      await patch(`${workUrl()}/character-relation-types/${customId}`, { label: '宿敌改' }).expect(200);
      await del(`${workUrl()}/character-relation-types/${customId}`).expect(200);
      const after = await get(`${workUrl()}/character-relation-types`).expect(200);
      expect((after.body.data as Array<{ id: string }>).some((t) => t.id === customId)).toBe(false);
    });

    it('rejects deleting a relation type in use (409) and a builtin type (409)', async () => {
      const types = await get(`${workUrl()}/character-relation-types`).expect(200);
      const list = types.body.data as Array<{ id: string; is_builtin: boolean }>;
      const charA = await createCharacter('林昭');
      const charB = await createCharacter('苏晚');
      const custom = await post(`${workUrl()}/character-relation-types`, {
        code: 'rel_in_use',
        label: '在用',
        group_key: 'custom',
        group_label: '自定义',
      }).expect(201);
      const typeId = custom.body.data.id as string;
      await post(`${workUrl()}/character-relations`, {
        source_id: charA,
        target_id: charB,
        type_id: typeId,
      }).expect(201);

      const inUse = await del(`${workUrl()}/character-relation-types/${typeId}`).expect(409);
      expect(inUse.body.error.details.code).toBe('RELATION_TYPE_HAS_INSTANCES');

      const builtin = list.find((t) => t.is_builtin);
      if (builtin) {
        const res = await del(`${workUrl()}/character-relation-types/${builtin.id}`).expect(409);
        expect(res.body.error.details.code).toBe('RELATION_TYPE_BUILTIN');
      }
    });

    it('creates a relation with full payload and enforces pair uniqueness (409)', async () => {
      const charA = await createCharacter('林昭');
      const charB = await createCharacter('苏晚');
      const types = await get(`${workUrl()}/character-relation-types`).expect(200);
      const type = (types.body.data as Array<{ id: string }>)[0]!;

      const created = await post(`${workUrl()}/character-relations`, {
        source_id: charA,
        target_id: charB,
        type_id: type.id,
        role_label: '挚友',
        reverse_role_label: '挚友',
        color: '#ff0000',
        line_style: 'solid',
        description: '高中相识',
      }).expect(201);
      expect(created.body.data.id).toBeTruthy();

      const dup = await post(`${workUrl()}/character-relations`, {
        source_id: charA,
        target_id: charB,
        type_id: type.id,
      }).expect(409);
      expect(dup.body.error.details.code).toBe('CHARACTER_RELATION_EXISTS');
      expect(dup.body.error.details.existing_id).toBe(created.body.data.id);

      const listed = await get(`${workUrl()}/character-relations`).expect(200);
      expect((listed.body.data as Array<{ id: string }>).some((r) => r.id === created.body.data.id)).toBe(true);

      const relId = created.body.data.id as string;
      await patch(`${workUrl()}/character-relations/${relId}`, { role_label: '老友' }).expect(200);
      await del(`${workUrl()}/character-relations/${relId}`).expect(200);
    });

    it('rejects self reference (409) and cross-work target (404)', async () => {
      const charA = await createCharacter('林昭');
      const types = await get(`${workUrl()}/character-relation-types`).expect(200);
      const type = (types.body.data as Array<{ id: string }>)[0]!;

      const self = await post(`${workUrl()}/character-relations`, {
        source_id: charA,
        target_id: charA,
        type_id: type.id,
      }).expect(422);
      expect(self.body.error.code).toBe('VALIDATION_ERROR');

      const work2 = (
        await post('/api/v1/works', { title: '第二作品', description: 'x' }).expect(201)
      ).body.data.work.id as string;
      const foreignChar = (await post(charactersUrl(work2), { name: '外作品' }).expect(201)).body
        .data.id as string;
      await post(`${workUrl()}/character-relations`, {
        source_id: charA,
        target_id: foreignChar,
        type_id: type.id,
      }).expect(404);
    });
  });

  describe('T23 views and board', () => {
    it('lists exactly one default view per work', async () => {
      const views = await get(`${workUrl()}/character-views`).expect(200);
      const list = views.body.data as Array<{ is_default: boolean }>;
      expect(list).toHaveLength(1);
      expect(list[0]!.is_default).toBe(true);
    });

    it('creates a view seeded with all active characters', async () => {
      const charA = await createCharacter('林昭');
      const charB = await createCharacter('苏晚');
      const created = await post(`${workUrl()}/character-views`, { name: '主角团' }).expect(201);
      const viewId = created.body.data.id as string;

      const board = await get(`${workUrl()}/character-views/${viewId}/board`).expect(200);
      const memberIds = (board.body.data.characters as Array<{ id: string }>).map((m) => m.id);
      expect(memberIds).toContain(charA);
      expect(memberIds).toContain(charB);
      expect(board.body.data.relation_types).toBeDefined();
    });

    it('protects the default view from deletion (409); patches/deletes a custom view', async () => {
      const defId = await getDefaultViewId();
      const res = await del(`${workUrl()}/character-views/${defId}`).expect(409);
      expect(res.body.error.details.code).toBe('VIEW_DEFAULT_UNDELETABLE');

      const created = await post(`${workUrl()}/character-views`, { name: '临时' }).expect(201);
      const viewId = created.body.data.id as string;
      await patch(`${workUrl()}/character-views/${viewId}`, { name: '临时改' }).expect(200);
      await del(`${workUrl()}/character-views/${viewId}`).expect(200);
    });

    it('board excludes archived by default and includes them with include_archived=true', async () => {
      const charA = await createCharacter('林昭');
      const viewId = await getDefaultViewId();
      await post(`${workUrl()}/character-views/${viewId}/members`, {
        character_ids: [charA],
      }).expect(200);
      await post(`${charactersUrl()}/${charA}/archive`, {}).expect(200);
      await waitForScans();

      const boardDefault = await get(`${workUrl()}/character-views/${viewId}/board`).expect(200);
      const defaultIds = (boardDefault.body.data.characters as Array<{ id: string }>).map((m) => m.id);
      expect(defaultIds).not.toContain(charA);

      const boardArchived = await get(
        `${workUrl()}/character-views/${viewId}/board?include_archived=true`
      ).expect(200);
      const archivedIds = (boardArchived.body.data.characters as Array<{ id: string }>).map((m) => m.id);
      expect(archivedIds).toContain(charA);
    });

    it('enforces (view_id, character_id) uniqueness; layout put is idempotent and ignores unknown members without bumping version', async () => {
      const charA = await createCharacter('林昭');
      const created = await post(`${workUrl()}/character-views`, { name: '布局板' }).expect(201);
      const viewId = created.body.data.id as string;

      const add = await post(`${workUrl()}/character-views/${viewId}/members`, {
        character_ids: [charA],
      }).expect(200);
      expect(add.body).toBeTruthy();
      const dup = await post(`${workUrl()}/character-views/${viewId}/members`, {
        character_ids: [charA],
      }).expect(200);
      expect(dup.body.data.added).toBe(0);

      const viewsBefore = await get(`${workUrl()}/character-views`).expect(200);
      const versionBefore = (viewsBefore.body.data as Array<{ id: string; version: number }>).find(
        (v) => v.id === viewId
      )!.version;

      const layout = {
        positions: [
          { character_id: charA, x: 10, y: 20, arranged: true },
          { character_id: randomUUID(), x: 1, y: 1, arranged: true },
        ],
      };
      const put1 = await put(`${workUrl()}/character-views/${viewId}/layout`, layout).expect(200);
      const put2 = await put(`${workUrl()}/character-views/${viewId}/layout`, layout).expect(200);
      expect(put1.body.data.updated).toBe(1);
      expect(put1.body.data.ignored).toBe(1);
      expect(put2.body.data.updated).toBe(1);
      expect(put2.body.data.ignored).toBe(1);

      const viewsAfter = await get(`${workUrl()}/character-views`).expect(200);
      const versionAfter = (viewsAfter.body.data as Array<{ id: string; version: number }>).find(
        (v) => v.id === viewId
      )!.version;
      expect(versionAfter).toBe(versionBefore);

      await del(`${workUrl()}/character-views/${viewId}/members/${charA}`).expect(200);
    });
  });

  describe('T24 growth events', () => {
    it('supports growth-event CRUD and warns on missing plot node', async () => {
      const charId = await createCharacter('林昭');
      const base = `${charactersUrl()}/${charId}/growth-events`;

      const created = await post(base, { title: '觉醒', content: '初次觉醒能力' }).expect(201);
      const eventId = created.body.data.event.id as string;
      expect(created.body.data.warnings).toEqual([]);

      const listed = await get(base).expect(200);
      expect((listed.body.data as Array<{ id: string }>).some((e) => e.id === eventId)).toBe(true);

      await patch(`${base}/${eventId}`, { title: '觉醒改' }).expect(200);

      const withMissing = await post(base, {
        title: '节点缺失',
        content: 'x',
        plot_node_id: randomUUID(),
      }).expect(201);
      expect(withMissing.body.data.warnings).toContain('PLOT_NODE_MISSING');

      await del(`${base}/${eventId}`).expect(200);
    });

    it('rejects cross-work chapter (404) and snapshots a same-work plot node title', async () => {
      const charId = await createCharacter('林昭');
      const base = `${charactersUrl()}/${charId}/growth-events`;

      const work2 = (
        await post('/api/v1/works', { title: 'W2', description: 'x' }).expect(201)
      ).body.data.work.id as string;
      const { ChapterEntity } = await import('../src/database/chapter.entity');
      const foreignChapter = await dataSource
        .getRepository(ChapterEntity)
        .findOneByOrFail({ work_id: work2 });
      await post(base, { title: '跨章', content: 'x', chapter_id: foreignChapter.id }).expect(404);

      const treeId = await createPlotTree('主线');
      const nodeId = await createPlotNode(null, '开篇节点');
      const ok = await post(base, {
        title: '归属节点',
        content: 'x',
        plot_node_id: nodeId,
      }).expect(201);
      expect(ok.body.data.warnings).toEqual([]);
      expect(ok.body.data.event.plot_node_title).toBe('开篇节点');
    });
  });

  describe('T25 avatar generations and adopt', () => {
    it('creates a generation task (202) and lists assets', async () => {
      const charId = await createCharacter('林昭');
      const base = `${charactersUrl()}/${charId}/avatar`;
      const gen = await post(`${base}/generations`, { prompt: '黑发少年' }).expect(202);
      expect(gen.body.data.task).toBeTruthy();
      expect(typeof gen.body.data.character_version).toBe('number');

      const list = await get(base).expect(200);
      expect(list.body.data).toHaveProperty('active');
      expect(list.body.data).toHaveProperty('pending');
    });

    it('returns 404 for avatar content without assets', async () => {
      const charId = await createCharacter('苏晚');
      await get(`${charactersUrl()}/${charId}/avatar/content`).expect(404);
    });

    it('adopts a pending asset and supersedes the previous active in one transaction', async () => {
      const charId = await createCharacter('林昭');
      const base = `${charactersUrl()}/${charId}/avatar`;
      const oldActiveId = await seedAvatarAsset(charId, 'active');
      const pendingId = await seedAvatarAsset(charId, 'pending');

      const adopt = await post(`${base}/adopt`, { asset_id: pendingId }).expect(200);
      expect(adopt.body.data.asset.id).toBe(pendingId);
      expect(typeof adopt.body.data.character_version).toBe('number');

      const list = await get(base).expect(200);
      expect(list.body.data.active.id).toBe(pendingId);
      const { CharacterAvatarAssetEntity } = await import('../src/database/character-avatar-asset.entity');
      const old = await dataSource.getRepository(CharacterAvatarAssetEntity).findOneBy({ id: oldActiveId });
      expect(old?.status).toBe('superseded');
    });
  });

  describe('T26 AI candidate drafts', () => {
    it('keeps one pending draft per kind (409) and replays an idempotency key', async () => {
      const url = `/api/v1/works/${workId}/character-ai/drafts`;
      const key = `idem-${randomUUID()}`;
      const first = await request(app.getHttpServer())
        .post(url)
        .set('Cookie', [session.cookie, session.csrf])
        .set('x-csrf-token', session.token)
        .set('idempotency-key', key)
        .send({ kind: 'characters_relations', source: 'work' })
        .expect(202);
      const firstId = first.body.data.draft.id as string;

      const replay = await request(app.getHttpServer())
        .post(url)
        .set('Cookie', [session.cookie, session.csrf])
        .set('x-csrf-token', session.token)
        .set('idempotency-key', key)
        .send({ kind: 'characters_relations', source: 'work' })
        .expect(202);
      expect(replay.body.data.draft.id).toBe(firstId);

      const conflict = await post(url, { kind: 'characters_relations', source: 'work' }).expect(409);
      expect(conflict.body.error.code).toBe('CONFLICT');
    });

    it('lists drafts and fetches a draft with its items', async () => {
      const url = `/api/v1/works/${workId}/character-ai/drafts`;
      const { draftId } = await seedSucceededDraft('characters_relations', [
        { name: 'AI角色', personality: '冷静', age: 20, gender: '男' },
      ]);
      const listed = await get(url).expect(200);
      expect(listed.body.data).toBeTruthy();

      const fetched = await get(`${url}/${draftId}`).expect(200);
      expect(fetched.body.data.draft.id).toBe(draftId);
      expect(Array.isArray(fetched.body.data.items)).toBe(true);
      expect(fetched.body.data.items).toHaveLength(1);
    });

    it('confirm is idempotent returning the first entity id; reject, discard and confirm-batch all work', async () => {
      const { draftId, itemIds } = await seedSucceededDraft('characters_relations', [
        { name: 'AI角色', personality: '冷静', age: 20, gender: '男' },
      ]);
      const itemId = itemIds[0]!;
      const confirmUrl = `/api/v1/works/${workId}/character-ai/drafts/${draftId}/items/${itemId}/confirm`;

      const first = await post(confirmUrl, {}).expect(200);
      const entityId = first.body.data.item.resolved_entity_id as string;
      expect(entityId).toBeTruthy();

      const again = await post(confirmUrl, {}).expect(200);
      expect(again.body.data.item.resolved_entity_id).toBe(entityId);

      const { draftId: d2, itemIds: i2 } = await seedSucceededDraft('characters_relations', [
        { name: 'AI角色2', personality: 'x', age: 1, gender: '男' },
      ]);
      await post(
        `/api/v1/works/${workId}/character-ai/drafts/${d2}/items/${i2[0]!}/reject`,
        {}
      ).expect(200);

      const { draftId: d3 } = await seedSucceededDraft('characters_relations', [
        { name: 'AI角色3', personality: 'x', age: 1, gender: '男' },
      ]);
      await post(`/api/v1/works/${workId}/character-ai/drafts/${d3}/discard`, {}).expect(200);

      const { draftId: d4, itemIds: i4 } = await seedSucceededDraft('characters_relations', [
        { name: '批量1', personality: 'x', age: 1, gender: '男' },
        { name: '批量2', personality: 'y', age: 2, gender: '女' },
      ]);
      const batch = await post(`/api/v1/works/${workId}/character-ai/drafts/${d4}/confirm-batch`, {
        item_ids: [i4[0]!, i4[1]!],
        resolutions: [],
      }).expect(200);
      expect(batch.body.data).toBeTruthy();
    });
  });

  describe('T27 role marks and archive scans (smoke; deep behavior covered by character-anchor.e2e-spec)', () => {
    it('returns role marks structure and hides another work chapter (404)', async () => {
      const chapterId = await getChapterId();
      const marks = await get(
        `/api/v1/works/${workId}/chapters/${chapterId}/role-marks`
      ).expect(200);
      expect(marks.body.data).toBeTruthy();
      expect(marks.body.data.paragraph_marks).toBeDefined();

      const work2 = (
        await post('/api/v1/works', { title: 'W3', description: 'x' }).expect(201)
      ).body.data.work.id as string;
      const { ChapterEntity } = await import('../src/database/chapter.entity');
      const foreignChapter = await dataSource
        .getRepository(ChapterEntity)
        .findOneByOrFail({ work_id: work2 });
      await get(`/api/v1/works/${workId}/chapters/${foreignChapter.id}/role-marks`).expect(404);
    });

    it('dismiss-batch rejects empty anchor_ids (422) and unknown anchor ids are 404', async () => {
      const chapterId = await getChapterId();
      const url = `/api/v1/works/${workId}/chapters/${chapterId}/role-marks/dismiss-batch`;
      await post(url, { anchor_ids: [] }).expect(422);
      await post(url, { anchor_ids: [randomUUID()] }).expect(404);
    });

    it('rejects archive scan on an active character (409)', async () => {
      const charId = await createCharacter('林昭');
      const res = await post(`${charactersUrl()}/${charId}/archive-scans`, {}).expect(409);
      expect(res.body.error.details.code).toBeTruthy();
    });
  });

  describe('T28 portability export and import', () => {
    it('exports active and archived characters with schema_version=2', async () => {
      await createCharacter('林昭');
      const archived = await createCharacter('归档角色');
      await post(`${charactersUrl()}/${archived}/archive`, {}).expect(200);
      await waitForScans();

      const res = await get(`/api/v1/works/${workId}/character-portability/export`).expect(200);
      expect(res.headers['content-disposition']).toBeTruthy();
      expect(res.body.data.schema_version).toBe(2);
      const names = (res.body.data.characters as Array<{ name: string }>).map((c) => c.name);
      expect(names).toContain('林昭');
      expect(names).toContain('归档角色');
    });

    it('previews import without writing business rows and reports conflicts + preview_job_id', async () => {
      await createCharacter('林昭');
      const file = makeImportFile(workId, [{ local_id: 'c1', name: '林昭' }]);
      const preview = await post(
        `/api/v1/works/${workId}/character-portability/import/preview`,
        file
      ).expect(200);
      expect(preview.body.data.preview_job_id).toBeTruthy();
      const conflicts = preview.body.data.conflicts as Array<{ type: string }>;
      expect(conflicts.some((c) => c.type === 'character_duplicate')).toBe(true);

      const chars = await get(charactersUrl()).expect(200);
      expect(chars.body.data.items).toHaveLength(1);
    });

    it('rejects commit without resolving conflicts (409) and exposes the job', async () => {
      await createCharacter('林昭');
      const file = makeImportFile(workId, [{ local_id: 'c1', name: '林昭' }]);
      const preview = await post(
        `/api/v1/works/${workId}/character-portability/import/preview`,
        file
      ).expect(200);
      const previewJobId = preview.body.data.preview_job_id as string;

      const commit = await post(`/api/v1/works/${workId}/character-portability/import/commit`, {
        preview_job_id: previewJobId,
        file,
        mode: 'merge',
        resolutions: [],
        idempotency_key: `commit-${randomUUID()}`,
      }).expect(409);
      expect(commit.body.error.details.code).toBe('PORTABILITY_MISSING_RESOLUTION');

      await get(`/api/v1/works/${workId}/character-portability/jobs/${previewJobId}`).expect(200);
    });
  });

  describe('T29 plot node ownership', () => {
    it('replaces owners as a group and rejects archived characters (409)', async () => {
      const treeId = await createPlotTree('主线');
      const nodeId = await createPlotNode(null, '开篇');
      const charA = await createCharacter('林昭');
      const charB = await createCharacter('苏晚');
      const ownersUrl = `/api/v1/works/${workId}/plot-tree/nodes/${nodeId}/owners`;

      const set = await put(ownersUrl, {
        owners: [{ character_id: charA, is_exclusive: true }],
      }).expect(200);
      expect(set.body.data.node_id).toBe(nodeId);
      const owners = set.body.data.owners as Array<{ character_id: string }>;
      expect(owners.map((o) => o.character_id)).toContain(charA);

      await put(ownersUrl, {
        owners: [{ character_id: charB, is_exclusive: true }],
      }).expect(200);

      const archived = await createCharacter('归档');
      await post(`${charactersUrl()}/${archived}/archive`, {}).expect(200);
      await waitForScans();
      const blocked = await put(ownersUrl, {
        owners: [{ character_id: archived, is_exclusive: true }],
      }).expect(409);
      expect(blocked.body.error.details.code).toBe('PLOT_OWNER_CHARACTER_ARCHIVED');
    });

    it('cannot remove ownership of an archived character (409)', async () => {
      const treeId = await createPlotTree('主线2');
      const nodeId = await createPlotNode(null, '节点');
      const charA = await createCharacter('林昭');
      const ownersUrl = `/api/v1/works/${workId}/plot-tree/nodes/${nodeId}/owners`;
      await put(ownersUrl, {
        owners: [{ character_id: charA, is_exclusive: true }],
      }).expect(200);

      await post(`${charactersUrl()}/${charA}/archive`, {}).expect(200);
      await waitForScans();
      const blocked = await del(`${ownersUrl}/${charA}`).expect(409);
      expect(blocked.body.error.details.code).toBe('PLOT_OWNER_CHARACTER_ARCHIVED');
    });
  });

  describe('version conflict and csrf enforcement', () => {
    it('returns 409 on wrong expected_version and succeeds with the correct version', async () => {
      const charId = await createCharacter('林昭');
      const detail = await get(`${charactersUrl()}/${charId}`).expect(200);
      const version = detail.body.data.character.version as number;

      const wrong = await patch(`${charactersUrl()}/${charId}`, {
        name: 'x',
        expected_version: version + 99,
      }).expect(409);
      expect(wrong.body.error.details.code).toBe('CHARACTER_VERSION_CONFLICT');

      const ok = await patch(`${charactersUrl()}/${charId}`, {
        name: '林昭改',
        expected_version: version,
      }).expect(200);
      expect(ok.body.data.version).toBe(version + 1);
    });

    it('rejects write operations (PATCH/PUT) without a csrf token (403)', async () => {
      const charId = await createCharacter('林昭');
      await request(app.getHttpServer())
        .patch(`${charactersUrl()}/${charId}`)
        .set('Cookie', [session.cookie, session.csrf])
        .send({ name: 'y' })
        .expect(403);

      const viewId = await getDefaultViewId();
      await request(app.getHttpServer())
        .put(`${workUrl()}/character-views/${viewId}/layout`)
        .set('Cookie', [session.cookie, session.csrf])
        .send({ nodes: [], edges: [] })
        .expect(403);
    });
  });

  it('registers exactly 50 character-domain endpoints (9+8+8+4+4+7+4+4+2)', () => {
    const routes = registeredRoutes();
    const expected = [
      // T21 角色（9）
      'GET /api/v1/works/:workId/characters/duplicates',
      'POST /api/v1/works/:workId/characters/random',
      'GET /api/v1/works/:workId/characters',
      'POST /api/v1/works/:workId/characters',
      'GET /api/v1/works/:workId/characters/:characterId',
      'PATCH /api/v1/works/:workId/characters/:characterId',
      'POST /api/v1/works/:workId/characters/:characterId/archive',
      'POST /api/v1/works/:workId/characters/:characterId/restore',
      'POST /api/v1/works/:workId/characters/:characterId/merge',
      // T22 关系（8）
      'GET /api/v1/works/:workId/character-relation-types',
      'POST /api/v1/works/:workId/character-relation-types',
      'PATCH /api/v1/works/:workId/character-relation-types/:typeId',
      'DELETE /api/v1/works/:workId/character-relation-types/:typeId',
      'GET /api/v1/works/:workId/character-relations',
      'POST /api/v1/works/:workId/character-relations',
      'PATCH /api/v1/works/:workId/character-relations/:relationId',
      'DELETE /api/v1/works/:workId/character-relations/:relationId',
      // T23 视图（8）
      'GET /api/v1/works/:workId/character-views',
      'POST /api/v1/works/:workId/character-views',
      'PATCH /api/v1/works/:workId/character-views/:viewId',
      'DELETE /api/v1/works/:workId/character-views/:viewId',
      'GET /api/v1/works/:workId/character-views/:viewId/board',
      'POST /api/v1/works/:workId/character-views/:viewId/members',
      'DELETE /api/v1/works/:workId/character-views/:viewId/members/:characterId',
      'PUT /api/v1/works/:workId/character-views/:viewId/layout',
      // T24 成长线（4）
      'GET /api/v1/works/:workId/characters/:characterId/growth-events',
      'POST /api/v1/works/:workId/characters/:characterId/growth-events',
      'PATCH /api/v1/works/:workId/characters/:characterId/growth-events/:eventId',
      'DELETE /api/v1/works/:workId/characters/:characterId/growth-events/:eventId',
      // T25 头像（4）
      'POST /api/v1/works/:workId/characters/:characterId/avatar/generations',
      'GET /api/v1/works/:workId/characters/:characterId/avatar',
      'GET /api/v1/works/:workId/characters/:characterId/avatar/content',
      'POST /api/v1/works/:workId/characters/:characterId/avatar/adopt',
      // T26 AI 候选（7）
      'POST /api/v1/works/:workId/character-ai/drafts',
      'GET /api/v1/works/:workId/character-ai/drafts',
      'GET /api/v1/works/:workId/character-ai/drafts/:draftId',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/items/:itemId/confirm',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/items/:itemId/reject',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/confirm-batch',
      'POST /api/v1/works/:workId/character-ai/drafts/:draftId/discard',
      // T27 锚点（4）
      'GET /api/v1/works/:workId/chapters/:chapterId/role-marks',
      'POST /api/v1/works/:workId/chapters/:chapterId/role-marks/:anchorId/dismiss',
      'POST /api/v1/works/:workId/chapters/:chapterId/role-marks/dismiss-batch',
      'POST /api/v1/works/:workId/characters/:characterId/archive-scans',
      // T28 导入导出（4）
      'GET /api/v1/works/:workId/character-portability/export',
      'POST /api/v1/works/:workId/character-portability/import/preview',
      'POST /api/v1/works/:workId/character-portability/import/commit',
      'GET /api/v1/works/:workId/character-portability/jobs/:jobId',
      // T29 剧情归属（2）
      'PUT /api/v1/works/:workId/plot-tree/nodes/:nodeId/owners',
      'DELETE /api/v1/works/:workId/plot-tree/nodes/:nodeId/owners/:characterId'
    ];
    expect(expected).toHaveLength(50);
    const missing = expected.filter((route) => !routes.has(route));
    expect(missing).toEqual([]);
    const characterRoutes = [...routes].filter(
      (route) => route.includes('/characters') || route.includes('/character-')
    );
    expect(characterRoutes.some((route) => route.toLowerCase().includes('purge'))).toBe(false);
    expect(routes.has('DELETE /api/v1/works/:workId/characters/:characterId')).toBe(false);
    expect([...routes].some((route) => /agent-persona|impersonat/.test(route))).toBe(false);
  });

  function registeredRoutes(): Set<string> {
    type Layer = {
      route?: { path: string; methods: Record<string, boolean> };
    };
    type RouterLike = { stack: Layer[] };
    const instance = app.getHttpAdapter().getInstance() as unknown as {
      router?: RouterLike;
      _router?: RouterLike;
    };
    const router = instance.router ?? instance._router;
    expect(router).toBeTruthy();
    const set = new Set<string>();
    for (const layer of router!.stack) {
      if (!layer.route) continue;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (!enabled) continue;
        set.add(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    return set;
  }
});
