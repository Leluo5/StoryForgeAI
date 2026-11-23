// M3c-3 知识库枚举常量：实体类型与迁移 CHECK 共用同一份清单，避免两处漂移
// 清单来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2

export const KNOWLEDGE_ENTRY_TYPES = ['article', 'paper', 'novel', 'inspiration', 'setting'] as const;
export const KNOWLEDGE_LIBRARY_SCOPES = ['global', 'work'] as const;
export const KNOWLEDGE_STRUCTURE_STATUSES = ['pending', 'structuring', 'ready', 'failed'] as const;
export const KNOWLEDGE_OUTLINE_STATUSES = ['pending', 'ready', 'failed'] as const;
export const KNOWLEDGE_ORIGINS = ['manual', 'upload', 'markdown_import', 'backup', 'ref_copy'] as const;
export const KNOWLEDGE_LINK_KINDS = ['manual', 'inspiration_auto'] as const;
export const KNOWLEDGE_JOB_KINDS = [
  'ingest',
  'structure',
  'outline',
  'export_markdown',
  'export_backup',
  'import_markdown',
  'restore_backup'
] as const;
export const KNOWLEDGE_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const KNOWLEDGE_JOB_EVENT_TYPES = [
  'queued',
  'running',
  'progress',
  'succeeded',
  'failed',
  'cancelled'
] as const;

export type KnowledgeEntryType = (typeof KNOWLEDGE_ENTRY_TYPES)[number];
export type KnowledgeLibraryScope = (typeof KNOWLEDGE_LIBRARY_SCOPES)[number];
export type KnowledgeStructureStatus = (typeof KNOWLEDGE_STRUCTURE_STATUSES)[number];
export type KnowledgeOutlineStatus = (typeof KNOWLEDGE_OUTLINE_STATUSES)[number];
export type KnowledgeOrigin = (typeof KNOWLEDGE_ORIGINS)[number];
export type KnowledgeLinkKind = (typeof KNOWLEDGE_LINK_KINDS)[number];
export type KnowledgeJobKind = (typeof KNOWLEDGE_JOB_KINDS)[number];
export type KnowledgeJobStatus = (typeof KNOWLEDGE_JOB_STATUSES)[number];
export type KnowledgeJobEventType = (typeof KNOWLEDGE_JOB_EVENT_TYPES)[number];

// 迁移 SQL 的 IN 列表：复用 character-enums 的实现
export { sqlStringList } from './character-enums';
