import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { CollabReadiness } from '@storyforge/contracts';
import { env as defaultEnv } from '../config/env';
import { SiteConfigService } from '../site-config/site-config.service';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { AgentEntity } from '../database/agent.entity';
import { WorkEntity } from '../database/work.entity';

// 就绪判定所需的环境变量子集（便于单测注入替身；显式允许 undefined 以覆盖 exactOptionalPropertyTypes）
export interface CollabReadinessEnv {
  FLOWISE_BASE_URL?: string | undefined;
  FLOWISE_API_KEY?: string | undefined;
  FASTGPT_BASE_URL?: string | undefined;
  FASTGPT_API_KEY?: string | undefined;
  FASTGPT_DATASET_ID?: string | undefined;
  COZE_API_BASE?: string | undefined;
  COZE_PAT?: string | undefined;
  COZE_BOT_ID?: string | undefined;
  N8N_ARCHIVE_WEBHOOK_URL?: string | undefined;
  N8N_ARCHIVE_TOKEN?: string | undefined;
}

// F11 就绪检查：只返回布尔值与缺失项名称，不返回地址/密钥/上游原始错误（F2 §4.2）
// 判定：Flowise = 环境变量 + Agent platform_config.flowise_chatflow_id 均就绪；
//       Coze = 环境变量就绪；检索 = FastGPT 环境变量就绪；归档 = n8n 环境变量就绪。
// 探测失败不阻塞 API 启动，只让对应能力在就绪接口返回 configured=false（F2 §6.4）。
@Injectable()
export class CollabReadinessService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Optional() private readonly envProvider: CollabReadinessEnv = defaultEnv,
    @Inject(SiteConfigService) private readonly siteConfig?: SiteConfigService
  ) {}

  async getReadiness(authorId: string, workId: string): Promise<CollabReadiness> {
    const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId });
    if (!work || work.author_id !== authorId) {
      // work 不存在或非作者 → 统一 404，不泄露资源存在性
      throw new NotFoundException({ code: 'WORK_NOT_FOUND', message: '作品不存在' });
    }

    const settings = await this.dataSource.getRepository(CollabSettingEntity).findOneBy({ work_id: workId });
    const agent = settings
      ? await this.dataSource.getRepository(AgentEntity).findOneBy({ id: settings.agent_id })
      : null;
    const flowiseConfig = (agent?.platform_config ?? {}) as Record<string, unknown>;
    const flowiseChatflowId = typeof flowiseConfig.flowise_chatflow_id === 'string'
      ? flowiseConfig.flowise_chatflow_id
      : null;

    // 作者级接管：优先从 site_config 平台凭据读，未命中回退 envProvider（env 兜底）
    const credentials = await this.siteConfig?.getPlatformCredentials(authorId) ?? {};
    const cozeCreds = credentials.coze ?? {};
    const flowiseCreds = credentials.flowise ?? {};
    const fastgptCreds = credentials.fastgpt ?? {};
    const n8nCreds = credentials.n8n ?? {};
    const env = this.envProvider;

    return {
      settings: {
        enabled: settings?.enabled ?? false,
        test_character_id: settings?.test_character_id ?? null,
        agent_id: settings?.agent_id ?? null
      },
      channels: {
        flowise: {
          configured: Boolean((flowiseCreds.base_url ?? env.FLOWISE_BASE_URL) && (flowiseCreds.api_key ?? env.FLOWISE_API_KEY) && flowiseChatflowId)
        },
        coze: {
          configured: Boolean((cozeCreds.base_url ?? env.COZE_API_BASE) && (cozeCreds.pat ?? env.COZE_PAT) && env.COZE_BOT_ID)
        }
      },
      retrieval: {
        configured: Boolean((fastgptCreds.base_url ?? env.FASTGPT_BASE_URL) && (fastgptCreds.api_key ?? env.FASTGPT_API_KEY) && (fastgptCreds.dataset_id ?? env.FASTGPT_DATASET_ID))
      },
      archive: {
        configured: Boolean((n8nCreds.webhook_url ?? env.N8N_ARCHIVE_WEBHOOK_URL) && (n8nCreds.token ?? env.N8N_ARCHIVE_TOKEN))
      }
    };
  }
}
