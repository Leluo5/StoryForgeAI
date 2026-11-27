import { describe, expect, it } from 'vitest';
import * as contracts from './index';
import {
  cozeListResourcesRequestSchema,
  cozeListResourcesResponseSchema,
  cozeImportRequestSchema,
  cozeImportResponseSchema,
  cozeResourceItemSchema,
  cozeResourceTypeSchema
} from './coze-import';

describe('F1 coze-import contracts', () => {
  it('all schemas are exported from the package entry', () => {
    // 前端 coze-import-client.ts 从包入口 '@storyforge/contracts' 导入这些 schema，
    // 若 index.ts 漏导出，ES 导入会直接失败（本地路径导入的测试无法发现）
    for (const key of [
      'cozeResourceTypeSchema',
      'cozeResourceItemSchema',
      'cozeListResourcesRequestSchema',
      'cozeListResourcesResponseSchema',
      'cozeImportRequestSchema',
      'cozeImportResultItemSchema',
      'cozeImportResponseSchema'
    ] as const) {
      expect(contracts[key], `index.ts 未导出 ${key}`).toBeTruthy();
    }
  });
  describe('resource item', () => {
    const base = {
      id: 'bot-1',
      name: '角色生成器',
      description: '生成角色资料',
      icon_url: 'https://example.com/a.png',
      type: 'bot'
    };

    it('accepts valid bot item', () => {
      const parsed = cozeResourceItemSchema.parse(base);
      expect(parsed.type).toBe('bot');
      expect(parsed.description).toBe('生成角色资料');
    });

    it('defaults description and icon_url', () => {
      const parsed = cozeResourceItemSchema.parse({ id: 'ds-1', name: '知识库', type: 'dataset' });
      expect(parsed.description).toBe('');
      expect(parsed.icon_url).toBeNull();
    });

    it('accepts workflow type (M4-T10 新增)', () => {
      expect(cozeResourceTypeSchema.safeParse('workflow').success).toBe(true);
    });

    it('rejects unknown type', () => {
      expect(cozeResourceTypeSchema.safeParse('unknown_type').success).toBe(false);
    });

    it('strictly rejects extra keys', () => {
      expect(cozeResourceItemSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    });
  });

  describe('list request', () => {
    it('accepts pat_token with optional workspace_id', () => {
      expect(cozeListResourcesRequestSchema.safeParse({ pat_token: 'pat-abc' }).success).toBe(true);
      expect(cozeListResourcesRequestSchema.safeParse({ pat_token: 'pat-abc', workspace_id: 'ws-1' }).success).toBe(true);
    });

    it('rejects missing or blank pat_token', () => {
      expect(cozeListResourcesRequestSchema.safeParse({}).success).toBe(false);
      expect(cozeListResourcesRequestSchema.safeParse({ pat_token: '   ' }).success).toBe(false);
    });
  });

  describe('list response', () => {
    it('accepts resources array', () => {
      const parsed = cozeListResourcesResponseSchema.parse({
        resources: [{ id: 'bot-1', name: 'B', type: 'bot' }]
      });
      expect(parsed.resources).toHaveLength(1);
    });
  });

  describe('import request', () => {
    it('accepts 1-200 items with work_id optional', () => {
      expect(
        cozeImportRequestSchema.safeParse({
          pat_token: 'pat-abc',
          items: [{ id: 'bot-1', type: 'bot' }]
        }).success
      ).toBe(true);
      expect(
        cozeImportRequestSchema.safeParse({
          pat_token: 'pat-abc',
          items: [{ id: 'bot-1', type: 'bot' }],
          work_id: '11111111-1111-4111-8111-111111111111'
        }).success
      ).toBe(true);
    });

    it('rejects empty items', () => {
      expect(cozeImportRequestSchema.safeParse({ pat_token: 'pat-abc', items: [] }).success).toBe(false);
    });

    it('rejects >200 items', () => {
      const items = Array.from({ length: 201 }, (_, i) => ({ id: `id-${i}`, type: 'bot' as const }));
      expect(cozeImportRequestSchema.safeParse({ pat_token: 'pat-abc', items }).success).toBe(false);
    });

    it('rejects invalid work_id', () => {
      expect(
        cozeImportRequestSchema.safeParse({
          pat_token: 'pat-abc',
          items: [{ id: 'bot-1', type: 'bot' }],
          work_id: 'not-a-uuid'
        }).success
      ).toBe(false);
    });

    it('strictly rejects extra keys', () => {
      expect(
        cozeImportRequestSchema.safeParse({
          pat_token: 'pat-abc',
          items: [{ id: 'bot-1', type: 'bot' }],
          extra: true
        }).success
      ).toBe(false);
    });
  });

  describe('import response', () => {
    it('accepts result summary', () => {
      const parsed = cozeImportResponseSchema.parse({
        total: 2,
        imported: 1,
        results: [
          { success: true, id: 'bot-1', name: 'B', type: 'bot' },
          { success: false, id: 'ds-1', name: 'D', type: 'dataset', error: 'duplicate' }
        ]
      });
      expect(parsed.imported).toBe(1);
      expect(parsed.results[1]?.error).toBe('duplicate');
    });

    it('defaults error to null on success item', () => {
      const parsed = cozeImportResponseSchema.parse({
        total: 1,
        imported: 1,
        results: [{ success: true, id: 'bot-1', name: 'B', type: 'bot' }]
      });
      expect(parsed.results[0]?.error).toBeNull();
    });
  });
});
