// F5 知识库枚举常量：实体类型与迁移 CHECK 共用同一份清单，避免两处漂移

export const KNOWLEDGE_TYPES = ['article', 'paper', 'novel', 'inspiration'] as const;
export const KNOWLEDGE_SOURCES = ['paste', 'manual', 'upload', 'ocr', 'import'] as const;
export const KNOWLEDGE_LINK_TYPES = ['reference', 'inspiration', 'conflict'] as const;
export const KNOWLEDGE_EXPORT_MODES = ['single', 'batch', 'by_type', 'by_tag'] as const;
export const KNOWLEDGE_CONFLICT_STRATEGIES = ['overwrite', 'rename', 'skip'] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];
export type KnowledgeLinkType = (typeof KNOWLEDGE_LINK_TYPES)[number];
export type KnowledgeExportMode = (typeof KNOWLEDGE_EXPORT_MODES)[number];
export type KnowledgeConflictStrategy = (typeof KNOWLEDGE_CONFLICT_STRATEGIES)[number];

// 迁移 SQL 的 IN 列表：复用 character-enums 的实现
export { sqlStringList } from './character-enums';
