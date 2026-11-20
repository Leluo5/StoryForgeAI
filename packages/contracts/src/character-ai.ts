import { z } from 'zod';
import { characterDossierSchema, duplicateResolutionSchema, relationLineStyleSchema } from './character';

// M3c-2 AI 角色 / 关系 / 成长事件候选契约（F2 §3.3、§4.6、§5.7）

const id = z.string().uuid();
const timestamp = z.string().datetime();
const color = z.string().regex(/^#[0-9a-f]{6}$/i);

// ───────────────────────────── 枚举 ─────────────────────────────

export const aiDraftKindSchema = z.enum(['characters_relations', 'growth_events']);
export const aiDraftStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'committed', 'discarded']);
export const aiDraftInputScopeSchema = z.enum(['chapter', 'work']);
export const aiItemKindSchema = z.enum(['character', 'relation', 'growth', 'merge']);
export const aiItemStatusSchema = z.enum(['pending', 'confirmed', 'rejected', 'skipped']);

export type AiDraftKind = z.infer<typeof aiDraftKindSchema>;
export type AiDraftStatus = z.infer<typeof aiDraftStatusSchema>;
export type AiItemKind = z.infer<typeof aiItemKindSchema>;
export type AiItemStatus = z.infer<typeof aiItemStatusSchema>;

// ───────────────────────────── 候选载荷 ─────────────────────────────

// ref 指向草稿内条目或已有正式实体
export const aiItemRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), id }),
  z.object({ kind: z.literal('existing'), id })
]);

export const characterCandidatePayloadSchema = characterDossierSchema.strict();

export const relationCandidatePayloadSchema = z
  .object({
    source_ref: aiItemRefSchema,
    target_ref: aiItemRefSchema,
    type_code: z.string().trim().min(1).max(40),
    directed: z.boolean(),
    label: z.string().trim().min(1).max(40),
    reverse_label: z.string().trim().max(40).nullable().optional(),
    color: color.optional(),
    line_style: relationLineStyleSchema.default('solid'),
    tag: z.string().trim().min(1).max(40).optional()
  })
  .strict();

export const growthCandidatePayloadSchema = z
  .object({
    character_ref: aiItemRefSchema,
    title: z.string().trim().min(1).max(120),
    content: z.string().max(4000).default(''),
    event_time: z.string().trim().max(120).nullable().optional(),
    plot_node_id: id.nullable().optional(),
    chapter_id: id.nullable().optional()
  })
  .strict();

export const mergeCandidatePayloadSchema = z
  .object({
    source_ref: aiItemRefSchema,
    target_ref: aiItemRefSchema
  })
  .strict();

export const suspectedDuplicateSchema = z.object({
  character_id: id,
  name: z.string().trim().min(1).max(60),
  matched_on: z.enum(['name', 'alias'])
});

// ───────────────────────────── 实体 ─────────────────────────────

const candidateItemBase = {
  id,
  draft_id: id,
  item_index: z.number().int().nonnegative(),
  dependencies: z.array(z.number().int().nonnegative()).max(50),
  suspected_duplicates: z.array(suspectedDuplicateSchema).max(20),
  status: aiItemStatusSchema,
  resolution: duplicateResolutionSchema.nullable(),
  resolved_entity_id: id.nullable(),
  resolved_at: timestamp.nullable()
};

export const characterAiCandidateItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...candidateItemBase, kind: z.literal('character'), payload: characterCandidatePayloadSchema }),
  z.object({ ...candidateItemBase, kind: z.literal('relation'), payload: relationCandidatePayloadSchema }),
  z.object({ ...candidateItemBase, kind: z.literal('growth'), payload: growthCandidatePayloadSchema }),
  z.object({ ...candidateItemBase, kind: z.literal('merge'), payload: mergeCandidatePayloadSchema })
]);

export const characterAiDraftSchema = z.object({
  id,
  work_id: id,
  kind: aiDraftKindSchema,
  input_scope: aiDraftInputScopeSchema,
  input_chapter_id: id.nullable(),
  status: aiDraftStatusSchema,
  summary: z.record(z.unknown()).nullable(),
  error: z.record(z.unknown()).nullable(),
  task_id: id.nullable(),
  idempotency_key: z.string().trim().min(1).max(128),
  created_at: timestamp,
  updated_at: timestamp
});

export const characterAiDraftDetailResponseSchema = z.object({
  draft: characterAiDraftSchema,
  items: z.array(characterAiCandidateItemSchema)
});

// ───────────────────────────── 请求 ─────────────────────────────

// source 与 kind 组合判定，故用 union（discriminatedUnion 不支持重复 source 字面量）
export const createCharacterAiDraftRequestSchema = z.union([
  z.object({
    kind: z.literal('characters_relations'),
    source: z.literal('chapter'),
    chapter_id: id
  }),
  z.object({
    kind: z.literal('characters_relations'),
    source: z.literal('work')
  }),
  z.object({
    kind: z.literal('growth_events'),
    source: z.literal('chapter'),
    chapter_id: id,
    character_ids: z.array(id).min(1).max(50)
  }),
  z.object({
    kind: z.literal('growth_events'),
    source: z.literal('work'),
    character_ids: z.array(id).min(1).max(50)
  })
]);

// A6：expected_version 校验对象为 characters.version；仅 merge 模式生效
export const confirmCharacterAiItemRequestSchema = z
  .object({
    mode: duplicateResolutionSchema.optional(),
    target_character_id: id.optional(),
    expected_version: z.number().int().nonnegative().optional()
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'merge' && !value.target_character_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'merge 模式必须指定 target_character_id',
        path: ['target_character_id']
      });
    }
    if (value.mode !== 'merge' && value.expected_version !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CHARACTER_VERSION_NOT_APPLICABLE',
        path: ['expected_version']
      });
    }
  });

export const rejectCharacterAiItemRequestSchema = z.object({
  reason: z.string().trim().max(200).optional()
});

export const characterAiResolutionSchema = z
  .object({
    item_id: id,
    action: duplicateResolutionSchema,
    target_character_id: id.optional()
  })
  .superRefine((value, ctx) => {
    if (value.action === 'merge' && !value.target_character_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'merge 模式必须指定 target_character_id',
        path: ['target_character_id']
      });
    }
  });

export const confirmCharacterAiItemsRequestSchema = z.object({
  item_ids: z.array(id).min(1).max(50),
  resolutions: z.array(characterAiResolutionSchema).max(50).optional()
});

export const discardCharacterAiDraftRequestSchema = z.object({
  reason: z.string().trim().max(200).optional()
});

// ───────────────────────────── 类型导出 ─────────────────────────────

export type AiItemRef = z.infer<typeof aiItemRefSchema>;
export type CharacterCandidatePayload = z.infer<typeof characterCandidatePayloadSchema>;
export type RelationCandidatePayload = z.infer<typeof relationCandidatePayloadSchema>;
export type GrowthCandidatePayload = z.infer<typeof growthCandidatePayloadSchema>;
export type CharacterAiCandidateItem = z.infer<typeof characterAiCandidateItemSchema>;
export type CharacterAiDraft = z.infer<typeof characterAiDraftSchema>;
