import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { CollabReadiness } from '@storyforge/contracts';
import { env as defaultEnv } from '../config/env';
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
    private readonly envProvider: CollabReadinessEnv = defaultEnv
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

    return {
      settings: {
        enabled: settings?.enabled ?? false,
        test_character_id: settings?.test_character_id ?? null,
        agent_id: settings?.agent_id ?? null
      },
      channels: {
        flowise: {
          configured: Boolean(this.envProvider.FLOWISE_BASE_URL && this.envProvider.FLOWISE_API_KEY && flowiseChatflowId)
        },
        coze: {
          configured: Boolean(this.envProvider.COZE_API_BASE && this.envProvider.COZE_PAT && this.envProvider.COZE_BOT_ID)
        }
      },
      retrieval: {
        configured: Boolean(this.envProvider.FASTGPT_BASE_URL && this.envProvider.FASTGPT_API_KEY && this.envProvider.FASTGPT_DATASET_ID)
      },
      archive: {
        configured: Boolean(this.envProvider.N8N_ARCHIVE_WEBHOOK_URL && this.envProvider.N8N_ARCHIVE_TOKEN)
      }
    };
  }
}
