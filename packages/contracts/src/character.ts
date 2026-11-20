import { z } from 'zod';

// M3c-2 角色域契约：角色 / 别名 / 关系类型 / 关系 / 视图 / 成长线 / 头像
// 字段对齐 F2 §2.2 与 §3.3，长度上限与数据库列保持一致

const id = z.string().uuid();
const timestamp = z.string().datetime();
const expectedVersion = z.number().int().nonnegative().optional();
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const contentHash = z.string().regex(/^[0-9a-f]{64}$/);
const coordinate = z.number().int().min(-1_000_000).max(1_000_000);

// ───────────────────────────── 枚举 ─────────────────────────────

export const characterStatusSchema = z.enum(['active', 'archived', 'merged']);
export const characterOriginSchema = z.enum(['manual', 'random', 'ai', 'import']);
export const growthEventOriginSchema = z.enum(['manual', 'ai', 'import']);
export const relationDirectionSchema = z.enum(['directed', 'undirected']);
export const relationLineStyleSchema = z.enum(['solid', 'dashed', 'dotted']);
export const growthEventStatusSchema = z.enum(['active', 'archived']);
export const avatarAssetStatusSchema = z.enum(['pending', 'active', 'superseded', 'failed']);
export const duplicateResolutionSchema = z.enum(['create', 'merge', 'keep_independent']);

export type CharacterStatus = z.infer<typeof characterStatusSchema>;
export type CharacterOrigin = z.infer<typeof characterOriginSchema>;
export type RelationDirection = z.infer<typeof relationDirectionSchema>;
export type RelationLineStyle = z.infer<typeof relationLineStyleSchema>;
export type GrowthEventStatus = z.infer<typeof growthEventStatusSchema>;
export type AvatarAssetStatus = z.infer<typeof avatarAssetStatusSchema>;
export type DuplicateResolution = z.infer<typeof duplicateResolutionSchema>;

// ───────────────────────────── 资料字段 ─────────────────────────────

export const characterAttributeSchema = z
  .object({
    key: z.string().trim().min(1).max(20),
    value: z.string().trim().max(200)
  })
  .strict();

// 受控键值数组，禁止任意 JSON 透传
export const characterAttributesSchema = z.array(characterAttributeSchema).max(20);

export const characterAliasTextSchema = z.string().trim().min(1).max(60);

// 13 项资料：姓名、身份、年龄、性别、性格、经历、国家/地域、信仰、阵营、种族、职业、年龄段、属性
export const characterDossierSchema = z.object({
  name: z.string().trim().min(1).max(60),
  identity: z.string().trim().max(80).nullable(),
  age: z.number().int().min(0).max(10000).nullable(),
  gender: z.string().trim().max(16).nullable(),
  personality: z.string().trim().max(2000),
  // 数据库为 text，契约层设上限避免超大 payload
  experience: z.string().trim().max(20_000),
  country_region: z.string().trim().max(80).nullable(),
  faith: z.string().trim().max(80).nullable(),
  faction: z.string().trim().max(80).nullable(),
  race: z.string().trim().max(80).nullable(),
  occupation: z.string().trim().max(80).nullable(),
  age_band: z.string().trim().max(40).nullable(),
  attributes: characterAttributesSchema
});

export type CharacterDossier = z.infer<typeof characterDossierSchema>;
export type CharacterAttribute = z.infer<typeof characterAttributeSchema>;

// ───────────────────────────── 实体 ─────────────────────────────

export const characterAliasSchema = z.object({
  id,
  work_id: id,
  character_id: id,
  alias: characterAliasTextSchema,
  alias_key: z.string().trim().min(1).max(60),
  created_at: timestamp
});

export const characterSchema = z.object({
  id,
  work_id: id,
  name: z.string().trim().min(1).max(60),
  aliases: z.array(characterAliasTextSchema).max(10),
  identity: z.string().trim().max(80).nullable(),
  age: z.number().int().min(0).max(10000).nullable(),
  gender: z.string().trim().max(16).nullable(),
  personality: z.string().trim().max(2000),
  experience: z.string().trim().max(20_000),
  country_region: z.string().trim().max(80).nullable(),
  faith: z.string().trim().max(80).nullable(),
  faction: z.string().trim().max(80).nullable(),
  race: z.string().trim().max(80).nullable(),
  occupation: z.string().trim().max(80).nullable(),
  age_band: z.string().trim().max(40).nullable(),
  attributes: characterAttributesSchema,
  avatar_asset_id: id.nullable(),
  status: characterStatusSchema,
  merged_into_id: id.nullable(),
  archived_at: timestamp.nullable(),
  origin: characterOriginSchema,
  version: z.number().int().positive(),
  created_at: timestamp,
  updated_at: timestamp
});

