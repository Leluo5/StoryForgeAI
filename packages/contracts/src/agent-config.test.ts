import { describe, expect, it } from 'vitest';
import {
  agentPlatformSchema,
  agentPlatformConfigSchema,
  createAgentRequestSchema,
  updateAgentRequestSchema,
  createAgentV2RequestSchema,
  updateAgentV2RequestSchema,
  agentV2Schema
} from './agent-config';

describe('F11 T02 agent platform config', () => {
  describe('agentPlatformSchema', () => {
    it('now accepts flowise', () => {
      expect(agentPlatformSchema.safeParse('flowise').success).toBe(true);
      expect(agentPlatformSchema.safeParse('coze').success).toBe(true);
      expect(agentPlatformSchema.safeParse('mock').success).toBe(true);
    });

    it('still rejects unknown platforms', () => {
      expect(agentPlatformSchema.safeParse('openai').success).toBe(false);
    });
  });

  describe('agentPlatformConfigSchema', () => {
    it('accepts flowise_chatflow_id', () => {
      const parsed = agentPlatformConfigSchema.parse({ flowise_chatflow_id: 'chatflow-abc123' });
      expect(parsed.flowise_chatflow_id).toBe('chatflow-abc123');
    });

    it('rejects URL, token, or arbitrary keys (strict, sensitive)', () => {
      expect(agentPlatformConfigSchema.safeParse({ base_url: 'http://evil' }).success).toBe(false);
      expect(agentPlatformConfigSchema.safeParse({ api_key: 'sk-secret' }).success).toBe(false);
      expect(agentPlatformConfigSchema.safeParse({ flowise_chatflow_id: 'x', base_url: 'http://evil' }).success).toBe(false);
      expect(agentPlatformConfigSchema.safeParse({ random: 'y' }).success).toBe(false);
    });

    it('rejects non-conforming chatflow id', () => {
      expect(agentPlatformConfigSchema.safeParse({ flowise_chatflow_id: 'bad id with space' }).success).toBe(false);
      expect(agentPlatformConfigSchema.safeParse({ flowise_chatflow_id: '' }).success).toBe(false);
      expect(agentPlatformConfigSchema.safeParse({ flowise_chatflow_id: 'x'.repeat(65) }).success).toBe(false);
    });

    it('defaults to empty object', () => {
      expect(agentPlatformConfigSchema.parse(undefined)).toEqual({});
    });
  });

  describe('create/update agent request (V1)', () => {
    const base = { name: '边城 Agent', platform: 'flowise', model_id: 'mock', model_config: { temperature: 0.7 } };

    it('accepts platform_config on create', () => {
      expect(createAgentRequestSchema.safeParse({ ...base, platform_config: { flowise_chatflow_id: 'cf-1' } }).success).toBe(true);
    });

    it('rejects sensitive platform_config on create', () => {
      expect(createAgentRequestSchema.safeParse({ ...base, platform_config: { api_key: 'sk' } }).success).toBe(false);
    });

    it('accepts platform_config on update', () => {
      expect(updateAgentRequestSchema.safeParse({ platform_config: { flowise_chatflow_id: 'cf-2' } }).success).toBe(true);
    });
  });

  describe('create/update agent request (V2)', () => {
    const base = { name: '角色 Agent', platform: 'flowise', model_id: 'mock', kind: 'role_agent', role_id: '44444444-4444-4444-8444-444444444444' };

    it('accepts flowise platform_config on V2 create', () => {
      expect(createAgentV2RequestSchema.safeParse({ ...base, platform_config: { flowise_chatflow_id: 'cf-3' } }).success).toBe(true);
    });

    it('rejects sensitive platform_config on V2 update', () => {
      expect(updateAgentV2RequestSchema.safeParse({ platform_config: { base_url: 'http://evil' } }).success).toBe(false);
    });

    it('agentV2Schema enforces controlled platform_config', () => {
      expect(agentV2Schema.safeParse({ ...base, id: '55555555-5555-4555-8555-555555555555', author_id: '66666666-6666-4666-8666-666666666666', platform: 'flowise', platform_config: { flowise_chatflow_id: 'cf-4' }, status: 'active', is_default: false, created_at: '2026-11-21T00:00:00.000Z', updated_at: '2026-11-21T00:00:00.000Z' }).success).toBe(true);
    });
  });
});
