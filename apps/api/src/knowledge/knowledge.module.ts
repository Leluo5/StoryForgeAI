import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { env } from '../config/env';

// 实体（知识库全部实体，T27 装配）
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeEntryLinkEntity } from '../database/knowledge-entry-link.entity';
import { KnowledgeEntryEmbeddingEntity } from '../database/knowledge-entry-embedding.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { KnowledgeJobEventEntity } from '../database/knowledge-job-event.entity';

// 鉴权（SessionGuard / CsrfGuard）
import { AuthModule } from '../auth/auth.module';

// ── 新知识库模块（T21-T26） ──
// Controller
import { KnowledgeEntriesController } from './entries.controller';
import { KnowledgeTagsController } from './tags.controller';
import { KnowledgeLinksController } from './links.controller';
import { KnowledgeWorkRefsController } from './work-refs.controller';
import { KnowledgeUploadsController } from './uploads.controller';
import { KnowledgeJobsController } from './jobs.controller';
import { KnowledgeJobsSseController } from './jobs-sse.controller';
import { KnowledgePortabilityController } from './portability.controller';
import { KnowledgeBackupController } from './backup.controller';
// 旧端点兼容别名（T27）
import { KnowledgeLegacyAliasController } from './legacy-alias.controller';
// Service
import { KnowledgeEntriesService } from './entries.service';
import { KnowledgeTagsService } from './tags.service';
import { KnowledgeLinksService } from './links.service';
import { KnowledgeRefsService } from './refs.service';
import { KnowledgeTrashService } from './trash.service';
import { KnowledgeSearchService } from './search.service';
import { KnowledgeIngestService } from './knowledge-ingest.service';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeJobSseService, KnowledgeJobEventBus } from './jobs.sse';
import { KnowledgePortabilityService } from './knowledge-portability.service';
import { KnowledgeBackupService } from './knowledge-backup.service';
import { KnowledgeStructureHandler } from './knowledge-structure.handler';
import { KnowledgeJobWorker } from './knowledge-job.worker';
// Provider 依赖（结构 / 嵌入 / LLM，当前均为 Mock）
import {
  KNOWLEDGE_STRUCTURE_PROVIDER,
  MockKnowledgeStructureProvider
} from './structure.provider';
import { KNOWLEDGE_EMBEDDING_PROVIDER } from './embedding.provider';
import { MockEmbeddingProvider } from './embedding.mock';
import { KNOWLEDGE_LLM_PROVIDER, MockKnowledgeLlmProvider } from './knowledge-llm.provider';
// 队列
import { createKnowledgeJobsQueue } from './jobs.queue';

// ── 旧一代 service（legacy-alias 复用，T27 兼容别名） ──
import { KnowledgeService } from './knowledge.service';
import { KnowledgeOutlineService } from './knowledge-outline.service';
import { KnowledgeMarkdownService } from './knowledge-markdown.service';

/**
 * 知识库作业队列 token（KnowledgeJobService 构造的 queue 为裸接口类型，
 * 无 @Inject 注解，DI 无法按类型解析接口，故用本地 token + useFactory 提供实例）。
 */
const KNOWLEDGE_JOBS_QUEUE = Symbol('KNOWLEDGE_JOBS_QUEUE');

/**
 * 知识库管理模块（T27 · F4 编码实现 L3 收官）。
 *
 * 装配范围：
 * - 新知识库控制器（T21-T26）共 9 个 + 旧端点兼容别名（legacy-alias）。
 * - 新 service / worker / handler / eventBus 及其 provider 依赖（structure/embedding/llm Mock）。
 * - 旧一代 service（knowledge/outline/markdown）供 legacy-alias 复用（不改业务逻辑）。
 *
 * 路由冲突处理（用户已决策）：旧 knowledge.controller.ts 不再挂载；
 * 其 POST/GET /knowledge/entries 由新 entries.controller 取代；
 * 其余 7 条非冲突旧端点由 legacy-alias 保留（挂 @deprecated + X-Knowledge-Deprecated 头）。
 *
 * 导出 KnowledgeService 供其他模块复用（如 AI 助手挂载知识库上下文）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      KnowledgeEntryEntity,
      KnowledgeWorkRefEntity,
      KnowledgeTagEntity,
      KnowledgeEntryTagEntity,
      KnowledgeEntryLinkEntity,
      KnowledgeEntryEmbeddingEntity,
      KnowledgeJobEntity,
      KnowledgeJobEventEntity
    ]),
    AuthModule
  ],
  controllers: [
    // 新知识库控制器（T21-T26）
    KnowledgeEntriesController,
    KnowledgeTagsController,
    KnowledgeLinksController,
    KnowledgeWorkRefsController,
    KnowledgeUploadsController,
    KnowledgeJobsController,
    KnowledgeJobsSseController,
    KnowledgePortabilityController,
    KnowledgeBackupController,
    // 旧端点兼容别名（T27）
    KnowledgeLegacyAliasController
  ],
  providers: [
    // ── 新 service ──
    KnowledgeEntriesService,
    KnowledgeTagsService,
    KnowledgeLinksService,
    KnowledgeRefsService,
    KnowledgeTrashService,
    KnowledgeSearchService,
    KnowledgeIngestService,
    KnowledgeJobSseService,
    KnowledgePortabilityService,
    KnowledgeBackupService,
    KnowledgeStructureHandler,
    KnowledgeJobWorker,
    KnowledgeJobEventBus,
    // KnowledgeJobService 的 queue 为裸接口类型（无 @Inject），DI 无法按类型解析接口，
    // 故用 useFactory 显式注入 DataSource + 队列 token + eventBus 实例。
    {
      provide: KnowledgeJobService,
      useFactory: (ds: DataSource, queue: ReturnType<typeof createKnowledgeJobsQueue>, bus?: KnowledgeJobEventBus) =>
        new KnowledgeJobService(ds, queue, bus),
      inject: [DataSource, KNOWLEDGE_JOBS_QUEUE, KnowledgeJobEventBus]
    },
    // ── 队列（BullMQ 连接） ──
    {
      provide: KNOWLEDGE_JOBS_QUEUE,
      useFactory: () => createKnowledgeJobsQueue({ url: env.REDIS_URL, maxRetriesPerRequest: null })
    },
    // ── provider 依赖（结构 / 嵌入 / LLM，当前 Mock） ──
    { provide: KNOWLEDGE_STRUCTURE_PROVIDER, useClass: MockKnowledgeStructureProvider },
    { provide: KNOWLEDGE_EMBEDDING_PROVIDER, useClass: MockEmbeddingProvider },
    { provide: KNOWLEDGE_LLM_PROVIDER, useClass: MockKnowledgeLlmProvider },
    // ── 旧一代 service（legacy-alias 复用） ──
    KnowledgeService,
    KnowledgeOutlineService,
    KnowledgeMarkdownService
  ],
  exports: [KnowledgeService]
})
export class KnowledgeModule {}