export const characterRelationTypeSchema = z.object({
  id,
  work_id: id,
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
  group_key: z.string().trim().min(1).max(40),
  group_label: z.string().trim().min(1).max(40),
  directed: z.boolean(),
  reverse_label: z.string().trim().max(40).nullable(),
  is_builtin: z.boolean(),
  sort_order: z.number().int(),
  created_at: timestamp,
  updated_at: timestamp
});

export const characterRelationSchema = z
  .object({
    id,
    work_id: id,
    source_id: id,
    target_id: id,
    type_id: id,
    directed: z.boolean(),
    label: z.string().trim().min(1).max(40),
    reverse_label: z.string().trim().max(40).nullable(),
    color,
    line_style: relationLineStyleSchema,
    tag: z.string().trim().min(1).max(40),
    origin: z.enum(['manual', 'ai', 'import']),
    created_at: timestamp,
    updated_at: timestamp
  })
  .refine((value) => value.source_id !== value.target_id, {
    message: '关系两端不能是同一角色',
    path: ['target_id']
  })
  .refine((value) => value.directed || value.reverse_label === null, {
    message: '无方向关系不允许反向称谓',
    path: ['reverse_label']
  });

export const characterViewFiltersSchema = z
  .object({
    keyword: z.string().trim().max(60).optional(),
    country_region: z.string().trim().max(80).nullable().optional(),
    faith: z.string().trim().max(80).nullable().optional(),
    faction: z.string().trim().max(80).nullable().optional(),
    race: z.string().trim().max(80).nullable().optional(),
    occupation: z.string().trim().max(80).nullable().optional(),
    age_band: z.string().trim().max(40).nullable().optional()
  })
  .strict();

export const characterViewSchema = z.object({
  id,
  work_id: id,
  name: z.string().trim().min(1).max(60),
  is_default: z.boolean(),
  filters: characterViewFiltersSchema,
  version: z.number().int().positive(),
  sort_order: z.number().int(),
  created_at: timestamp,
  updated_at: timestamp
});

export const characterViewNodeSchema = z.object({
  id,
  view_id: id,
  character_id: id,
  x: coordinate.nullable(),
  y: coordinate.nullable(),
  arranged: z.boolean(),
  sort_index: z.number().int(),
  created_at: timestamp,
  updated_at: timestamp
});

export const characterGrowthEventSchema = z.object({
  id,
  work_id: id,
  character_id: id,
  title: z.string().trim().min(1).max(120),
  content: z.string().max(4000),
  event_time: z.string().trim().max(120).nullable(),
  plot_node_id: id.nullable(),
  plot_node_title: z.string().trim().max(120).nullable(),
  chapter_id: id.nullable(),
  status: growthEventStatusSchema,
  archived_at: timestamp.nullable(),
  origin: growthEventOriginSchema,
  created_at: timestamp,
  updated_at: timestamp
});

export const characterAvatarAssetSchema = z.object({
  id,
  work_id: id,
  character_id: id,
  status: avatarAssetStatusSchema,
  mime: z.enum(['image/png', 'image/svg+xml']),
  byte_size: z.number().int().positive().max(1_048_576),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  content_hash: contentHash,
  content_url: z.string().min(1).max(500),
  created_at: timestamp,
  updated_at: timestamp
});

// ───────────────────────────── 角色请求 ─────────────────────────────

export const createCharacterRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  aliases: z.array(characterAliasTextSchema).max(10).default([]),
  identity: z.string().trim().max(80).nullable().optional(),
  age: z.number().int().min(0).max(10000).nullable().optional(),
  gender: z.string().trim().max(16).nullable().optional(),
  personality: z.string().trim().max(2000).default(''),
  experience: z.string().trim().max(20_000).default(''),
  country_region: z.string().trim().max(80).nullable().optional(),
  faith: z.string().trim().max(80).nullable().optional(),
  faction: z.string().trim().max(80).nullable().optional(),
  race: z.string().trim().max(80).nullable().optional(),
  occupation: z.string().trim().max(80).nullable().optional(),
  age_band: z.string().trim().max(40).nullable().optional(),
  attributes: characterAttributesSchema.default([]),
  origin: characterOriginSchema.default('manual'),
  expected_version: expectedVersion
});

