import { describe, expect, it } from 'vitest';
import {
  getSiteConfigResponseSchema,
  siteConfigResponseSchema,
  updateSiteConfigRequestSchema
} from './site-config';

// F4 作者级站点设置契约：默认值 / theme 枚举 / 至少一字段 refine / 嵌套 partial。
describe('site-config contracts', () => {
  it('produces full defaults for empty llm_config and platform_credentials', () => {
    const parsed = siteConfigResponseSchema.parse({
      site_name: '我的创作站',
      site_description: '',
      theme: 'light'
    });
    expect(parsed.llm_config).toEqual({});
    expect(parsed.platform_credentials).toEqual({});
  });

  it('rejects invalid theme', () => {
    expect(() =>
      siteConfigResponseSchema.parse({ site_name: 'x', site_description: '', theme: 'blue' })
    ).toThrow();
  });

  it('accepts dark theme and full credentials with sensitive keys', () => {
    const parsed = siteConfigResponseSchema.parse({
      site_name: '站点',
      site_description: '描述',
      theme: 'dark',
      llm_config: { base_url: 'https://llm', api_key: 'sk-1', model: 'gpt-4o' },
      platform_credentials: {
        coze: { base_url: 'https://api.coze.cn', pat: 'pat_1' },
        flowise: { base_url: 'https://flowise', api_key: 'fk' },
        fastgpt: { base_url: 'https://fastgpt', api_key: 'fk2', dataset_id: 'ds1' },
        n8n: { webhook_url: 'https://n8n', token: 't1' }
      }
    });
    expect(parsed.theme).toBe('dark');
    expect(parsed.llm_config.api_key).toBe('sk-1');
    expect(parsed.platform_credentials.coze?.pat).toBe('pat_1');
  });

  it('update requires at least one field', () => {
    expect(() => updateSiteConfigRequestSchema.parse({})).toThrow();
  });

  it('update allows partial nested objects', () => {
    const parsed = updateSiteConfigRequestSchema.parse({
      site_name: '新名',
      llm_config: { api_key: 'sk-2' },
      platform_credentials: { coze: { pat: 'pat_2' } }
    });
    expect(parsed.site_name).toBe('新名');
    expect(parsed.llm_config?.api_key).toBe('sk-2');
    expect(parsed.platform_credentials?.coze?.pat).toBe('pat_2');
  });

  it('get response requires config object', () => {
    const parsed = getSiteConfigResponseSchema.parse({
      config: { site_name: 'a', site_description: '', theme: 'light' }
    });
    expect(parsed.config.site_name).toBe('a');
  });
});
