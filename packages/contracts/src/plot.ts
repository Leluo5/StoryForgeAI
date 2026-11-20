import { z } from 'zod';
import { characterStatusSchema } from './character';

// M3c-1 剧情契约：剧情树 / 节点 / 关联 / 分组 / 推衍 / 自动建树
// 字段对齐 database/plot-*.entity.ts、derivation-*.entity.ts

const id = z.string().uuid();
const timestamp = z.string().datetime();

// ───────────────────────────── 枚举 ─────────────────────────────

export const plotNodeOriginSchema = z.enum(['manual', 'derivation', 'outline', 'novel_text', 'import']);
export const plotLinkTypeSchema = z.enum(['linear', 'non_linear']);
export const plotGroupKindSchema = z.enum(['group', 'swimlane']);
export const plotTreeSourceSchema = z.enum(['manual', 'outline', 'novel_text', 'import']);
export const derivationStatusSchema = z.enum(['idle', 'running', 'paused', 'finished', 'failed']);
export const candidateStatusSchema = z.enum(['pending', 'confirmed', 'rejected']);
export const placementSchema = z.enum(['child', 'sibling']);
export const plotGenerationSourceSchema = z.enum(['outline', 'novel_text']);
export const plotGenerationStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'committed', 'discarded']);

export type PlotNodeOrigin = z.infer<typeof plotNodeOriginSchema>;
export type PlotLinkType = z.infer<typeof plotLinkTypeSchema>;
export type DerivationStatus = z.infer<typeof derivationStatusSchema>;
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;
export type PlotGenerationStatus = z.infer<typeof plotGenerationStatusSchema>;

// ───────────────────────────── 基础 Schema ─────────────────────────────

// 画布逻辑坐标（整数像素，范围钳制）
export const plotPositionSchema = z.object({
  x: z.number().int().min(-1_000_000).max(1_000_000),
  y: z.number().int().min(-1_000_000).max(1_000_000)
});

// 节点受控属性：禁止任意 JSON 透传
export const plotNodeAttributesSchema = z
  .object({
    time_point: z.string().trim().max(120).optional(),
    place: z.string().trim().max(120).optional(),
    status: z.string().trim().max(40).optional()
  })
  .strict();

const title = z.string().trim().min(1).max(120);
const summary = z.string().trim().max(255);
const content = z.string().max(20_000);
const expectedVersion = z.number().int().nonnegative().optional();

// ───────────────────────────── 实体 ─────────────────────────────

export const plotTreeSchema = z.object({
  id,
  work_id: id,
  title,
  source: plotTreeSourceSchema,
  schema_version: z.number().int().positive(),
  version: z.number().int().positive(),
  created_at: timestamp,
  updated_at: timestamp
});

export const plotGroupSchema = z.object({
  id,
  tree_id: id,
  name: z.string().trim().min(1).max(80),
  kind: plotGroupKindSchema,
  order_index: z.number().int(),
  created_at: timestamp,
  updated_at: timestamp
});

export const plotNodeSchema = z.object({
  id,
  tree_id: id,
  parent_id: id.nullable(),
  sibling_order: z.number().int().nonnegative(),
  title,
  summary: summary.nullable(),
  content,
  attributes: plotNodeAttributesSchema,
  position: plotPositionSchema,
  group_id: id.nullable(),
  origin: plotNodeOriginSchema,
  created_at: timestamp,
  updated_at: timestamp
});

export const plotLinkSchema = z
  .object({
    id,
    tree_id: id,
    source_id: id,
    target_id: id,
    type: plotLinkTypeSchema,
    label: z.string().trim().max(255).nullable(),
    created_at: timestamp
  })
  .refine((v) => v.source_id !== v.target_id, { message: '关联两端不能是同一节点', path: ['target_id'] });

// ───────────────────────────── 剧情节点归属（M3c-2 扩展） ─────────────────────────────

// 只读视图：只存归属关系，不复制节点内容
export const plotNodeOwnerSchema = z.object({
  node_id: id,
  character_id: id,
  is_exclusive: z.boolean(),
  character: z
    .object({
      id,
      name: z.string().trim().min(1).max(60),
      status: characterStatusSchema
    })
    .optional()
});

