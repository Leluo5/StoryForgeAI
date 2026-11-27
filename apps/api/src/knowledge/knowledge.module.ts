import { Module, Logger } from '@nestjs/common';
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
import { KnowledgeToolsController } from './knowledge-tools.controller';
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
import { KnowledgeToolsService } from './knowledge-tools.service';
import { KnowledgeStructureHandler } from './knowledge-structure.handler';
import { KnowledgeJobWorker } from './knowledge-job.worker';
// Provider 依赖（结构 / 嵌入 / LLM，当前均为 Mock）
import {
  KNOWLEDGE_STRUCTURE_PROVIDER,
  MockKnowledgeStructureProvider
} from './structure.provider';
import { LlmKnowledgeStructureProvider } from './structure.llm';
import { KNOWLEDGE_EMBEDDING_PROVIDER, type KnowledgeEmbeddingProvider } from './embedding.provider';
import { MockEmbeddingProvider } from './embedding.mock';
import { KNOWLEDGE_LLM_PROVIDER, MockKnowledgeLlmProvider, type KnowledgeLlmProvider } from './knowledge-llm.provider';
import { RealKnowledgeLlmProvider } from './knowledge-llm.real';
import { RealEmbeddingProvider } from './knowledge-embedding.real';
import { KnowledgeOpenAiClient } from './knowledge-openai.client';
import { KnowledgeCozeClient } from './knowledge-coze.client';
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
    KnowledgeToolsController,
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
    KnowledgeToolsService,
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
    // ── provider 依赖（结构 / 嵌入 / LLM）：凭据存在→真实，缺失→Mock（M3b 关联 D19） ──
    // 凭据来源为全局 env（COZE_* / KNOWLEDGE_OPENAI_*）；作者级 site-config 动态读取
    // 需贯穿 ownerId 到 Provider 的链路改造，超出本次最小闭环，故采用全局 env + 回退 Mock。
    { provide: KNOWLEDGE_STRUCTURE_PROVIDER, useFactory: (llm: KnowledgeLlmProvider) => {
        if (llm instanceof MockKnowledgeLlmProvider) return new MockKnowledgeStructureProvider();
        return new LlmKnowledgeStructureProvider(llm);
      }, inject: [KNOWLEDGE_LLM_PROVIDER] },
    { provide: KNOWLEDGE_EMBEDDING_PROVIDER, useFactory: () => buildEmbeddingProvider(resolveEmbeddingFromEnv()) },
    { provide: KNOWLEDGE_LLM_PROVIDER, useFactory: () => buildLlmProvider(resolveLlmFromEnv()) },
    // ── 旧一代 service（legacy-alias 复用） ──
    KnowledgeService,
    KnowledgeOutlineService,
    KnowledgeMarkdownService
  ],
  exports: [KnowledgeService]
})
export class KnowledgeModule {}

// ───────────────────────────── M3b 关联 · D19 真实模型装配 ─────────────────────────────
//
// 凭据来源：全局 env（COZE_* / KNOWLEDGE_OPENAI_*）。
// 作者级 site-config 动态读取需贯穿 ownerId 到 Provider 的链路改造（StructureInput 无
// ownerId、KnowledgeLlmProvider 接口无 ownerId 参数），超出本次 M3b 关联最小闭环，
// 故采用全局 env + 凭据缺失回退 Mock（CI/本地不炸，生产配置后走真实模型）。
//
// 装配策略（用户已确认：厂商=回退链 / 范围=LLM+嵌入 / 凭据缺失回退 Mock）：
//   KNOWLEDGE_LLM_PROVIDER = 'coze'   → 强制 Coze（无凭据抛 NOT_CONFIGURED，构建即抛）
//   KNOWLEDGE_LLM_PROVIDER = 'openai' → 强制 OpenAI 兼容（无凭据抛 NOT_CONFIGURED）
//   KNOWLEDGE_LLM_PROVIDER = 'auto'   → 有凭据的底层都装配，内部 Coze→OpenAI 回退
//   均无可用凭据 → MockKnowledgeLlmProvider（确定性，CI/本地不炸）

const knowledgeModelLogger = new Logger('KnowledgeModel');

/**
 * LLM 装配输入：mode + 可选 Coze/OpenAI 凭据。
 * 模块层从 env 解析出本对象；测试直接注入本对象（隔离全局 env）。
 */
export interface LlmAssemblyInput {
  mode: 'coze' | 'openai' | 'auto';
  coze?: { baseUrl: string; pat: string; botId: string };
  openai?: { baseUrl: string; apiKey: string; model: string };
}

/**
 * 嵌入装配输入：可选 OpenAI 嵌入凭据。
 */
export interface EmbeddingAssemblyInput {
  openai?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    embedModel?: string;
    embedDimensions?: number;
  };
}

