import { beforeEach, describe, expect, it, vi } from 'vitest';
import { characterClient } from './character-client';

// Mock api/client，让 apiRequest 只做 fetch 不做 Zod 校验
const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> | undefined }> = [];
vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string, public details: unknown, public requestId: string) {
      super(message); this.name = 'ApiError';
    }
  },
  apiRequest: async (path: string, _schema: unknown, init: RequestInit = {}): Promise<unknown> => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      url: path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init.headers as Record<string, string> | undefined)
    });
    return { __placeholder: true };
  }
}));

const workId = '11111111-1111-4111-8111-111111111111';
const characterId = '22222222-2222-4222-8222-222222222222';
const viewId = '33333333-3333-4333-8333-333333333333';
const relationId = '44444444-4444-4444-8444-444444444444';
const draftId = '66666666-6666-4666-8666-666666666666';
const itemId = '77777777-7777-4777-8777-777777777777';
const chapterId = '88888888-8888-4888-8888-888888888888';
const nodeId = '99999999-9999-4999-8999-999999999999';
const uuidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const uuidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uuidC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => { calls.length = 0; });

describe('character-client · 角色 T21', () => {
  it('lists characters with query params encoded', async () => {
    await characterClient.listCharacters(workId, { keyword: '林墨', status: 'active', limit: 50 });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/works/${workId}/characters?limit=50&status=active&keyword=%E6%9E%97%E5%A2%A8`
    });
  });
  it('archives with expected_version in body', async () => {
    await characterClient.archiveCharacter(workId, characterId, 3);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/characters/${characterId}/archive`,
      body: { expected_version: 3 }
    });
  });
  it('uses static routes before :characterId', async () => {
    await characterClient.listDuplicates(workId);
    expect(calls[0]).toMatchObject({ url: `/api/v1/works/${workId}/characters/duplicates`, method: 'GET' });
    await characterClient.randomDossier(workId, 'seed-x');
    expect(calls[1]).toMatchObject({ url: `/api/v1/works/${workId}/characters/random`, method: 'POST' });
  });
});

describe('character-client · 关系 / 视图 / 布局', () => {
  it('gets board for a view', async () => {
    await characterClient.getBoard(workId, viewId, true);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/works/${workId}/character-views/${viewId}/board?include_archived=true`
    });
  });
  it('batches layout PUT with positions', async () => {
    await characterClient.updateLayout(workId, viewId, [
      { character_id: characterId, x: 100, y: 200, arranged: true }
    ]);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `/api/v1/works/${workId}/character-views/${viewId}/layout`,
      body: { positions: [{ character_id: characterId, x: 100, y: 200, arranged: true }] }
    });
  });
  it('lists relations with optional filters as query strings', async () => {
    await characterClient.listRelations(workId, { character_id: characterId, include_archived: false });
    expect(calls[0]!.url).toContain(`character_id=${characterId}`);
    expect(calls[0]!.url).toContain('include_archived=false');
  });
  it('creates relations with correct required fields', async () => {
    await characterClient.createRelation(workId, { source_id: uuidA, target_id: uuidB, type_id: uuidC, directed: true, label: '师徒' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/character-relations` });
  });
  it('CRUD relation types and views', async () => {
    await characterClient.listRelationTypes(workId);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/api/v1/works/${workId}/character-relation-types` });
    await characterClient.deleteRelationType(workId, 'type-x');
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: `/api/v1/works/${workId}/character-relation-types/type-x` });
    await characterClient.listViews(workId);
    expect(calls[2]).toMatchObject({ method: 'GET', url: `/api/v1/works/${workId}/character-views` });
    await characterClient.deleteView(workId, viewId);
    expect(calls[3]).toMatchObject({ method: 'DELETE', url: `/api/v1/works/${workId}/character-views/${viewId}` });
    await characterClient.addViewMembers(workId, viewId, [characterId]);
    expect(calls[4]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/character-views/${viewId}/members` });
    await characterClient.removeViewMember(workId, viewId, characterId);
    expect(calls[5]).toMatchObject({ method: 'DELETE', url: `/api/v1/works/${workId}/character-views/${viewId}/members/${characterId}` });
  });
});

