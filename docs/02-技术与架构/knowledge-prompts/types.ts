/**
 * Knowledge base entry types and prompt-related shared types.
 * Align with: 01-产品与设计/知识库条目分类规则.md
 */

export const KNOWLEDGE_ENTRY_TYPES = [
  'article',
  'paper',
  'novel',
  'inspiration',
  'setting',
  'character',
  'plot_template',
  'reference_work',
  'technique',
  'reader_feedback',
  'timeline',
] as const;

export type KnowledgeEntryType = (typeof KNOWLEDGE_ENTRY_TYPES)[number];

export type TypeDetectionResult = {
  type: KnowledgeEntryType;
  confidence: number;
  reason: string;
};

/** P0 required for character structured output */
export const CHARACTER_P0_FIELDS = [
  'name',
  'identity',
  'personality',
  'background',
  'relationships',
] as const;
