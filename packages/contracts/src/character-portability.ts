import { z } from 'zod';
import {
  characterDossierSchema,
  characterOriginSchema,
  characterViewFiltersSchema,
  duplicateResolutionSchema,
  relationLineStyleSchema
} from './character';

// M3c-2 角色域导入导出契约（F2 §3.5、§4.8）
// 版本化 JSON：v1 为无 anchors 的兼容输入，导出固定写 v2

const id = z.string().uuid();
const timestamp = z.string().datetime();
const localId = z.string().trim().min(1).max(40);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const coordinate = z.number().int().min(-1_000_000).max(1_000_000);

// ───────────────────────────── 文件条目 ─────────────────────────────

const importCharacterSchema = characterDossierSchema.extend({
  local_id: localId,
  aliases: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  origin: characterOriginSchema.default('manual')
});

const importRelationTypeSchema = z.object({
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(40),
  group_key: z.string().trim().min(1).max(40),
  group_label: z.string().trim().min(1).max(40),
  directed: z.boolean(),
  reverse_label: z.string().trim().max(40).nullable().optional(),
  is_builtin: z.boolean().default(false)
});

const importRelationSchema = z
  .object({
    source_local_id: localId,
    target_local_id: localId,
    type_code: z.string().trim().min(1).max(40),
    directed: z.boolean(),
    label: z.string().trim().min(1).max(40),
    reverse_label: z.string().trim().max(40).nullable().optional(),
    color: color.optional(),
    line_style: relationLineStyleSchema.default('solid'),
    tag: z.string().trim().min(1).max(40).optional(),
    origin: z.enum(['manual', 'ai', 'import']).default('manual')
  })
  .refine((value) => value.source_local_id !== value.target_local_id, {
    message: '关系两端不能是同一角色',
    path: ['target_local_id']
  });

const importGrowthEventSchema = z.object({
  character_local_id: localId,
  title: z.string().trim().min(1).max(120),
  content: z.string().max(4000).default(''),
  event_time: z.string().trim().max(120).nullable().optional(),
  plot_node_title: z.string().trim().max(120).nullable().optional(),
  chapter_title: z.string().trim().max(200).nullable().optional(),
  origin: z.enum(['manual', 'ai', 'import']).default('manual')
});

const importViewLayoutItemSchema = z.object({
  character_local_id: localId,
  x: coordinate,
  y: coordinate
});

const importViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: characterViewFiltersSchema.default({}),
  layout: z.array(importViewLayoutItemSchema).max(500).default([])
});

const importAnchorSchema = z.object({
  character_local_id: localId,
  chapter_id: id,
  paragraph_pid: z.string().uuid(),
  excerpt: z.string().max(120).default(''),
  status: z.enum(['active', 'dismissed', 'invalid']).default('active')
});

// ───────────────────────────── 导入文件 ─────────────────────────────

export const characterImportFileSchema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    exported_at: timestamp.optional(),
    work: z
      .object({
        id,
        title: z.string().trim().max(120)
      })
      .strict(),
    relation_types: z.array(importRelationTypeSchema).max(50).default([]),
    characters: z.array(importCharacterSchema).max(500).default([]),
    relations: z.array(importRelationSchema).max(1500).default([]),
    growth_events: z.array(importGrowthEventSchema).max(2000).default([]),
    views: z.array(importViewSchema).max(20).default([]),
    anchors: z.array(importAnchorSchema).max(5000).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const characterIds = new Set<string>();
    for (const character of value.characters) {
      if (characterIds.has(character.local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `local_id 重复：${character.local_id}`,
          path: ['characters']
        });
      }
      characterIds.add(character.local_id);
    }

    const typeCodes = new Set<string>();
    for (const type of value.relation_types) {
      if (typeCodes.has(type.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `type_code 重复：${type.code}`,
          path: ['relation_types']
        });
      }
      typeCodes.add(type.code);
    }

    value.relations.forEach((relation, index) => {
      if (!characterIds.has(relation.source_local_id) || !characterIds.has(relation.target_local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CHARACTER_IMPORT_DANGLING_REF',
          path: ['relations', index]
        });
      }
    });

    value.growth_events.forEach((event, index) => {
      if (!characterIds.has(event.character_local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CHARACTER_IMPORT_DANGLING_REF',
          path: ['growth_events', index]
        });
      }
    });

    value.views.forEach((view, viewIndex) => {
      view.layout.forEach((item, itemIndex) => {
        if (!characterIds.has(item.character_local_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'CHARACTER_IMPORT_DANGLING_REF',
            path: ['views', viewIndex, 'layout', itemIndex]
          });
        }
      });
    });

    (value.anchors ?? []).forEach((anchor, index) => {
      if (!characterIds.has(anchor.character_local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CHARACTER_IMPORT_DANGLING_REF',
          path: ['anchors', index]
        });
      }
    });
  });