// 归档视图：因专属归属者全部归档而被隐藏的节点（仅用于展示，不回写 plot_nodes）
export const archivedOwnerNodeSchema = z.object({
  node_id: id,
  character_ids: z.array(id).min(1),
  position: plotPositionSchema
});

// 整组写入请求：≤10 且 character_id 不得重复；空数组表示清空 active 归属
export const setPlotNodeOwnersRequestSchema = z
  .object({
    owners: z
      .array(
        z.object({
          character_id: id,
          is_exclusive: z.boolean().default(false)
        })
      )
      .max(10)
  })
  .refine((value) => new Set(value.owners.map((owner) => owner.character_id)).size === value.owners.length, {
    message: '同一节点不能重复归属同一角色',
    path: ['owners']
  });

export const plotNodeOwnersResponseSchema = z.object({
  node_id: id,
  owners: z.array(plotNodeOwnerSchema)
});

// 查询串布尔值：兼容 "true"/"false"/"1"/"0"
const queryBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'string') return value === 'true' || value === '1';
    return value;
  }, z.boolean().optional().default(defaultValue));

export const plotTreeQuerySchema = z.object({
  includeArchivedOwner: queryBoolean(false)
});

// 整树读取响应：无树时 tree 为 null，其余为空数组
export const plotTreeResponseSchema = z.object({
  tree: plotTreeSchema.nullable(),
  nodes: z.array(plotNodeSchema),
  links: z.array(plotLinkSchema),
  groups: z.array(plotGroupSchema),
  // M3c-2 新增可选字段：旧客户端忽略，nodes/links/groups 结构不变
  owners: z.array(plotNodeOwnerSchema).optional(),
  archived_owner_nodes: z.array(archivedOwnerNodeSchema).optional()
});

// ───────────────────────────── 剧情树请求 ─────────────────────────────

export const createPlotTreeRequestSchema = z.object({
  title: title.optional()
});

export const updatePlotTreeRequestSchema = z.object({
  title,
  expected_version: expectedVersion
});

export const plotNodeInputSchema = z.object({
  title,
  summary: summary.optional().nullable(),
  content: content.default(''),
  attributes: plotNodeAttributesSchema.default({}),
  position: plotPositionSchema.default({ x: 0, y: 0 }),
  parent_id: id.nullable().optional(),
  sibling_order: z.number().int().nonnegative().optional(),
  group_id: id.nullable().optional(),
  origin: plotNodeOriginSchema.default('manual')
});

export const createPlotNodeRequestSchema = plotNodeInputSchema.extend({
  expected_version: expectedVersion
});

export const updatePlotNodeRequestSchema = z.object({
  title: title.optional(),
  summary: summary.nullable().optional(),
  content: content.optional(),
  attributes: plotNodeAttributesSchema.optional(),
  expected_version: expectedVersion
});

export const movePlotNodeRequestSchema = z.object({
  parent_id: id.nullable(),
  sibling_order: z.number().int().nonnegative().optional(),
  expected_version: expectedVersion
});

export const assignPlotNodeGroupRequestSchema = z.object({
  group_id: id.nullable(),
  expected_version: expectedVersion
});

// 批量坐标：拖拽与自动布局共用；节点不存在则忽略（幂等）
export const updatePlotPositionsRequestSchema = z.object({
  positions: z
    .array(
      z.object({
        node_id: id,
        x: plotPositionSchema.shape.x,
        y: plotPositionSchema.shape.y
      })
    )
    .min(1)
    .max(2000)
});

export const createPlotLinkRequestSchema = z
  .object({
    source_id: id,
    target_id: id,
    type: plotLinkTypeSchema,
    label: z.string().trim().max(255).optional().nullable(),
    expected_version: expectedVersion
  })
  .refine((v) => v.source_id !== v.target_id, { message: '关联两端不能是同一节点', path: ['target_id'] });

export const createPlotGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: plotGroupKindSchema,
  order_index: z.number().int().nonnegative().optional(),
  expected_version: expectedVersion
});

