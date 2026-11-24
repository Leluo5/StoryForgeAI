/**
 * Mock 结构化 Provider 导出模块（DI 绑定入口）。
 *
 * `MockKnowledgeStructureProvider` 的实际定义位于 structure.provider.ts，
 * 这里作为独立模块导出，便于 NestJS DI 绑定与 M3a 阶段切换。
 */
export { MockKnowledgeStructureProvider, KNOWLEDGE_STRUCTURE_PROVIDER } from './structure.provider';
export type { KnowledgeStructureProvider, StructureInput, StructuredResult } from './structure.provider';