export const updateCharacterRequestSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  aliases: z.array(characterAliasTextSchema).max(10).optional(),
  identity: z.string().trim().max(80).nullable().optional(),
  age: z.number().int().min(0).max(10000).nullable().optional(),
  gender: z.string().trim().max(16).nullable().optional(),
  personality: z.string().trim().max(2000).optional(),
  experience: z.string().trim().max(20_000).optional(),
  country_region: z.string().trim().max(80).nullable().optional(),
  faith: z.string().trim().max(80).nullable().optional(),
  faction: z.string().trim().max(80).nullable().optional(),
  race: z.string().trim().max(80).nullable().optional(),
  occupation: z.string().trim().max(80).nullable().optional(),
  age_band: z.string().trim().max(40).nullable().optional(),
  attributes: characterAttributesSchema.optional(),
  expected_version: expectedVersion
});

export const randomCharacterRequestSchema = z.object({
  seed: z.string().trim().min(1).max(128).optional()
});

export const randomCharacterResponseSchema = z.object({
  seed: z.string().min(1).max(128),
  dossier: characterDossierSchema
});

export const archiveCharacterRequestSchema = z.object({
  expected_version: expectedVersion
});

export const characterArchiveImpactSchema = z.object({
  relations: z.number().int().nonnegative(),
  growth_events: z.number().int().nonnegative(),
  chapters: z.number().int().nonnegative(),
  exclusive_plot_nodes: z.number().int().nonnegative()
});

export const archiveScanSummarySchema = z.object({
  id,
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  total_chapters: z.number().int().nonnegative()
});

export const archiveCharacterResponseSchema = z.object({
  character: characterSchema,
  impact: characterArchiveImpactSchema,
  scan: archiveScanSummarySchema,
  version: z.number().int().positive()
});

export const duplicateCandidateSchema = z.object({
  character_id: id,
  name: z.string().trim().min(1).max(60),
  matched_on: z.enum(['name', 'alias'])
});

export const restoreCharacterResponseSchema = z.object({
  character: characterSchema,
  duplicate_candidates: z.array(duplicateCandidateSchema).max(50)
});

export const mergeCharacterRequestSchema = z.object({
  target_character_id: id,
  keep_alias: z.boolean(),
  expected_version: expectedVersion
});

export const characterDuplicateGroupSchema = z.object({
  key: z.string().trim().min(1).max(60),
  matched_on: z.enum(['name', 'alias']),
  character_ids: z.array(id).min(2)
});

export const characterDuplicateGroupsResponseSchema = z.object({
  groups: z.array(characterDuplicateGroupSchema).max(50)
});

// ───────────────────────────── 关系类型 / 关系请求 ─────────────────────────────

export const createCharacterRelationTypeRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/, 'code 仅允许小写字母、数字与下划线'),
    label: z.string().trim().min(1).max(40),
    group_key: z.string().trim().min(1).max(40),
    group_label: z.string().trim().min(1).max(40),
    directed: z.boolean().default(true),
    reverse_label: z.string().trim().max(40).nullable().optional(),
    sort_order: z.number().int().optional()
  })
  .refine((value) => value.directed || !value.reverse_label, {
    message: '无方向关系不允许反向称谓',
    path: ['reverse_label']
  });

export const updateCharacterRelationTypeRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(40).optional(),
    group_key: z.string().trim().min(1).max(40).optional(),
    group_label: z.string().trim().min(1).max(40).optional(),
    directed: z.boolean().optional(),
    reverse_label: z.string().trim().max(40).nullable().optional(),
    sort_order: z.number().int().optional()
  })
  .refine((value) => value.directed !== false || !value.reverse_label, {
    message: '无方向关系不允许反向称谓',
    path: ['reverse_label']
  });

export const createCharacterRelationRequestSchema = z
  .object({
    source_id: id,
    target_id: id,
    type_id: id,
    directed: z.boolean().optional(),
    label: z.string().trim().min(1).max(40).optional(),
    reverse_label: z.string().trim().max(40).nullable().optional(),
    color: color.optional(),
    line_style: relationLineStyleSchema.optional(),
    tag: z.string().trim().min(1).max(40).optional(),
    expected_version: expectedVersion
  })
  .refine((value) => value.source_id !== value.target_id, {
    message: '关系两端不能是同一角色',
    path: ['target_id']
  })
  .refine((value) => value.directed !== false || !value.reverse_label, {
    message: '无方向关系不允许反向称谓',
    path: ['reverse_label']
  });

export const updateCharacterRelationRequestSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  reverse_label: z.string().trim().max(40).nullable().optional(),
  color: color.optional(),
  line_style: relationLineStyleSchema.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  expected_version: expectedVersion
});

// ───────────────────────────── 视图与布局请求 ─────────────────────────────

