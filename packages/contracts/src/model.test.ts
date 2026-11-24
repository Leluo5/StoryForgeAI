import { describe, expect, it } from 'vitest';
import {
  createModelRequestSchema,
  modelSchema,
  updateModelRequestSchema
} from './model';

describe('model contracts', () => {
  describe('createModelRequestSchema', () => {
    it('accepts valid minimal input with defaults', () => {
      const parsed = createModelRequestSchema.parse({
        name: 'GPT-4o mini',
        model_id: 'gpt-4o-mini'
      });
      expect(parsed.provider).toBe('other');
      expect(parsed.context_window).toBe(0);
      expect(parsed.supports_tools).toBe(false);
      expect(parsed.supports_vision).toBe(false);
      expect(parsed.input_price).toBe(0);
      expect(parsed.output_price).toBe(0);
      expect(parsed.currency).toBe('USD');
      expect(parsed.status).toBe('active');
      expect(parsed.sort_order).toBe(0);
    });

    it('accepts a fully populated payload', () => {
      const parsed = createModelRequestSchema.parse({
        name: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
        model_id: 'claude-3-5-sonnet',
        context_window: 200000,
        supports_tools: true,
        supports_vision: true,
        input_price: 3,
        output_price: 15,
        currency: 'USD',
        status: 'disabled',
        sort_order: 10
      });
      expect(parsed.provider).toBe('anthropic');
      expect(parsed.context_window).toBe(200000);
      expect(parsed.input_price).toBe(3);
      expect(parsed.sort_order).toBe(10);
    });

    it('rejects empty name', () => {
      expect(() => createModelRequestSchema.parse({ name: '', model_id: 'gpt-4o-mini' })).toThrow();
    });

    it('rejects name over 80 chars', () => {
      expect(() => createModelRequestSchema.parse({ name: 'x'.repeat(81), model_id: 'gpt-4o-mini' })).toThrow();
    });

    it('rejects invalid model_id characters', () => {
      expect(() => createModelRequestSchema.parse({ name: 'M', model_id: 'bad id!' })).toThrow();
    });

    it('rejects model_id over 80 chars', () => {
      expect(() => createModelRequestSchema.parse({ name: 'M', model_id: 'a'.repeat(81) })).toThrow();
    });

    it('rejects negative context_window', () => {
      expect(() => createModelRequestSchema.parse({ name: 'M', model_id: 'gpt-4o-mini', context_window: -1 })).toThrow();
    });

    it('rejects negative price', () => {
      expect(() => createModelRequestSchema.parse({ name: 'M', model_id: 'gpt-4o-mini', input_price: -1 })).toThrow();
    });

    it('rejects invalid currency', () => {
      expect(() => createModelRequestSchema.parse({ name: 'M', model_id: 'gpt-4o-mini', currency: 'usd' })).toThrow();
    });

    it('rejects unknown provider', () => {
      expect(() => createModelRequestSchema.parse({ name: 'M', model_id: 'gpt-4o-mini', provider: 'google' })).toThrow();
    });

    it('rejects unknown status', () => {
      expect(() => createModelRequestSchema.parse({ name: 'M', model_id: 'gpt-4o-mini', status: 'archived' })).toThrow();
    });
  });

  describe('updateModelRequestSchema', () => {
    it('accepts a partial update', () => {
      const parsed = updateModelRequestSchema.parse({ name: '新名字' });
      expect(parsed.name).toBe('新名字');
    });

    it('rejects an empty update', () => {
      expect(() => updateModelRequestSchema.parse({})).toThrow();
    });

    it('rejects archived status', () => {
      expect(() => updateModelRequestSchema.parse({ status: 'archived' })).toThrow();
    });

    it('accepts status active/disabled', () => {
      expect(updateModelRequestSchema.parse({ status: 'disabled' }).status).toBe('disabled');
    });
  });

  describe('modelSchema', () => {
    it('parses a full model entity', () => {
      const parsed = modelSchema.parse({
        id: '11111111-1111-4111-8111-111111111111',
        author_id: '22222222-2222-4222-8222-222222222222',
        name: 'GPT-4o mini',
        provider: 'openai',
        model_id: 'gpt-4o-mini',
        context_window: 128000,
        supports_tools: true,
        supports_vision: false,
        input_price: 0.15,
        output_price: 0.6,
        currency: 'USD',
        status: 'active',
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
      });
      expect(parsed.model_id).toBe('gpt-4o-mini');
    });

    it('rejects missing required fields', () => {
      expect(() => modelSchema.parse({ id: 'x' })).toThrow();
    });
  });
});
