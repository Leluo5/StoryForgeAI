import { describe, expect, it } from 'vitest';
import {
  createWorkflowRequestSchema,
  updateWorkflowRequestSchema,
  workflowPlatformConfigSchema,
  workflowLlmConfigSchema,
  workflowStatusSchema
} from './workflow';

describe('F12 workflow contract', () => {
  describe('workflowStatusSchema', () => {
    it('accepts active / disabled / archived', () => {
      for (const s of ['active', 'disabled', 'archived'] as const) {
        expect(workflowStatusSchema.safeParse(s).success).toBe(true);
      }
    });

    it('rejects unknown status', () => {
      expect(workflowStatusSchema.safeParse('deleted').success).toBe(false);
      expect(workflowStatusSchema.safeParse('').success).toBe(false);
    });
  });

  describe('workflowPlatformConfigSchema', () => {
    it('accepts workflow_id / workspace_id', () => {
      const parsed = workflowPlatformConfigSchema.parse({ workflow_id: 'wf-abc123', workspace_id: 'ws-1' });
      expect(parsed.workflow_id).toBe('wf-abc123');
      expect(parsed.workspace_id).toBe('ws-1');
    });

    it('rejects URL, token, or arbitrary keys (strict, sensitive)', () => {
      expect(workflowPlatformConfigSchema.safeParse({ base_url: 'http://evil' }).success).toBe(false);
      expect(workflowPlatformConfigSchema.safeParse({ api_key: 'sk-secret' }).success).toBe(false);
      expect(workflowPlatformConfigSchema.safeParse({ workflow_id: 'x', base_url: 'http://evil' }).success).toBe(false);
      expect(workflowPlatformConfigSchema.safeParse({ random: 'y' }).success).toBe(false);
    });

    it('rejects non-conforming ids', () => {
      expect(workflowPlatformConfigSchema.safeParse({ workflow_id: 'bad id with space' }).success).toBe(false);
      expect(workflowPlatformConfigSchema.safeParse({ workflow_id: '' }).success).toBe(false);
      expect(workflowPlatformConfigSchema.safeParse({ workflow_id: 'x'.repeat(65) }).success).toBe(false);
    });

    it('defaults to empty object', () => {
      expect(workflowPlatformConfigSchema.parse(undefined)).toEqual({});
    });
  });

  describe('workflowLlmConfigSchema', () => {
    it('accepts model only', () => {
      expect(workflowLlmConfigSchema.safeParse({ model: 'gpt-4o-mini' }).success).toBe(true);
    });

    it('rejects base_url / api_key / arbitrary keys (strict)', () => {
      expect(workflowLlmConfigSchema.safeParse({ model: 'm', base_url: 'http://evil' }).success).toBe(false);
      expect(workflowLlmConfigSchema.safeParse({ model: 'm', api_key: 'sk' }).success).toBe(false);
      expect(workflowLlmConfigSchema.safeParse({ model: 'm', temperature: 0.7 }).success).toBe(false);
      expect(workflowLlmConfigSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('createWorkflowRequestSchema', () => {
    const base = { name: '主线创作流', llm_config: { model: 'gpt-4o-mini' } };

    it('accepts valid create with defaults', () => {
      const parsed = createWorkflowRequestSchema.parse(base);
      expect(parsed.platform).toBe('coze');
      expect(parsed.source).toBe('manual');
      expect(parsed.platform_config).toEqual({});
      expect(parsed.description).toBe('');
    });

    it('accepts platform_config', () => {
      expect(createWorkflowRequestSchema.safeParse({ ...base, platform_config: { workflow_id: 'wf-1' } }).success).toBe(true);
    });

    it('rejects sensitive llm_config / platform_config on create', () => {
      expect(createWorkflowRequestSchema.safeParse({ ...base, llm_config: { model: 'm', api_key: 'sk' } }).success).toBe(false);
      expect(createWorkflowRequestSchema.safeParse({ ...base, platform_config: { api_key: 'sk' } }).success).toBe(false);
    });

    it('rejects empty name', () => {
      expect(createWorkflowRequestSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    });
  });

  describe('updateWorkflowRequestSchema', () => {
    it('accepts partial update', () => {
      expect(updateWorkflowRequestSchema.safeParse({ name: '新名字' }).success).toBe(true);
      expect(updateWorkflowRequestSchema.safeParse({ status: 'disabled' }).success).toBe(true);
      expect(updateWorkflowRequestSchema.safeParse({ llm_config: { model: 'claude-3' } }).success).toBe(true);
    });

    it('rejects empty update (at least one field)', () => {
      expect(updateWorkflowRequestSchema.safeParse({}).success).toBe(false);
    });

    it('rejects status archived via plain update (must use archive endpoint)', () => {
      expect(updateWorkflowRequestSchema.safeParse({ status: 'archived' }).success).toBe(false);
    });

    it('rejects sensitive platform_config on update', () => {
      expect(updateWorkflowRequestSchema.safeParse({ platform_config: { base_url: 'http://evil' } }).success).toBe(false);
    });
  });
});
