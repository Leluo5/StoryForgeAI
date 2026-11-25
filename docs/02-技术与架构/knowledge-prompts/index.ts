/**
 * Knowledge base LLM prompts — public API
 *
 * Docs:
 * - 01-产品与设计/知识库提示词Few-shot增强版.md (v2.0)
 * - 01-产品与设计/知识库提示词判定与拆分示例.md
 * - 01-产品与设计/知识库结构化字段详细定义.md
 */

export {
  KNOWLEDGE_ENTRY_TYPES,
  CHARACTER_P0_FIELDS,
  type KnowledgeEntryType,
  type TypeDetectionResult,
} from './types';

export {
  TYPE_DETECTION_SYSTEM_PROMPT,
  buildTypeDetectionUserPrompt,
} from './typeDetection';

export {
  STRUCTURED_PROMPTS,
  getStructuredSystemPrompt,
  buildStructuredUserPrompt,
} from './structuredPrompts';
