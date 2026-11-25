import { Injectable, Optional, Inject } from '@nestjs/common';
import { env as defaultEnv } from '../config/env';
import { SiteConfigService } from '../site-config/site-config.service';
import { CollabUpstreamError, timeoutError, upstreamFailedError } from './channel/collab-upstream.error';

// Coze 拉取客户端所需环境变量子集（便于单测注入替身）
export interface CozeImportEnv {
  COZE_API_BASE?: string | undefined;
  COZE_PAT?: string | undefined;
  COLLAB_HTTP_TIMEOUT_MS?: number | undefined;
}

// Coze /v1 列表接口返回
interface CozeV1Response<T> {
  code?: number;
  msg?: string;
  data?: T;
}

// 资源列表项原始返回（bot）
export interface CozeBotListItem {
  bot_id?: string;
  name?: string;
  description?: string;
  icon_url?: string;
  publish_status?: string;
  model_name?: string;
  [key: string]: unknown;
}

// 资源列表项原始返回（dataset）
export interface CozeDatasetListItem {
  dataset_id?: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * F1 Coze 资源拉取客户端。
 * 能力：listBots / getBotInfo / listDatasets / testConnection。
 * 与 CozeChannel 同属 collab/，复用其凭据解析模式：
 *   优先级 = 请求体显式 pat_token > site_config 平台凭据 > env.COZE_PAT
 *   基础 URL = site_config.base_url > env.COZE_API_BASE > 默认 https://api.coze.cn
 * 错误统一映射为 CollabUpstreamError（可重试）。
 */
@Injectable()
export class CozeImportClient {
  private static readonly DEFAULT_BASE = 'https://api.coze.cn';

  constructor(
    @Optional() private readonly envProvider: CozeImportEnv = defaultEnv,
    @Inject(SiteConfigService) private readonly siteConfig?: SiteConfigService
  ) {}

  /** 解析 base + pat（site_config > env，请求体显式 pat 已在 service 层优先处理） */
  private async resolve(authorId: string, patToken?: string): Promise<{ base: string; pat: string }> {
    const credentials = (await this.siteConfig?.getPlatformCredentials(authorId)) ?? {};
    const cozeCreds = credentials.coze ?? {};
    const base = (cozeCreds.base_url ?? this.envProvider.COZE_API_BASE ?? CozeImportClient.DEFAULT_BASE).replace(
      /\/+$/,
      ''
    );
    const pat = patToken ?? cozeCreds.pat ?? this.envProvider.COZE_PAT ?? '';
    return { base, pat };
  }

  private timeoutMs(): number {
    return this.envProvider.COLLAB_HTTP_TIMEOUT_MS ?? 120_000;
  }

  /** 拉取 bot 列表（GET /v1/bots） */
  async listBots(authorId: string, pat?: string, workspaceId?: string): Promise<CozeBotListItem[]> {
    const { base, pat: resolved } = await this.resolve(authorId, pat);
    const params = new URLSearchParams({ page_num: '1', page_size: '100', publish_status: 'all' });
    if (workspaceId) params.set('workspace_id', workspaceId);
    const data = await this.get<CozeV1Response<{ bot_list?: CozeBotListItem[] }>>(
      `${base}/v1/bots?${params.toString()}`,
      resolved
    );
    this.ensureOk(data);
    return data.data?.bot_list ?? [];
  }

  /** 获取 bot 详情（GET /v1/bots/{bot_id}） */
  async getBotInfo(authorId: string, pat: string, botId: string): Promise<CozeBotListItem> {
    const { base, pat: resolved } = await this.resolve(authorId, pat);
    const data = await this.get<CozeV1Response<CozeBotListItem>>(
      `${base}/v1/bots/${encodeURIComponent(botId)}`,
      resolved
    );
    this.ensureOk(data);
    return data.data ?? {};
  }

  /** 拉取 dataset 列表（GET /v1/datasets） */
  async listDatasets(authorId: string, pat: string): Promise<CozeDatasetListItem[]> {
    const { base, pat: resolved } = await this.resolve(authorId, pat);
    const params = new URLSearchParams({ page: '1', size: '100' });
    const data = await this.get<CozeV1Response<{ dataset_list?: CozeDatasetListItem[] }>>(
      `${base}/v1/datasets?${params.toString()}`,
      resolved
    );
    this.ensureOk(data);
    return data.data?.dataset_list ?? [];
  }

  /** 测试连接：调 listBots 首页判 code===0 */
  async testConnection(authorId: string, pat: string, workspaceId?: string): Promise<{ ok: boolean }> {
    try {
      await this.listBots(authorId, pat, workspaceId);
      return { ok: true };
    } catch (error) {
      if (error instanceof CollabUpstreamError) return { ok: false };
      throw error;
    }
  }

  private ensureOk(data: CozeV1Response<unknown>): void {
    if (typeof data.code === 'number' && data.code !== 0) {
      throw upstreamFailedError(`Coze 上游返回错误: ${data.code} ${data.msg ?? ''}`.trim());
    }
  }

  private async get<T>(url: string, pat: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${pat}` },
        signal: controller.signal
      });
      if (!response.ok) {
        throw upstreamFailedError(`Coze 返回 ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof CollabUpstreamError) throw error;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) throw timeoutError('Coze 请求超时');
      throw upstreamFailedError(`Coze 请求失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
