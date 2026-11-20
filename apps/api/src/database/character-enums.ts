// M3c-2 角色域枚举常量：实体类型与迁移 CHECK 共用同一份清单，避免两处漂移

export const CHARACTER_STATUSES = ['active', 'archived', 'merged'] as const;
export const CHARACTER_ORIGINS = ['manual', 'random', 'ai', 'import'] as const;
export const GROWTH_EVENT_STATUSES = ['active', 'archived'] as const;
export const GROWTH_EVENT_ORIGINS = ['manual', 'ai', 'import'] as const;
export const RELATION_LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export const RELATION_ORIGINS = ['manual', 'ai', 'import'] as const;
export const AVATAR_ASSET_STATUSES = ['pending', 'active', 'superseded', 'failed'] as const;
export const AVATAR_STORAGE_KINDS = ['file'] as const;
export const AVATAR_MIMES = ['image/png', 'image/svg+xml'] as const;
export const AI_DRAFT_KINDS = ['characters_relations', 'growth_events'] as const;
export const AI_DRAFT_INPUT_SCOPES = ['chapter', 'work'] as const;
export const AI_DRAFT_STATUSES = ['pending', 'succeeded', 'failed', 'committed', 'discarded'] as const;
export const AI_ITEM_KINDS = ['character', 'relation', 'growth', 'merge'] as const;
export const AI_ITEM_STATUSES = ['pending', 'confirmed', 'rejected', 'skipped'] as const;
export const DUPLICATE_RESOLUTIONS = ['create', 'merge', 'keep_independent'] as const;
export const PORTABILITY_JOB_KINDS = ['import_preview', 'import_commit', 'export'] as const;
export const PORTABILITY_JOB_STATUSES = ['succeeded', 'failed'] as const;
export const PORTABILITY_MODES = ['merge', 'replace'] as const;
export const ANCHOR_STATUSES = ['active', 'dismissed', 'invalid'] as const;
export const ANCHOR_INVALID_REASONS = ['pid_missing', 'text_changed', 'character_restored'] as const;
export const ARCHIVE_SCAN_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;

export type CharacterStatus = (typeof CHARACTER_STATUSES)[number];
export type CharacterOrigin = (typeof CHARACTER_ORIGINS)[number];
export type GrowthEventStatus = (typeof GROWTH_EVENT_STATUSES)[number];
export type GrowthEventOrigin = (typeof GROWTH_EVENT_ORIGINS)[number];
export type RelationLineStyle = (typeof RELATION_LINE_STYLES)[number];
export type RelationOrigin = (typeof RELATION_ORIGINS)[number];
export type AvatarAssetStatus = (typeof AVATAR_ASSET_STATUSES)[number];
export type AvatarStorageKind = (typeof AVATAR_STORAGE_KINDS)[number];
export type AvatarMime = (typeof AVATAR_MIMES)[number];
export type AiDraftKind = (typeof AI_DRAFT_KINDS)[number];
export type AiDraftInputScope = (typeof AI_DRAFT_INPUT_SCOPES)[number];
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];
export type AiItemKind = (typeof AI_ITEM_KINDS)[number];
export type AiItemStatus = (typeof AI_ITEM_STATUSES)[number];
export type DuplicateResolution = (typeof DUPLICATE_RESOLUTIONS)[number];
export type PortabilityJobKind = (typeof PORTABILITY_JOB_KINDS)[number];
export type PortabilityJobStatus = (typeof PORTABILITY_JOB_STATUSES)[number];
export type PortabilityMode = (typeof PORTABILITY_MODES)[number];
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];
export type AnchorInvalidReason = (typeof ANCHOR_INVALID_REASONS)[number];
export type ArchiveScanStatus = (typeof ARCHIVE_SCAN_STATUSES)[number];

// 迁移 SQL 的 IN 列表：仅用于编译期常量，不接受外部输入
export function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}
