import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID, createHash } from 'node:crypto';
import type {
  CozeImportRequest,
  CozeImportResponse,
  CozeImportResultItem,
  CozeListResourcesResponse,
  CozeResourceItem
} from '@storyforge/contracts';
import { AgentEntity } from '../database/agent.entity';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { AgentService } from '../agent/agent.service';
import { CozeImportClient, type CozeBotListItem, type CozeDatasetListItem } from './coze-import.client';

// content_hash 归一化：与知识库 entries.service 保持一致
function normalizeContentForHash(rawContent: string): string {
  return rawContent.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}
function hashContent(rawContent: string): string {
  return createHash('sha256').update(normalizeContentForHash(rawContent), 'utf8').digest('hex');
}
function normalizeTitleKey(title: string): string {
  return title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * F1 Coze 资源拉取与批量导入服务。
 * 落点：Coze 智能体 → AgentEntity（platform='coze'，source='migration'）；
 *       Coze 知识库 → KnowledgeEntryEntity（origin='coze_import'）。
 * 逐项处理：单项失败（同名冲突/重复哈希）标记 success=false，不整批回滚。
 */
@Injectable()
export class CozeImportService {
  private readonly logger = new Logger(CozeImportService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly client: CozeImportClient,
    private readonly agentService: AgentService
  ) {}

  /** 拉取全部资源（bot + dataset 合并归一化） */
  async listResources(authorId: string, pat: string, workspaceId?: string): Promise<CozeListResourcesResponse> {
    const [bots, datasets] = await Promise.all([
      this.client.listBots(authorId, pat, workspaceId),
      this.client.listDatasets(authorId, pat)
    ]);

    const resources: CozeResourceItem[] = [
      ...bots
        .filter((b) => b.bot_id)
        .map((b): CozeResourceItem => ({
          id: b.bot_id as string,
          name: b.name ?? '未命名智能体',
          description: b.description ?? '',
          icon_url: b.icon_url ?? null,
          type: 'bot'
        })),
      ...datasets
        .filter((d) => d.dataset_id)
        .map((d): CozeResourceItem => ({
          id: d.dataset_id as string,
          name: d.name ?? '未命名知识库',
          description: d.description ?? '',
          icon_url: null,
          type: 'dataset'
        }))
    ];

    return { resources };
  }

  /** 导入所选资源（按 type 分流） */
  async importResources(authorId: string, input: CozeImportRequest): Promise<CozeImportResponse> {
    const bots = input.items.filter((i) => i.type === 'bot');
    const datasets = input.items.filter((i) => i.type === 'dataset');

    const botResults = bots.length > 0 ? await this.importBots(authorId, input.pat_token, bots.map((b) => b.id), input.work_id) : [];
    const datasetResults = datasets.length > 0 ? await this.importDatasets(authorId, input.pat_token, datasets.map((d) => d.id)) : [];

    const results = [...botResults, ...datasetResults];
    return {
      total: results.length,
      imported: results.filter((r) => r.success).length,
      results
    };
  }

  /** 批量导入 Coze 智能体 → AgentEntity */
  async importBots(authorId: string, pat: string, botIds: string[], workId?: string): Promise<CozeImportResultItem[]> {
    const results: CozeImportResultItem[] = [];
    for (const botId of botIds) {
      try {
        const bot = await this.client.getBotInfo(authorId, pat, botId);
        const name = bot.name?.trim() || '未命名智能体';
        await this.agentService.createAgent(authorId, {
          name,
          platform: 'coze',
          platform_config: {
            bot_id: bot.bot_id ?? botId,
            ...(bot.icon_url ? { icon_url: bot.icon_url } : {}),
            ...(bot.description ? { description: bot.description } : {})
          },
          model_id: (bot.model_name as string | undefined) ?? 'coze-default',
          model_config: {},
          description: bot.description ?? '',
          kind: 'legacy',
          source: 'migration',
          scope: 'project',
          project_id: workId ?? null,
          is_default: false
        });
        results.push({ success: true, id: botId, name, type: 'bot', error: null });
      } catch (error) {
        results.push({ success: false, id: botId, name: botId, type: 'bot', error: this.errorMessage(error) });
      }
    }
    return results;
  }

  /** 批量导入 Coze 知识库 → KnowledgeEntryEntity（origin='coze_import'，去重跳过） */
  async importDatasets(authorId: string, pat: string, datasetIds: string[]): Promise<CozeImportResultItem[]> {
    const all = await this.client.listDatasets(authorId, pat);
    const byId = new Map<string, CozeDatasetListItem>();
    for (const d of all) if (d.dataset_id) byId.set(d.dataset_id, d);

    const results: CozeImportResultItem[] = [];
    for (const datasetId of datasetIds) {
      const ds = byId.get(datasetId);
      if (!ds) {
        results.push({ success: false, id: datasetId, name: datasetId, type: 'dataset', error: 'not_found' });
        continue;
      }
      const name = ds.name?.trim() || '未命名知识库';
      const text = ds.description ?? '';
      const contentHash = hashContent(text);
      try {
        const dup = await this.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({
          owner_id: authorId,
          content_hash: contentHash,
          library_scope: 'global',
          deleted_at: IsNull()
        });
        if (dup) {
          results.push({ success: false, id: datasetId, name, type: 'dataset', error: 'duplicate' });
          continue;
        }
        const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
        const entity = repo.create({
          id: randomUUID(),
          owner_id: authorId,
          library_scope: 'global',
          work_id: null,
          entry_type: 'inspiration',
          title: name,
          title_key: normalizeTitleKey(name),
          original_text: text,
          content_hash: contentHash,
          search_text: '',
          structure_status: 'pending',
          outline_status: null,
          structured: null,
          favorite: false,
          pinned: false,
          pinned_at: null,
          origin: 'coze_import',
          source_entry_id: null,
          version: 1,
          deleted_at: null,
          deleted_by: null
        });
        await repo.save(entity);
        results.push({ success: true, id: datasetId, name, type: 'dataset', error: null });
      } catch (error) {
        results.push({ success: false, id: datasetId, name, type: 'dataset', error: this.errorMessage(error) });
      }
    }
    return results;
  }

  /** 测试 Coze 连接（透传 client） */
  async testConnection(authorId: string, pat: string, workspaceId?: string): Promise<{ ok: boolean }> {
    return this.client.testConnection(authorId, pat, workspaceId);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof ConflictException) return 'duplicate';
    if (error instanceof Error) return error.message.slice(0, 200);
    return 'unknown_error';
  }
}

// 避免未使用告警（AgentEntity 类型在 service 中仅作类型引用）
export type { AgentEntity };
