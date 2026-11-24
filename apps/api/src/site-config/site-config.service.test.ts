import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { SiteConfigService } from './site-config.service';

let fixture: WritingFixture;

beforeEach(async () => {
  fixture = await createWritingFixture();
});
afterEach(() => destroyWritingFixture(fixture));

describe('SiteConfigService (F4 作者级)', () => {
  it('returns defaults when no config exists', async () => {
    const service = new SiteConfigService(fixture.dataSource);
    const config = await service.getConfig(fixture.authorId);
    expect(config.site_name).toBe('我的创作站');
    expect(config.theme).toBe('light');
    expect(config.llm_config).toEqual({});
    expect(config.platform_credentials).toEqual({});
  });

  it('upserts and merges nested fields', async () => {
    const service = new SiteConfigService(fixture.dataSource);
    await service.updateConfig(fixture.authorId, {
      site_name: '我的站',
      site_description: '创作站',
      theme: 'dark',
      llm_config: { base_url: 'https://llm', api_key: 'sk-1', model: 'gpt-4o' },
      platform_credentials: {
        coze: { base_url: 'https://api.coze.cn', pat: 'pat-1' },
        flowise: { base_url: 'https://flowise', api_key: 'fk' }
      }
    });

    const config = await service.getConfig(fixture.authorId);
    expect(config.site_name).toBe('我的站');
    expect(config.llm_config.api_key).toBe('sk-1');
    expect(config.platform_credentials.coze?.pat).toBe('pat-1');
    expect(config.platform_credentials.n8n).toBeUndefined();
  });

  it('partial update preserves other fields', async () => {
    const service = new SiteConfigService(fixture.dataSource);
    await service.updateConfig(fixture.authorId, { site_name: '原名', site_description: '原描述' });
    await service.updateConfig(fixture.authorId, { site_name: '新名' });

    const config = await service.getConfig(fixture.authorId);
    expect(config.site_name).toBe('新名');
    expect(config.site_description).toBe('原描述');
  });

  it('getPlatformCredentials returns {} when absent', async () => {
    const service = new SiteConfigService(fixture.dataSource);
    expect(await service.getPlatformCredentials(fixture.authorId)).toEqual({});
  });

  it('getPlatformCredentials returns saved credentials', async () => {
    const service = new SiteConfigService(fixture.dataSource);
    await service.updateConfig(fixture.authorId, {
      platform_credentials: { fastgpt: { base_url: 'https://fastgpt', api_key: 'fk', dataset_id: 'ds1' } }
    });
    const creds = await service.getPlatformCredentials(fixture.authorId);
    expect(creds.fastgpt?.api_key).toBe('fk');
    expect(creds.fastgpt?.dataset_id).toBe('ds1');
  });
});