export const updatePlotGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  order_index: z.number().int().nonnegative().optional(),
  expected_version: expectedVersion
});

// ───────────────────────────── 导入 / 导出 ─────────────────────────────

export const IMPORT_SCHEMA_VERSION = 1;

const importNodeSchema = z.object({
  id: id.optional(),
  parent_id: id.nullable().optional(),
  sibling_order: z.number().int().nonnegative().default(0),
  title,
  summary: summary.nullable().optional(),
  content: content.default(''),
  attributes: plotNodeAttributesSchema.default({}),
  position: plotPositionSchema.default({ x: 0, y: 0 }),
  group_id: id.nullable().optional(),
  origin: plotNodeOriginSchema.default('import')
});

const importLinkSchema = z
  .object({
    id: id.optional(),
    source_id: id,
    target_id: id,
    type: plotLinkTypeSchema,
    label: z.string().trim().max(255).nullable().optional()
  })
  .refine((v) => v.source_id !== v.target_id, { message: '关联两端不能是同一节点', path: ['target_id'] });

const importGroupSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(80),
  kind: plotGroupKindSchema,
  order_index: z.number().int().nonnegative().default(0)
});

export const importPlotTreeRequestSchema = z.object({
  schema_version: z.literal(IMPORT_SCHEMA_VERSION),
  exported_at: timestamp.optional(),
  tree: z.object({ title }),
  nodes: z.array(importNodeSchema).min(1).max(2000),
  links: z.array(importLinkSchema).max(4000).default([]),
  groups: z.array(importGroupSchema).max(200).default([])
});

export const exportPlotTreeSchema = z.object({
  schema_version: z.literal(IMPORT_SCHEMA_VERSION),
  exported_at: timestamp,
  tree: z.object({ title }),
  nodes: z.array(importNodeSchema),
  links: z.array(importLinkSchema),
  groups: z.array(importGroupSchema)
});

// ───────────────────────────── 推衍 ─────────────────────────────

export const derivationCharacterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default('')
});

export const derivationBranchSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).default('')
});

export const derivationEventSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default('')
});

export const createDerivationSessionRequestSchema = z.object({
  start_node_id: id,
  place: z.string().trim().min(1).max(120),
  background: z.string().trim().min(1).max(4000),
  time_node: z.string().trim().max(120).optional().nullable(),
  premise_node_ids: z.array(id).max(50).default([]),
  related_node_ids: z.array(id).max(50).default([]),
  characters: z.array(derivationCharacterSchema).min(1).max(20),
  random_enabled: z.boolean().default(true),
  random_character_enabled: z.boolean().default(true)
});

export const updateDerivationSessionRequestSchema = z.object({
  place: z.string().trim().min(1).max(120).optional(),
  background: z.string().trim().min(1).max(4000).optional(),
  time_node: z.string().trim().max(120).nullable().optional(),
  premise_node_ids: z.array(id).max(50).optional(),
  related_node_ids: z.array(id).max(50).optional(),
  characters: z.array(derivationCharacterSchema).min(1).max(20).optional(),
  random_enabled: z.boolean().optional(),
  random_character_enabled: z.boolean().optional(),
  status: z.enum(['paused', 'finished']).optional()
});

export const derivationSessionSchema = z.object({
  id,
  work_id: id,
  tree_id: id,
  start_node_id: id,
  place: z.string(),
  background: z.string(),
  time_node: z.string().nullable(),
  premise_node_ids: z.array(id),
  related_node_ids: z.array(id),
  characters: z.array(derivationCharacterSchema),
  random_enabled: z.boolean(),
  random_character_enabled: z.boolean(),
  status: derivationStatusSchema,
  step_index: z.number().int().nonnegative(),
  created_at: timestamp,
  updated_at: timestamp
});

// 步骤生成结果（模型输出 → 落库），分支固定 2~4 个
export const derivationStepSchema = z.object({
  id,
  session_id: id,
  step_no: z.number().int().positive(),
  content,
  event: derivationEventSchema.nullable(),
  new_characters: z.array(derivationCharacterSchema),
  branches: z.array(derivationBranchSchema).min(2).max(4),
  chosen_branch_id: z.string().max(40).nullable(),
  task_id: id.nullable(),
  created_at: timestamp,
  updated_at: timestamp
});