export const createCharacterViewRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: characterViewFiltersSchema.default({}),
  members: z.array(id).max(500).optional(),
  sort_order: z.number().int().optional(),
  expected_version: expectedVersion
});

export const updateCharacterViewRequestSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  filters: characterViewFiltersSchema.optional(),
  sort_order: z.number().int().optional(),
  expected_version: expectedVersion
});

export const addCharacterViewMembersRequestSchema = z.object({
  character_ids: z.array(id).min(1).max(500)
});

export const characterViewLayoutItemSchema = z.object({
  character_id: id,
  x: coordinate,
  y: coordinate,
  arranged: z.boolean().default(true)
});

export const updateCharacterViewLayoutRequestSchema = z.object({
  positions: z.array(characterViewLayoutItemSchema).min(1).max(500)
});

// ───────────────────────────── 版图读取响应 ─────────────────────────────

export const characterSixDimSchema = z
  .object({
    country_region: z.string().nullable().optional(),
    faith: z.string().nullable().optional(),
    faction: z.string().nullable().optional(),
    race: z.string().nullable().optional(),
    occupation: z.string().nullable().optional(),
    age_band: z.string().nullable().optional()
  })
  .strict();

export const characterBoardSummarySchema = z.object({
  id,
  name: z.string().trim().min(1).max(60),
  status: characterStatusSchema,
  avatar_asset_id: id.nullable(),
  six_dim: characterSixDimSchema
});

export const characterRelationBoardSchema = z.object({
  id,
  source_id: id,
  target_id: id,
  type_id: id,
  directed: z.boolean(),
  label: z.string().trim().min(1).max(40),
  reverse_label: z.string().trim().max(40).nullable(),
  color,
  line_style: relationLineStyleSchema,
  tag: z.string().trim().min(1).max(40)
});

export const characterRelationTypeBoardSchema = z.object({
  id,
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
  group_key: z.string().trim().min(1).max(40)
});

export const characterViewLayoutSchema = z.object({
  character_id: id,
  x: coordinate.nullable(),
  y: coordinate.nullable(),
  arranged: z.boolean(),
  sort_index: z.number().int()
});

export const characterBoardResponseSchema = z.object({
  view: z.object({
    id,
    name: z.string().trim().min(1).max(60),
    filters: characterViewFiltersSchema,
    version: z.number().int().positive(),
    is_default: z.boolean()
  }),
  characters: z.array(characterBoardSummarySchema),
  relations: z.array(characterRelationBoardSchema),
  relation_types: z.array(characterRelationTypeBoardSchema),
  layout: z.array(characterViewLayoutSchema)
});

// ───────────────────────────── 成长线请求 ─────────────────────────────

export const createCharacterGrowthEventRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().max(4000).default(''),
  event_time: z.string().trim().max(120).nullable().optional(),
  plot_node_id: id.nullable().optional(),
  chapter_id: id.nullable().optional(),
  expected_version: expectedVersion
});

export const updateCharacterGrowthEventRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().max(4000).optional(),
  event_time: z.string().trim().max(120).nullable().optional(),
  plot_node_id: id.nullable().optional(),
  chapter_id: id.nullable().optional(),
  expected_version: expectedVersion
});

// ───────────────────────────── 头像请求 ─────────────────────────────

export const adoptCharacterAvatarRequestSchema = z.object({
  asset_id: id,
  expected_version: expectedVersion
});

// ───────────────────────────── 类型导出 ─────────────────────────────

export type Character = z.infer<typeof characterSchema>;
export type CharacterAlias = z.infer<typeof characterAliasSchema>;
export type CharacterRelationType = z.infer<typeof characterRelationTypeSchema>;
export type CharacterRelation = z.infer<typeof characterRelationSchema>;
export type CharacterViewFilters = z.infer<typeof characterViewFiltersSchema>;
export type CharacterView = z.infer<typeof characterViewSchema>;
export type CharacterViewNode = z.infer<typeof characterViewNodeSchema>;
export type CharacterGrowthEvent = z.infer<typeof characterGrowthEventSchema>;
export type CharacterAvatarAsset = z.infer<typeof characterAvatarAssetSchema>;
export type CharacterBoardResponse = z.infer<typeof characterBoardResponseSchema>;
export type CreateCharacterRequest = z.infer<typeof createCharacterRequestSchema>;
export type UpdateCharacterRequest = z.infer<typeof updateCharacterRequestSchema>;
export type CreateCharacterRelationRequest = z.infer<typeof createCharacterRelationRequestSchema>;
export type UpdateCharacterRelationRequest = z.infer<typeof updateCharacterRelationRequestSchema>;