/** 从全局 env 解析 LLM 装配输入（凭据缺失时省略该属性，兼容 exactOptionalPropertyTypes） */
function resolveLlmFromEnv(): LlmAssemblyInput {
  return {
    mode: env.KNOWLEDGE_LLM_PROVIDER,
    ...(env.COZE_API_BASE && env.COZE_PAT && env.COZE_BOT_ID
      ? {
          coze: { baseUrl: env.COZE_API_BASE, pat: env.COZE_PAT, botId: env.COZE_BOT_ID }
        }
      : {}),
    ...(env.KNOWLEDGE_OPENAI_BASE_URL && env.KNOWLEDGE_OPENAI_API_KEY && env.KNOWLEDGE_OPENAI_MODEL
      ? {
          openai: {
            baseUrl: env.KNOWLEDGE_OPENAI_BASE_URL,
            apiKey: env.KNOWLEDGE_OPENAI_API_KEY,
            model: env.KNOWLEDGE_OPENAI_MODEL
          }
        }
      : {})
  };
}

/** 从全局 env 解析嵌入装配输入（凭据缺失时省略该属性） */
function resolveEmbeddingFromEnv(): EmbeddingAssemblyInput {
  if (!env.KNOWLEDGE_OPENAI_BASE_URL || !env.KNOWLEDGE_OPENAI_API_KEY) return {};
  return {
    openai: {
      baseUrl: env.KNOWLEDGE_OPENAI_BASE_URL,
      apiKey: env.KNOWLEDGE_OPENAI_API_KEY,
      model:
        env.KNOWLEDGE_OPENAI_EMBED_MODEL ?? env.KNOWLEDGE_OPENAI_MODEL ?? 'text-embedding-3-small',
      ...(env.KNOWLEDGE_OPENAI_EMBED_MODEL
        ? { embedModel: env.KNOWLEDGE_OPENAI_EMBED_MODEL }
        : {}),
      embedDimensions: env.KNOWLEDGE_OPENAI_EMBED_DIM
    }
  };
}

/**
 * 装配真实 LLM Provider（Coze→OpenAI 回退链）或 Mock。
 * 纯函数：仅依赖注入的 assembly 输入 + logger，便于单测各凭据组合（隔离全局 env）。
 */
export function buildLlmProvider(
  input: LlmAssemblyInput,
  logger: { warn: (message: string) => void; log: (message: string) => void } = knowledgeModelLogger
): KnowledgeLlmProvider {
  const { mode, coze: cozeCreds, openai: openaiCreds } = input;

  let coze: KnowledgeCozeClient | null = null;
  let openai: KnowledgeOpenAiClient | null = null;

  if (mode === 'coze') {
    if (!cozeCreds) {
      logger.warn('[knowledge-llm] KNOWLEDGE_LLM_PROVIDER=coze 但 Coze 凭据缺失，回退 Mock');
      return new MockKnowledgeLlmProvider();
    }
    coze = new KnowledgeCozeClient(cozeCreds);
  } else if (mode === 'openai') {
    if (!openaiCreds) {
      logger.warn('[knowledge-llm] KNOWLEDGE_LLM_PROVIDER=openai 但 OpenAI 凭据缺失，回退 Mock');
      return new MockKnowledgeLlmProvider();
    }
    openai = new KnowledgeOpenAiClient(openaiCreds);
  } else {
    // auto：有凭据的底层都装配（内部 Coze→OpenAI 回退链）
    if (cozeCreds) coze = new KnowledgeCozeClient(cozeCreds);
    if (openaiCreds) openai = new KnowledgeOpenAiClient(openaiCreds);
  }

  if (!coze && !openai) {
    logger.warn('[knowledge-llm] 无可用 LLM 凭据（coze/openai 均缺失），回退 Mock');
    return new MockKnowledgeLlmProvider();
  }

  logger.log(
    `[knowledge-llm] 真实 LLM 已装配（coze=${Boolean(coze)}, openai=${Boolean(openai)}, mode=${mode}）`
  );
  return new RealKnowledgeLlmProvider({ coze, openai, logger });
}

/**
 * 装配真实嵌入 Provider（OpenAI /v1/embeddings）或 Mock。
 * 纯函数：仅依赖注入的 assembly 输入 + logger，便于单测凭据组合（隔离全局 env）。
 */
export function buildEmbeddingProvider(
  input: EmbeddingAssemblyInput,
  logger: { warn: (message: string) => void; log: (message: string) => void } = knowledgeModelLogger
): KnowledgeEmbeddingProvider {
  const openaiCreds = input.openai;

  if (!openaiCreds) {
    logger.warn('[knowledge-embedding] 无 OpenAI 嵌入凭据，回退 Mock');
    return new MockEmbeddingProvider();
  }

  logger.log(
    `[knowledge-embedding] 真实嵌入已装配（model=${openaiCreds.embedModel ?? openaiCreds.model}, dim=${openaiCreds.embedDimensions ?? 1024}）`
  );
  return new RealEmbeddingProvider({ openai: new KnowledgeOpenAiClient(openaiCreds), logger });
}
