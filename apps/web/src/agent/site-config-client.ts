import {
  getSiteConfigResponseSchema,
  updateSiteConfigRequestSchema,
  type SiteConfigResponse,
  type UpdateSiteConfigRequest
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1';
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ───────────────────────────── 站点设置（F4 作者级） ─────────────────────────────

/** 读取当前作者站点设置（无记录返回默认值） */
export function getSiteConfig(): Promise<{ config: SiteConfigResponse }> {
  return apiRequest(`${root}/site-config`, getSiteConfigResponseSchema);
}

/** 更新当前作者站点设置（站点信息 / LLM 配置 / 平台凭据，至少一项） */
export function updateSiteConfig(input: UpdateSiteConfigRequest): Promise<{ config: SiteConfigResponse }> {
  return apiRequest(
    `${root}/site-config`,
    getSiteConfigResponseSchema,
    json('PUT', updateSiteConfigRequestSchema.parse(input))
  );
}

export type { SiteConfigResponse, UpdateSiteConfigRequest };
