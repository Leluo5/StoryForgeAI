import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CozeImportService } from './coze-import.service';
import { CozeImportClient } from './coze-import.client';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { AgentEntity } from '../database/agent.entity';

// F1 CozeImportService：分流 / 去重 / 错误映射 / 落库字段（真库 + 替身 client/agentService）

let fixture: WritingFixture;
let fetchMock: ReturnType<typeof vi.fn>;

function okJson(data: unknown, code = 0, msg?: string) {
  return { ok: true, status: 200, json: async () => ({ code, msg, data }) };
}

function makeService(dataSource: DataSource, agentService: unknown) {
  const client = new CozeImportClient({ COZE_API_BASE: 'https://api.coze.example.com', COZE_PAT: 'pat' }, {
    getPlatformCredentials: async () => ({})
  } as never);
  return new CozeImportService(dataSource, client, agentService as never);
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  void destroyWritingFixture(fixture);
});

describe('CozeImportService.listResources (F1)', () => {
  it('合并 bot + dataset 并归一化为 CozeResourceItem', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ bot_list: [{ bot_id: 'b1', name: '博文', description: 'desc', icon_url: 'https://i' }] }))
      .mockResolvedValueOnce(okJson({ dataset_list: [{ dataset_id: 'd1', name: '知识' }] }));

    const service = makeService(fixture.dataSource, {});
    const res = await service.listResources(fixture.authorId, 'pat');

    expect(res.resources).toHaveLength(2);
    const bot = res.resources.find((r) => r.id === 'b1')!;
    expect(bot.type).toBe('bot');
    expect(bot.name).toBe('博文');
    expect(bot.icon_url).toBe('https://i');
    const ds = res.resources.find((r) => r.id === 'd1')!;
    expect(ds.type).toBe('dataset');
    expect(ds.icon_url).toBeNull();
  });

  it('过滤缺失 id 的资源', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ bot_list: [{ name: '无 id' }] }))
      .mockResolvedValueOnce(okJson({ dataset_list: [] }));
    const service = makeService(fixture.dataSource, {});
    const res = await service.listResources(fixture.authorId, 'pat');
    expect(res.resources).toHaveLength(0);
  });
});

describe('CozeImportService.importBots (F1)', () => {
  it('成功：调用 createAgent 且 platform=coze/source=migration/kind=legacy', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_id: 'b1', name: '博文', description: 'd', icon_url: 'https://i', model_name: 'gpt-4o' }));

    const createAgent = vi.fn().mockResolvedValue({ agent: {} });
    const service = makeService(fixture.dataSource, { createAgent });
    const results = await service.importBots(fixture.authorId, 'pat', ['b1'], fixture.workId);

    expect(results).toEqual([{ success: true, id: 'b1', name: '博文', type: 'bot', error: null }]);
    expect(createAgent).toHaveBeenCalledTimes(1);
    const [, input] = createAgent.mock.calls[0]!;
    expect(input).toMatchObject({
      name: '博文',
      platform: 'coze',
      source: 'migration',
      kind: 'legacy',
      scope: 'project',
      project_id: fixture.workId,
      description: 'd',
      model_id: 'gpt-4o',
      is_default: false
    });
    expect(input.platform_config).toMatchObject({ bot_id: 'b1', icon_url: 'https://i', description: 'd' });
  });

  it('同名冲突（ConflictException）→ error=duplicate，不中断其余', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ bot_id: 'b1', name: '重复' }))
      .mockResolvedValueOnce(okJson({ bot_id: 'b2', name: '成功' }));

    const createAgent = vi.fn()
      .mockRejectedValueOnce(new ConflictException({ message: 'Agent name already exists' }))
      .mockResolvedValueOnce({ agent: {} });
    const service = makeService(fixture.dataSource, { createAgent });
    const results = await service.importBots(fixture.authorId, 'pat', ['b1', 'b2']);

    expect(results).toEqual([
      { success: false, id: 'b1', name: 'b1', type: 'bot', error: 'duplicate' },
      { success: true, id: 'b2', name: '成功', type: 'bot', error: null }
    ]);
  });

  it('上游失败 → error 为消息（截断 200）', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}, 4200, 'bad'));
    const service = makeService(fixture.dataSource, { createAgent: vi.fn() });
    const results = await service.importBots(fixture.authorId, 'pat', ['b1']);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain('bad');
  });
});

