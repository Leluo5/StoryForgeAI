import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeParserService } from './knowledge-parser.service';
import { KnowledgeOutlineService } from './knowledge-outline.service';
import { KnowledgeLinkerService } from './knowledge-linker.service';
import { KnowledgeMarkdownService } from './knowledge-markdown.service';
import { KNOWLEDGE_LLM_PROVIDER, MockKnowledgeLlmProvider } from './knowledge-llm.provider';

/**
 * 知识库管理模块（F5 重构版，全局作用域，不按作品）。
 * 组装：KnowledgeService（持久化）+ 引擎层（LLM/解析/大纲/关联/Markdown）。
 * 依赖鉴权（SessionGuard → AuthModule）；LLM 提供者当前为 Mock（M3b 接 Coze）。
 * 导出 KnowledgeService 供其他模块复用（如 AI 助手挂载知识库上下文）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([KnowledgeEntryEntity]), AuthModule],
  providers: [
    KnowledgeService,
    KnowledgeParserService,
    KnowledgeOutlineService,
    KnowledgeLinkerService,
    KnowledgeMarkdownService,
    { provide: KNOWLEDGE_LLM_PROVIDER, useClass: MockKnowledgeLlmProvider }
  ],
  controllers: [KnowledgeController],
  exports: [KnowledgeService]
})
export class KnowledgeModule {}
