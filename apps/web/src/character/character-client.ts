import { z } from 'zod';
import {
  characterSchema,
  characterBoardResponseSchema,
  characterRelationSchema,
  characterRelationTypeSchema,
  characterGrowthEventSchema,
  characterAvatarAssetSchema,
  characterViewSchema,
  characterDuplicateGroupsResponseSchema,
  randomCharacterResponseSchema,
  archiveCharacterResponseSchema,
  restoreCharacterResponseSchema,
  characterAiDraftSchema,
  characterAiCandidateItemSchema,
  characterAiDraftDetailResponseSchema,
  chapterRoleMarksSchema,
  archiveScanSchema,
  characterImportFileSchema,
  characterImportPreviewResponseSchema,
  characterPortabilityJobSchema,
  plotNodeOwnersResponseSchema,
  aiTaskSchema,
  createCharacterRequestSchema,
  updateCharacterRequestSchema,
  randomCharacterRequestSchema,
  archiveCharacterRequestSchema,
  mergeCharacterRequestSchema,
  createCharacterRelationTypeRequestSchema,
  updateCharacterRelationTypeRequestSchema,
  createCharacterRelationRequestSchema,
  updateCharacterRelationRequestSchema,
  createCharacterViewRequestSchema,
  updateCharacterViewRequestSchema,
  addCharacterViewMembersRequestSchema,
  updateCharacterViewLayoutRequestSchema,
  createCharacterGrowthEventRequestSchema,
  updateCharacterGrowthEventRequestSchema,
  adoptCharacterAvatarRequestSchema,
  createCharacterAiDraftRequestSchema,
  confirmCharacterAiItemRequestSchema,
  rejectCharacterAiItemRequestSchema,
  confirmCharacterAiItemsRequestSchema,
  discardCharacterAiDraftRequestSchema,
  dismissAnchorRequestSchema,
  dismissAnchorsRequestSchema,
  characterExportQuerySchema,
  characterImportCommitRequestSchema,
  setPlotNodeOwnersRequestSchema,
  type Character,
  type CharacterGrowthEvent,
  type CharacterAvatarAsset,
  type CharacterRelationType,
  type CharacterRelation,
  type CharacterBoardResponse,
  type CharacterAiDraft,
  type CharacterAiCandidateItem,
  type ChapterRoleMarks,
  type ArchiveScan,
  type CharacterPortabilityJob,
  type CharacterView
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

// PlotNodeOwnersResponse 由 plotNodeOwnersResponseSchema 推断，contracts 包未直接导出 type
type PlotNodeOwnersResponse = z.infer<typeof plotNodeOwnersResponseSchema>;

// M3c-2 角色域全部 50 个端点的类型化客户端（T31）

const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const root = '/api/v1/works';

// ── 结果 Schema ──

const characterListResultSchema = z.object({
  items: z.array(characterSchema),
  next_cursor: z.string().nullable()
});

const characterDetailResultSchema = z.object({
  character: characterSchema,
  relation_summary: z.object({ total: z.number().int().nonnegative() }),
  growth_event_count: z.number().int().nonnegative()
});

const versionResultSchema = z.object({ version: z.number().int() });
const deletedResultSchema = z.object({ deleted: z.literal(true) });
const addedCountSchema = z.object({ added: z.number().int().nonnegative() });
const removedCountSchema = z.object({ removed: z.number().int().nonnegative() });
const updatedCountSchema = z.object({ updated: z.number().int().nonnegative() });

const growthCreateResultSchema = z.object({
  event: characterGrowthEventSchema,
  warnings: z.array(z.string())
});

const avatarCurrentResultSchema = z.object({
  active: characterAvatarAssetSchema.nullable(),
  pending: z.array(characterAvatarAssetSchema)
});

const avatarGenerateResultSchema = z.object({
  task: aiTaskSchema,
  character_version: z.number().int()
});

const avatarAdoptResultSchema = z.object({
  asset: characterAvatarAssetSchema,
  character_version: z.number().int()
});

const anchorDismissResultSchema = z.object({
  anchor_id: z.string().uuid(),
  dismissed: z.literal(true)
});

const anchorDismissBatchResultSchema = z.object({
  dismissed: z.number().int().nonnegative()
});

const scanRescanResultSchema = z.object({ scan: archiveScanSchema });

const characterAiCreateResultSchema = z.object({
  draft: characterAiDraftSchema,
  task: aiTaskSchema
});

const characterAiConfirmResultSchema = z.object({ item: characterAiCandidateItemSchema });

const characterAiConfirmBatchResultSchema = z.object({
  confirmed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative()
});

const portabilityCommitResultSchema = z.record(z.unknown());

// ── 前端查询参数类型 ──

export interface CharacterListQuery {
  limit?: number;
  cursor?: number;
  status?: 'active' | 'archived';
  keyword?: string;
  country_region?: string;
  faith?: string;
  faction?: string;
  race?: string;
  occupation?: string;
  age_band?: string;
}

export interface RelationListQuery {
  type_id?: string;
  character_id?: string;
  include_archived?: boolean;
}

// ── Client 接口 ──

export interface CharacterClient {
  // T21 角色 9 端点
  listCharacters(workId: string, query?: CharacterListQuery): Promise<{ items: Character[]; next_cursor: string | null }>;
  createCharacter(workId: string, input: z.input<typeof createCharacterRequestSchema>): Promise<Character>;
  getCharacter(workId: string, characterId: string): Promise<{ character: Character; relation_summary: { total: number }; growth_event_count: number }>;
  updateCharacter(workId: string, characterId: string, patch: z.input<typeof updateCharacterRequestSchema>, expectedVersion?: number): Promise<Character>;
  archiveCharacter(workId: string, characterId: string, expectedVersion?: number): Promise<z.infer<typeof archiveCharacterResponseSchema>>;
  restoreCharacter(workId: string, characterId: string): Promise<z.infer<typeof restoreCharacterResponseSchema>>;
  mergeCharacter(workId: string, characterId: string, input: z.input<typeof mergeCharacterRequestSchema>): Promise<{ version: number }>;
  listDuplicates(workId: string): Promise<z.infer<typeof characterDuplicateGroupsResponseSchema>>;
  randomDossier(workId: string, seed?: string): Promise<z.infer<typeof randomCharacterResponseSchema>>;

  // T22 关系类型 4 端点
  listRelationTypes(workId: string): Promise<CharacterRelationType[]>;
  createRelationType(workId: string, input: z.input<typeof createCharacterRelationTypeRequestSchema>): Promise<CharacterRelationType>;
  updateRelationType(workId: string, typeId: string, patch: z.input<typeof updateCharacterRelationTypeRequestSchema>): Promise<CharacterRelationType>;
  deleteRelationType(workId: string, typeId: string): Promise<{ deleted: true }>;

  // T22 关系 4 端点
  listRelations(workId: string, query?: RelationListQuery): Promise<CharacterRelation[]>;
  createRelation(workId: string, input: z.input<typeof createCharacterRelationRequestSchema>): Promise<{ id: string; created: boolean }>;
  updateRelation(workId: string, relationId: string, patch: z.input<typeof updateCharacterRelationRequestSchema>): Promise<CharacterRelation>;
  deleteRelation(workId: string, relationId: string): Promise<{ deleted: true }>;

  // T23 视图 8 端点
  listViews(workId: string): Promise<CharacterView[]>;
  createView(workId: string, input: z.input<typeof createCharacterViewRequestSchema>): Promise<CharacterView>;
  updateView(workId: string, viewId: string, patch: z.input<typeof updateCharacterViewRequestSchema>): Promise<CharacterView>;
  deleteView(workId: string, viewId: string): Promise<{ deleted: true }>;
  getBoard(workId: string, viewId: string, includeArchived?: boolean): Promise<CharacterBoardResponse>;
  addViewMembers(workId: string, viewId: string, characterIds: string[]): Promise<{ added: number }>;
  removeViewMember(workId: string, viewId: string, characterId: string): Promise<{ removed: number }>;
  updateLayout(workId: string, viewId: string, positions: z.input<typeof updateCharacterViewLayoutRequestSchema>['positions']): Promise<{ updated: number }>;

  // T24 成长线 4 端点
  listGrowthEvents(workId: string, characterId: string): Promise<CharacterGrowthEvent[]>;
  createGrowthEvent(workId: string, characterId: string, input: z.input<typeof createCharacterGrowthEventRequestSchema>): Promise<{ event: CharacterGrowthEvent; warnings: string[] }>;
  updateGrowthEvent(workId: string, characterId: string, eventId: string, patch: z.input<typeof updateCharacterGrowthEventRequestSchema>): Promise<{ event: CharacterGrowthEvent }>;
  deleteGrowthEvent(workId: string, characterId: string, eventId: string): Promise<{ deleted: true }>;

  // T25 头像 4 端点
  generateAvatar(workId: string, characterId: string): Promise<z.infer<typeof avatarGenerateResultSchema>>;
  getAvatar(workId: string, characterId: string): Promise<z.infer<typeof avatarCurrentResultSchema>>;
  getAvatarContentUrl(workId: string, characterId: string, assetId?: string): string;
  adoptAvatar(workId: string, characterId: string, assetId: string, expectedVersion?: number): Promise<z.infer<typeof avatarAdoptResultSchema>>;

  // T26 AI 候选 7 端点
  createAiDraft(workId: string, input: z.input<typeof createCharacterAiDraftRequestSchema>, idempotencyKey?: string): Promise<z.infer<typeof characterAiCreateResultSchema>>;
  listAiDrafts(workId: string, query?: { limit?: number; cursor?: string }): Promise<CharacterAiDraft[]>;
  getAiDraft(workId: string, draftId: string): Promise<z.infer<typeof characterAiDraftDetailResponseSchema>>;
  confirmAiItem(workId: string, draftId: string, itemId: string, input: z.input<typeof confirmCharacterAiItemRequestSchema>): Promise<z.infer<typeof characterAiConfirmResultSchema>>;
  rejectAiItem(workId: string, draftId: string, itemId: string, reason?: string): Promise<z.infer<typeof characterAiConfirmResultSchema>>;
  confirmAiBatch(workId: string, draftId: string, input: z.input<typeof confirmCharacterAiItemsRequestSchema>): Promise<z.infer<typeof characterAiConfirmBatchResultSchema>>;
  discardAiDraft(workId: string, draftId: string, reason?: string): Promise<CharacterAiDraft>;

  // T27 锚点与扫描 4 端点
  getChapterRoleMarks(workId: string, chapterId: string): Promise<ChapterRoleMarks>;
  dismissAnchor(workId: string, chapterId: string, anchorId: string, reason?: string): Promise<z.infer<typeof anchorDismissResultSchema>>;
  dismissAnchorsBatch(workId: string, chapterId: string, anchorIds: string[]): Promise<z.infer<typeof anchorDismissBatchResultSchema>>;
  rescanArchive(workId: string, characterId: string): Promise<z.infer<typeof scanRescanResultSchema>>;

  // T28 导入导出 4 端点
  exportFile(workId: string, query?: z.input<typeof characterExportQuerySchema>): Promise<z.infer<typeof characterImportFileSchema>>;
  previewImport(workId: string, file: z.input<typeof characterImportFileSchema>, idempotencyKey?: string): Promise<z.infer<typeof characterImportPreviewResponseSchema>>;
  commitImport(workId: string, input: z.input<typeof characterImportCommitRequestSchema>): Promise<z.infer<typeof portabilityCommitResultSchema>>;
  getPortabilityJob(workId: string, jobId: string): Promise<CharacterPortabilityJob>;

  // T29 剧情归属 2 端点
  setPlotNodeOwners(workId: string, nodeId: string, owners: z.input<typeof setPlotNodeOwnersRequestSchema>['owners']): Promise<PlotNodeOwnersResponse>;
  removePlotNodeOwner(workId: string, nodeId: string, characterId: string): Promise<{ node_id: string; removed: number }>;
}

// ── 实现 ──

export const characterClient: CharacterClient = {
  // T21 角色
  listCharacters(workId, query) {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    if (query?.cursor !== undefined) params.set('cursor', String(query.cursor));
    if (query?.status) params.set('status', query.status);
    if (query?.keyword) params.set('keyword', query.keyword);
    for (const dim of ['country_region', 'faith', 'faction', 'race', 'occupation', 'age_band'] as const) {
      if (query?.[dim]) params.set(dim, query[dim]);
    }
    const qs = params.toString();
    return apiRequest(`${root}/${part(workId)}/characters${qs ? `?${qs}` : ''}`, characterListResultSchema);
  },
  createCharacter(workId, input) {
    return apiRequest(`${root}/${part(workId)}/characters`, characterSchema, json('POST', createCharacterRequestSchema.parse(input)));
  },
  getCharacter(workId, characterId) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}`, characterDetailResultSchema);
  },
  updateCharacter(workId, characterId, patch, expectedVersion) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}`, characterSchema,
      json('PATCH', updateCharacterRequestSchema.parse({ ...patch, expected_version: expectedVersion })));
  },
  archiveCharacter(workId, characterId, expectedVersion) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/archive`, archiveCharacterResponseSchema,
      json('POST', archiveCharacterRequestSchema.parse({ expected_version: expectedVersion })));
  },
  restoreCharacter(workId, characterId) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/restore`, restoreCharacterResponseSchema, { method: 'POST' });
  },
  mergeCharacter(workId, characterId, input) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/merge`, versionResultSchema,
      json('POST', mergeCharacterRequestSchema.parse(input)));
  },
  listDuplicates(workId) {
    return apiRequest(`${root}/${part(workId)}/characters/duplicates`, characterDuplicateGroupsResponseSchema);
  },
  randomDossier(workId, seed) {
    return apiRequest(`${root}/${part(workId)}/characters/random`, randomCharacterResponseSchema,
      json('POST', randomCharacterRequestSchema.parse({ seed })));
  },

  // T22 关系类型 + 关系
  listRelationTypes(workId) {
    return apiRequest(`${root}/${part(workId)}/character-relation-types`, z.array(characterRelationTypeSchema));
  },
  createRelationType(workId, input) {
    return apiRequest(`${root}/${part(workId)}/character-relation-types`, characterRelationTypeSchema,
      json('POST', createCharacterRelationTypeRequestSchema.parse(input)));
  },
  updateRelationType(workId, typeId, patch) {
    return apiRequest(`${root}/${part(workId)}/character-relation-types/${part(typeId)}`, characterRelationTypeSchema,
      json('PATCH', updateCharacterRelationTypeRequestSchema.parse(patch)));
  },
  deleteRelationType(workId, typeId) {
    return apiRequest(`${root}/${part(workId)}/character-relation-types/${part(typeId)}`, deletedResultSchema, { method: 'DELETE' });
  },
  listRelations(workId, query) {
    const params = new URLSearchParams();
    if (query?.type_id) params.set('type_id', query.type_id);
    if (query?.character_id) params.set('character_id', query.character_id);
    if (query?.include_archived !== undefined) params.set('include_archived', String(query.include_archived));
    const qs = params.toString();
    return apiRequest(`${root}/${part(workId)}/character-relations${qs ? `?${qs}` : ''}`, z.array(characterRelationSchema));
  },
  createRelation(workId, input) {
    return apiRequest(`${root}/${part(workId)}/character-relations`, z.object({ id: z.string().uuid(), created: z.boolean() }),
      json('POST', createCharacterRelationRequestSchema.parse(input)));
  },
  updateRelation(workId, relationId, patch) {
    return apiRequest(`${root}/${part(workId)}/character-relations/${part(relationId)}`, characterRelationSchema,
      json('PATCH', updateCharacterRelationRequestSchema.parse(patch)));
  },
  deleteRelation(workId, relationId) {
    return apiRequest(`${root}/${part(workId)}/character-relations/${part(relationId)}`, deletedResultSchema, { method: 'DELETE' });
  },

  // T23 视图
  listViews(workId) {
    return apiRequest(`${root}/${part(workId)}/character-views`, z.array(characterViewSchema));
  },
  createView(workId, input) {
    return apiRequest(`${root}/${part(workId)}/character-views`, characterViewSchema,
      json('POST', createCharacterViewRequestSchema.parse(input)));
  },
  updateView(workId, viewId, patch) {
    return apiRequest(`${root}/${part(workId)}/character-views/${part(viewId)}`, characterViewSchema,
      json('PATCH', updateCharacterViewRequestSchema.parse(patch)));
  },
  deleteView(workId, viewId) {
    return apiRequest(`${root}/${part(workId)}/character-views/${part(viewId)}`, deletedResultSchema, { method: 'DELETE' });
  },
  getBoard(workId, viewId, includeArchived) {
    const qs = includeArchived ? '?include_archived=true' : '';
    return apiRequest(`${root}/${part(workId)}/character-views/${part(viewId)}/board${qs}`, characterBoardResponseSchema);
  },
  addViewMembers(workId, viewId, characterIds) {
    return apiRequest(`${root}/${part(workId)}/character-views/${part(viewId)}/members`, addedCountSchema,
      json('POST', addCharacterViewMembersRequestSchema.parse({ character_ids: characterIds })));
  },
  removeViewMember(workId, viewId, characterId) {
    return apiRequest(`${root}/${part(workId)}/character-views/${part(viewId)}/members/${part(characterId)}`, removedCountSchema, { method: 'DELETE' });
  },
  updateLayout(workId, viewId, positions) {
    return apiRequest(`${root}/${part(workId)}/character-views/${part(viewId)}/layout`, updatedCountSchema,
      json('PUT', updateCharacterViewLayoutRequestSchema.parse({ positions })));
  },

  // T24 成长线
  listGrowthEvents(workId, characterId) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/growth-events`, z.array(characterGrowthEventSchema));
  },
  createGrowthEvent(workId, characterId, input) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/growth-events`, growthCreateResultSchema,
      json('POST', createCharacterGrowthEventRequestSchema.parse(input)));
  },
  updateGrowthEvent(workId, characterId, eventId, patch) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/growth-events/${part(eventId)}`,
      z.object({ event: characterGrowthEventSchema }),
      json('PATCH', updateCharacterGrowthEventRequestSchema.parse(patch)));
  },
  deleteGrowthEvent(workId, characterId, eventId) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/growth-events/${part(eventId)}`, deletedResultSchema, { method: 'DELETE' });
  },

  // T25 头像
  generateAvatar(workId, characterId) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/avatar/generations`, avatarGenerateResultSchema, { method: 'POST' });
  },
  getAvatar(workId, characterId) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/avatar`, avatarCurrentResultSchema);
  },
  getAvatarContentUrl(workId, characterId, assetId) {
    const base = `${root}/${part(workId)}/characters/${part(characterId)}/avatar/content`;
    return assetId ? `${base}?asset_id=${part(assetId)}` : base;
  },
  adoptAvatar(workId, characterId, assetId, expectedVersion) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/avatar/adopt`, avatarAdoptResultSchema,
      json('POST', adoptCharacterAvatarRequestSchema.parse({ asset_id: assetId, expected_version: expectedVersion })));
  },

  // T26 AI 候选
  createAiDraft(workId, input, idempotencyKey) {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return apiRequest(`${root}/${part(workId)}/character-ai/drafts`, characterAiCreateResultSchema,
      { ...json('POST', createCharacterAiDraftRequestSchema.parse(input)), headers });
  },
  listAiDrafts(workId, query) {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) params.set('limit', String(query.limit));
    if (query?.cursor) params.set('cursor', query.cursor);
    const qs = params.toString();
    return apiRequest(`${root}/${part(workId)}/character-ai/drafts${qs ? `?${qs}` : ''}`, z.array(characterAiDraftSchema));
  },
  getAiDraft(workId, draftId) {
    return apiRequest(`${root}/${part(workId)}/character-ai/drafts/${part(draftId)}`, characterAiDraftDetailResponseSchema);
  },
  confirmAiItem(workId, draftId, itemId, input) {
    return apiRequest(`${root}/${part(workId)}/character-ai/drafts/${part(draftId)}/items/${part(itemId)}/confirm`, characterAiConfirmResultSchema,
      json('POST', confirmCharacterAiItemRequestSchema.parse(input)));
  },
  rejectAiItem(workId, draftId, itemId, reason) {
    return apiRequest(`${root}/${part(workId)}/character-ai/drafts/${part(draftId)}/items/${part(itemId)}/reject`, characterAiConfirmResultSchema,
      json('POST', rejectCharacterAiItemRequestSchema.parse({ reason })));
  },
  confirmAiBatch(workId, draftId, input) {
    return apiRequest(`${root}/${part(workId)}/character-ai/drafts/${part(draftId)}/confirm-batch`, characterAiConfirmBatchResultSchema,
      json('POST', confirmCharacterAiItemsRequestSchema.parse(input)));
  },
  discardAiDraft(workId, draftId, reason) {
    return apiRequest(`${root}/${part(workId)}/character-ai/drafts/${part(draftId)}/discard`, characterAiDraftSchema,
      json('POST', discardCharacterAiDraftRequestSchema.parse({ reason })));
  },

  // T27 锚点与扫描
  getChapterRoleMarks(workId, chapterId) {
    return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/role-marks`, chapterRoleMarksSchema);
  },
  dismissAnchor(workId, chapterId, anchorId, reason) {
    return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/role-marks/${part(anchorId)}/dismiss`, anchorDismissResultSchema,
      json('POST', dismissAnchorRequestSchema.parse({ reason })));
  },
  dismissAnchorsBatch(workId, chapterId, anchorIds) {
    return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/role-marks/dismiss-batch`, anchorDismissBatchResultSchema,
      json('POST', dismissAnchorsRequestSchema.parse({ anchor_ids: anchorIds })));
  },
  rescanArchive(workId, characterId) {
    return apiRequest(`${root}/${part(workId)}/characters/${part(characterId)}/archive-scans`, scanRescanResultSchema, { method: 'POST' });
  },

  // T28 导入导出
  exportFile(workId, query) {
    const params = new URLSearchParams();
    if (query?.include_archived !== undefined) params.set('include_archived', String(query.include_archived));
    if (query?.include_anchors !== undefined) params.set('include_anchors', String(query.include_anchors));
    const qs = params.toString();
    return apiRequest(`${root}/${part(workId)}/character-portability/export${qs ? `?${qs}` : ''}`, characterImportFileSchema);
  },
  previewImport(workId, file, idempotencyKey) {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return apiRequest(`${root}/${part(workId)}/character-portability/import/preview`, characterImportPreviewResponseSchema,
      { ...json('POST', characterImportFileSchema.parse(file)), headers });
  },
  commitImport(workId, input) {
    return apiRequest(`${root}/${part(workId)}/character-portability/import/commit`, portabilityCommitResultSchema,
      json('POST', characterImportCommitRequestSchema.parse(input)));
  },
  getPortabilityJob(workId, jobId) {
    return apiRequest(`${root}/${part(workId)}/character-portability/jobs/${part(jobId)}`, characterPortabilityJobSchema);
  },

  // T29 剧情归属
  setPlotNodeOwners(workId, nodeId, owners) {
    return apiRequest(`${root}/${part(workId)}/plot-tree/nodes/${part(nodeId)}/owners`, plotNodeOwnersResponseSchema,
      json('PUT', setPlotNodeOwnersRequestSchema.parse({ owners })));
  },
  removePlotNodeOwner(workId, nodeId, characterId) {
    return apiRequest(`${root}/${part(workId)}/plot-tree/nodes/${part(nodeId)}/owners/${part(characterId)}`,
      z.object({ node_id: z.string().uuid(), removed: z.number().int().nonnegative() }), { method: 'DELETE' });
  }
};