export const updateDerivationStepRequestSchema = z.object({
  content: content.optional(),
  chosen_branch_id: z.string().trim().max(40).nullable().optional()
});

// 候选节点载荷：按步拆分时用 parent_index 形成链
export const plotDraftNodeSchema = z.object({
  title,
  summary: summary.nullable().optional(),
  content: content.default(''),
  parent_index: z.number().int().nonnegative().nullable().optional()
});

export const plotTreeDraftPayloadSchema = z.object({
  nodes: z.array(plotDraftNodeSchema).min(1).max(50)
});

export const createDerivationCandidateRequestSchema = z.object({
  split_by_step: z.boolean().default(false),
  placement: placementSchema,
  payload: plotTreeDraftPayloadSchema.optional()
});

export const derivationCandidateSchema = z.object({
  id,
  session_id: id,
  start_node_id: id,
  placement: placementSchema,
  payload: plotTreeDraftPayloadSchema,
  status: candidateStatusSchema,
  confirmed_node_id: id.nullable(),
  created_at: timestamp,
  confirmed_at: timestamp.nullable()
});

export const confirmDerivationCandidateRequestSchema = z.object({
  expected_version: expectedVersion
});

// ───────────────────────────── 自动建树（第二阶段） ─────────────────────────────

export const createPlotGenerationRequestSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('outline'),
    text: z.string().trim().min(10).max(20_000)
  }),
  z.object({
    source: z.literal('novel_text'),
    chapter_id: id
  })
]);

export const plotGenerationDraftSchema = z.object({
  id,
  work_id: id,
  source: plotGenerationSourceSchema,
  input_text: z.string(),
  input_chapter_id: id.nullable(),
  status: plotGenerationStatusSchema,
  payload: plotTreeDraftPayloadSchema.nullable(),
  error: z.record(z.unknown()).nullable(),
  task_id: id.nullable(),
  created_at: timestamp,
  updated_at: timestamp
});

export const updatePlotGenerationDraftRequestSchema = z.object({
  payload: plotTreeDraftPayloadSchema
});

export const commitPlotGenerationRequestSchema = z
  .object({
    mode: z.enum(['replace', 'append']),
    parent_node_id: id.nullable().optional(),
    confirm_overwrite: z.boolean().default(false)
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'replace' && !value.confirm_overwrite) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '覆盖现有剧情树必须显式确认',
        path: ['confirm_overwrite']
      });
    }
  });

// ───────────────────────────── 类型导出 ─────────────────────────────

export type PlotTree = z.infer<typeof plotTreeSchema>;
export type PlotNode = z.infer<typeof plotNodeSchema>;
export type PlotLink = z.infer<typeof plotLinkSchema>;
export type PlotGroup = z.infer<typeof plotGroupSchema>;
export type PlotTreeResponse = z.infer<typeof plotTreeResponseSchema>;
export type PlotNodeOwner = z.infer<typeof plotNodeOwnerSchema>;
export type ArchivedOwnerNode = z.infer<typeof archivedOwnerNodeSchema>;
export type PlotNodeAttributes = z.infer<typeof plotNodeAttributesSchema>;
export type PlotDraftNode = z.infer<typeof plotDraftNodeSchema>;
export type PlotTreeDraftPayload = z.infer<typeof plotTreeDraftPayloadSchema>;
export type DerivationCharacter = z.infer<typeof derivationCharacterSchema>;
export type DerivationBranch = z.infer<typeof derivationBranchSchema>;
export type DerivationSession = z.infer<typeof derivationSessionSchema>;
export type DerivationStep = z.infer<typeof derivationStepSchema>;
export type DerivationCandidate = z.infer<typeof derivationCandidateSchema>;
export type PlotGenerationSource = z.infer<typeof plotGenerationSourceSchema>;
export type PlotGenerationDraft = z.infer<typeof plotGenerationDraftSchema>;