describe('character-client · 成长线 / 头像 / AI', () => {
  it('creates growth event with POST', async () => {
    await characterClient.createGrowthEvent(workId, characterId, { title: '初遇' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/characters/${characterId}/growth-events`
    });
  });
  it('generate and adopt avatar use correct endpoints', async () => {
    await characterClient.generateAvatar(workId, characterId);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/characters/${characterId}/avatar/generations` });
    await characterClient.adoptAvatar(workId, characterId, uuidA, 5);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/characters/${characterId}/avatar/adopt`,
      body: { asset_id: uuidA, expected_version: 5 }
    });
  });
  it('createAiDraft passes idempotency-key header when provided', async () => {
    await characterClient.createAiDraft(workId, { kind: 'characters_relations', source: 'work' }, 'idem-1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/character-ai/drafts`,
      headers: { 'idempotency-key': 'idem-1' }
    });
  });
  it('confirm / reject / batch / discard use draft/item path', async () => {
    await characterClient.confirmAiItem(workId, draftId, itemId, {});
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/character-ai/drafts/${draftId}/items/${itemId}/confirm` });
    await characterClient.rejectAiItem(workId, draftId, itemId);
    expect(calls[1]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/character-ai/drafts/${draftId}/items/${itemId}/reject` });
    await characterClient.confirmAiBatch(workId, draftId, { item_ids: [itemId] });
    expect(calls[2]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/character-ai/drafts/${draftId}/confirm-batch` });
    await characterClient.discardAiDraft(workId, draftId);
    expect(calls[3]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/character-ai/drafts/${draftId}/discard` });
  });
  it('list/get drafts and avatar GET', async () => {
    await characterClient.listAiDrafts(workId, { limit: 10 });
    expect(calls[0]).toMatchObject({ url: `/api/v1/works/${workId}/character-ai/drafts?limit=10`, method: 'GET' });
    await characterClient.getAiDraft(workId, draftId);
    expect(calls[1]).toMatchObject({ url: `/api/v1/works/${workId}/character-ai/drafts/${draftId}`, method: 'GET' });
    await characterClient.getAvatar(workId, characterId);
    expect(calls[2]).toMatchObject({ url: `/api/v1/works/${workId}/characters/${characterId}/avatar`, method: 'GET' });
    await characterClient.listGrowthEvents(workId, characterId);
    expect(calls[3]).toMatchObject({ url: `/api/v1/works/${workId}/characters/${characterId}/growth-events`, method: 'GET' });
  });
});

describe('character-client · 锚点 / 导入导出 / 剧情归属', () => {
  it('role-marks and dismiss-batch hit correct anchor endpoints', async () => {
    await characterClient.getChapterRoleMarks(workId, chapterId);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/api/v1/works/${workId}/chapters/${chapterId}/role-marks` });
    await characterClient.dismissAnchorsBatch(workId, chapterId, [itemId]);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/chapters/${chapterId}/role-marks/dismiss-batch`,
      body: { anchor_ids: [itemId] }
    });
    await characterClient.rescanArchive(workId, characterId);
    expect(calls[2]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/characters/${characterId}/archive-scans` });
  });
  it('export / preview / commit / job', async () => {
    await characterClient.exportFile(workId, { include_archived: false });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/api/v1/works/${workId}/character-portability/export?include_archived=false` });
    const file = { schema_version: 2 as const, work: { id: workId, title: 'w' }, relation_types: [], characters: [], relations: [], growth_events: [], views: [] };
    await characterClient.previewImport(workId, file, 'idem-x');
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/character-portability/import/preview`,
      headers: { 'idempotency-key': 'idem-x' }
    });
    await characterClient.getPortabilityJob(workId, 'job-x');
    expect(calls[2]).toMatchObject({ method: 'GET', url: `/api/v1/works/${workId}/character-portability/jobs/job-x` });
  });
  it('plot owner endpoints PUT and DELETE', async () => {
    await characterClient.setPlotNodeOwners(workId, nodeId, [{ character_id: characterId, is_exclusive: true }]);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `/api/v1/works/${workId}/plot-tree/nodes/${nodeId}/owners`,
      body: { owners: [{ character_id: characterId, is_exclusive: true }] }
    });
    await characterClient.removePlotNodeOwner(workId, nodeId, characterId);
    expect(calls[1]).toMatchObject({
      method: 'DELETE',
      url: `/api/v1/works/${workId}/plot-tree/nodes/${nodeId}/owners/${characterId}`
    });
  });
});

describe('character-client · 头像内容 URL', () => {
  it('builds GET URL that matches avatar content endpoint', () => {
    expect(characterClient.getAvatarContentUrl(workId, characterId, 'asset-1'))
      .toBe(`/api/v1/works/${workId}/characters/${characterId}/avatar/content?asset_id=asset-1`);
    expect(characterClient.getAvatarContentUrl(workId, characterId))
      .toBe(`/api/v1/works/${workId}/characters/${characterId}/avatar/content`);
  });
});
