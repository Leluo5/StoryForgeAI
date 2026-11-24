import { InjectDataSource } from '@nestjs/typeorm';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  PlatformCredentials,
  SiteConfigResponse,
  UpdateSiteConfigRequest
} from '@storyforge/contracts';
import { SiteConfigEntity } from '../database/site-config.entity';

// F4 作者级站点设置：每个作者一条 site_config，作者登录即可访问自己的后台，无独立认证。
// 站点设置含 llm_config 与 platform_credentials（jsonb），用户选择完整入库含 api_key/pat（风险由用户权衡接受）。
// 消费方（coze/flowise channel、fastgpt client、collab-readiness）优先从 site_config 读凭据、env 兜底。
const DEFAULT_SITE_NAME = '我的创作站';

function toResponse(entity: SiteConfigEntity): SiteConfigResponse {
  return {
    site_name: entity.site_name,
    site_description: entity.site_description,
    theme: entity.theme === 'dark' ? 'dark' : 'light',
    llm_config: entity.llm_config as SiteConfigResponse['llm_config'],
    platform_credentials: entity.platform_credentials as SiteConfigResponse['platform_credentials']
  };
}

@Injectable()
export class SiteConfigService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** 读取作者站点设置；无记录返回默认值（不落库，读时生成） */
  async getConfig(authorId: string): Promise<SiteConfigResponse> {
    const entity = await this.dataSource.getRepository(SiteConfigEntity).findOneBy({ author_id: authorId });
    if (!entity) {
      return {
        site_name: DEFAULT_SITE_NAME,
        site_description: '',
        theme: 'light',
        llm_config: {},
        platform_credentials: {}
      };
    }
    return toResponse(entity);
  }

  /** 更新作者站点设置（事务 upsert）：无则插入，有则合并；嵌套对象逐字段合并，传入 undefined 保留原值 */
  async updateConfig(authorId: string, input: UpdateSiteConfigRequest): Promise<SiteConfigResponse> {
    const repo = this.dataSource.getRepository(SiteConfigEntity);
    const existing = await repo.findOneBy({ author_id: authorId });

    const entity = existing ?? repo.create({ id: randomUUID(), author_id: authorId });
    if (input.site_name !== undefined) entity.site_name = input.site_name;
    if (input.site_description !== undefined) entity.site_description = input.site_description;
    if (input.theme !== undefined) entity.theme = input.theme;
    // 嵌套对象逐字段合并：传入 undefined 的键保留原值（partial 更新语义）
    if (input.llm_config !== undefined) {
      entity.llm_config = { ...(entity.llm_config ?? {}), ...input.llm_config };
    }
    if (input.platform_credentials !== undefined) {
      const merged = { ...(entity.platform_credentials ?? {}) };
      for (const [platform, creds] of Object.entries(input.platform_credentials)) {
        if (creds && typeof creds === 'object') {
          const existingPlatform = (merged[platform] ?? {}) as Record<string, unknown>;
          merged[platform] = { ...existingPlatform, ...creds };
        }
      }
      entity.platform_credentials = merged;
    }

    const saved = await repo.save(entity);
    return toResponse(saved);
  }

  /** 供消费方（channel/client）查平台凭据：无记录返回 {}，由消费方 env 兜底 */
  async getPlatformCredentials(authorId: string): Promise<PlatformCredentials> {
    const entity = await this.dataSource.getRepository(SiteConfigEntity).findOneBy({ author_id: authorId });
    if (!entity) return {};
    return (entity.platform_credentials ?? {}) as PlatformCredentials;
  }
}