// 导出固定写 v2
export const characterExportFileSchema = characterImportFileSchema.refine(
  (value) => value.schema_version === 2,
  { message: '导出文件必须使用 schema_version=2', path: ['schema_version'] }
);

// ───────────────────────────── 冲突 / 摘要 / 作业 ─────────────────────────────

export const characterImportConflictTypeSchema = z.enum([
  'character_duplicate',
  'dangling_relation',
  'duplicate_relation',
  'unknown_relation_type',
  'view_name_conflict'
]);

export const characterImportConflictMatchSchema = z.object({
  character_id: id,
  name: z.string().trim().min(1).max(60),
  matched_on: z.enum(['name', 'alias'])
});

export const characterImportConflictSchema = z.object({
  type: characterImportConflictTypeSchema,
  local_id: localId.optional(),
  message: z.string().max(200).optional(),
  matches: z.array(characterImportConflictMatchSchema).max(50).optional()
});

export const characterImportSummarySchema = z.object({
  characters: z.number().int().nonnegative().default(0),
  relations: z.number().int().nonnegative().default(0),
  growth_events: z.number().int().nonnegative().default(0),
  views: z.number().int().nonnegative().default(0),
  relation_types: z.number().int().nonnegative().default(0),
  anchors: z.number().int().nonnegative().default(0),
  restored_anchors: z.number().int().nonnegative().default(0),
  discarded_anchors: z.number().int().nonnegative().default(0),
  skipped_relations: z.number().int().nonnegative().default(0),
  conflicts: z.number().int().nonnegative().default(0)
});

export const characterImportResolutionSchema = z
  .object({
    local_id: localId,
    action: duplicateResolutionSchema,
    target_character_id: id.optional()
  })
  .superRefine((value, ctx) => {
    if (value.action === 'merge' && !value.target_character_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'merge 必须指定 target_character_id',
        path: ['target_character_id']
      });
    }
  });

export const characterImportPreviewResponseSchema = z.object({
  preview_job_id: id,
  summary: characterImportSummarySchema,
  conflicts: z.array(characterImportConflictSchema)
});

export const characterImportCommitRequestSchema = z
  .object({
    preview_job_id: id,
    idempotency_key: z.string().trim().min(1).max(128),
    mode: z.enum(['merge', 'replace']),
    confirm_overwrite: z.boolean().default(false),
    file: characterImportFileSchema,
    resolutions: z.array(characterImportResolutionSchema).max(500).default([])
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'replace' && !value.confirm_overwrite) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '覆盖导入必须显式确认',
        path: ['confirm_overwrite']
      });
    }
  });

export const characterPortabilityJobKindSchema = z.enum(['import_preview', 'import_commit', 'export']);
export const characterPortabilityJobStatusSchema = z.enum(['succeeded', 'failed']);
export const characterPortabilityModeSchema = z.enum(['merge', 'replace']);

export const characterPortabilityJobSchema = z.object({
  id,
  work_id: id,
  kind: characterPortabilityJobKindSchema,
  status: characterPortabilityJobStatusSchema,
  schema_version: z.number().int().positive(),
  mode: characterPortabilityModeSchema.nullable(),
  idempotency_key: z.string().trim().max(128).nullable(),
  summary: z.record(z.unknown()),
  conflicts: z.array(characterImportConflictSchema),
  error: z.record(z.unknown()).nullable(),
  created_at: timestamp,
  finished_at: timestamp.nullable()
});

// 查询串布尔值：兼容 "true"/"false"/"1"/"0"
const queryBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'string') return value === 'true' || value === '1';
    return value;
  }, z.boolean().optional().default(defaultValue));

export const characterExportQuerySchema = z.object({
  include_archived: queryBoolean(true),
  include_anchors: queryBoolean(true)
});

// ───────────────────────────── 类型导出 ─────────────────────────────

export type CharacterImportFile = z.infer<typeof characterImportFileSchema>;
export type CharacterExportFile = z.infer<typeof characterExportFileSchema>;
export type CharacterImportConflict = z.infer<typeof characterImportConflictSchema>;
export type CharacterImportSummary = z.infer<typeof characterImportSummarySchema>;
export type CharacterImportCommitRequest = z.infer<typeof characterImportCommitRequestSchema>;
export type CharacterPortabilityJob = z.infer<typeof characterPortabilityJobSchema>;