describe('CozeImportService.importDatasets (F1)', () => {
  it('成功：以 origin=coze_import 落库', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ dataset_list: [{ dataset_id: 'd1', name: '知识', description: '内容' }] }));
    const service = makeService(fixture.dataSource, {});
    const results = await service.importDatasets(fixture.authorId, 'pat', ['d1']);

    expect(results).toEqual([{ success: true, id: 'd1', name: '知识', type: 'dataset', error: null }]);
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ owner_id: fixture.authorId });
    expect(entity?.origin).toBe('coze_import');
    expect(entity?.title).toBe('知识');
    expect(entity?.library_scope).toBe('global');
    expect(entity?.entry_type).toBe('inspiration');
  });

  it('相同 content_hash 已存在 → error=duplicate 不落库', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ dataset_list: [{ dataset_id: 'd1', name: '知识', description: '内容' }] }));
    const service = makeService(fixture.dataSource, {});
    const first = await service.importDatasets(fixture.authorId, 'pat', ['d1']);
    expect(first[0]!.success).toBe(true);

    // 再次拉取同一内容 → 去重
    fetchMock.mockResolvedValueOnce(okJson({ dataset_list: [{ dataset_id: 'd1', name: '知识', description: '内容' }] }));
    const second = await service.importDatasets(fixture.authorId, 'pat', ['d1']);
    expect(second[0]).toMatchObject({ success: false, error: 'duplicate' });

    const count = await fixture.dataSource.getRepository(KnowledgeEntryEntity).countBy({ owner_id: fixture.authorId });
    expect(count).toBe(1);
  });

  it('找不到 dataset → error=not_found', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ dataset_list: [] }));
    const service = makeService(fixture.dataSource, {});
    const results = await service.importDatasets(fixture.authorId, 'pat', ['nope']);
    expect(results[0]).toMatchObject({ success: false, error: 'not_found' });
  });
});

describe('CozeImportService.importResources (F1)', () => {
  it('按 type 分流并汇总 imported', async () => {
    // 顺序：listDatasets（datasets）先于 getBotInfo（bots）？importResources 先 bots 后 datasets
    fetchMock
      .mockResolvedValueOnce(okJson({ bot_id: 'b1', name: '博文' })) // getBotInfo b1
      .mockResolvedValueOnce(okJson({ dataset_list: [{ dataset_id: 'd1', name: '知识', description: '内容' }] })); // listDatasets

    const service = makeService(fixture.dataSource, { createAgent: vi.fn().mockResolvedValue({ agent: {} }) });
    const res = await service.importResources(fixture.authorId, {
      pat_token: 'pat',
      items: [
        { id: 'b1', type: 'bot' },
        { id: 'd1', type: 'dataset' }
      ],
      work_id: fixture.workId
    });

    expect(res.total).toBe(2);
    expect(res.imported).toBe(2);
    expect(res.results.every((r) => r.success)).toBe(true);
  });

  it('bot 走 createAgent 且输入 platform=coze/source=migration', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_id: 'b1', name: '博文' }));
    const createAgent = vi.fn().mockResolvedValue({ agent: {} });
    const service = makeService(fixture.dataSource, { createAgent });
    await service.importResources(fixture.authorId, { pat_token: 'pat', items: [{ id: 'b1', type: 'bot' }] });
    const [, input] = createAgent.mock.calls[0]!;
    expect(input.platform).toBe('coze');
    expect(input.source).toBe('migration');
    expect(input.kind).toBe('legacy');
  });
});
