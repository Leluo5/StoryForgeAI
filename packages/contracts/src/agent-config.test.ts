import { describe, expect, it } from 'vitest';
import {
  agentPlatformSchema,
  agentPlatformConfigSchema,
  createAgentRequestSchema,
  updateAgentRequestSchema,
  createAgentV2RequestSchema,
  updateAgentV2RequestSchema,
  agentV2Schema,
  // M4-T4 新增
  archiveAgentSchema,
  rollbackAgentSchema,
  upsertOverrideSchema,
  deleteOverrideSchema,
  createManualGroupSchema,
  deleteManualGroupSchema,
  setAgentGroupSchema,
  switchToolSchema,
  provisionSchema,
  bindRolesSchema,
  resetRoleDefaultFlowSchema
} from './agent-config';

const PID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

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

// ═══════════════════════════════════════════════════════════════════
// M4-T4 契约测试：Agent 管理 HTTP 入口补齐
// ═══════════════════════════════════════════════════════════════════

describe('M4-T4 agent management request schemas', () => {
  describe('archiveAgentSchema / provisionSchema / bindRolesSchema', () => {
    it('accepts empty body (POST 无请求体)', () => {
      expect(archiveAgentSchema.safeParse({}).success).toBe(true);
      expect(archiveAgentSchema.safeParse(undefined).success).toBe(true);
      expect(provisionSchema.safeParse({}).success).toBe(true);
      expect(bindRolesSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('rollbackAgentSchema', () => {
    it('accepts positive version_no', () => {
      const parsed = rollbackAgentSchema.parse({ version_no: 3 });
      expect(parsed.version_no).toBe(3);
    });
    it('rejects non-positive or non-int version_no', () => {
      expect(rollbackAgentSchema.safeParse({ version_no: 0 }).success).toBe(false);
      expect(rollbackAgentSchema.safeParse({ version_no: -1 }).success).toBe(false);
      expect(rollbackAgentSchema.safeParse({ version_no: 1.5 }).success).toBe(false);
      expect(rollbackAgentSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('upsertOverrideSchema', () => {
    it('accepts project_id + key with optional fields', () => {
      const parsed = upsertOverrideSchema.parse({ project_id: PID, key: 'flow:3', name: '开篇', sort_order: 10, hidden: true });
      expect(parsed.key).toBe('flow:3');
      expect(parsed.name).toBe('开篇');
    });
    it('accepts override key domains (flow:/tool:/role:/project:/manual:)', () => {
      for (const key of ['flow:1', 'tool:大纲', 'role:88888888-8888-4888-8888-888888888888', 'project:11111111-1111-4111-8111-111111111111', 'manual:33333333-3333-4333-8333-333333333333']) {
        expect(upsertOverrideSchema.safeParse({ project_id: PID, key }).success).toBe(true);
      }
    });
    it('rejects missing project_id or key', () => {
      expect(upsertOverrideSchema.safeParse({ key: 'flow:1' }).success).toBe(false);
      expect(upsertOverrideSchema.safeParse({ project_id: PID }).success).toBe(false);
    });
  });

  describe('deleteOverrideSchema / deleteManualGroupSchema', () => {
    it('accepts project_id + key', () => {
      expect(deleteOverrideSchema.safeParse({ project_id: PID, key: 'flow:1' }).success).toBe(true);
    });
    it('rejects missing key', () => {
      expect(deleteOverrideSchema.safeParse({ project_id: PID }).success).toBe(false);
    });
    it('deleteManualGroupSchema requires project_id', () => {
      expect(deleteManualGroupSchema.safeParse({ project_id: PID }).success).toBe(true);
      expect(deleteManualGroupSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('createManualGroupSchema', () => {
    it('accepts name + optional parent_key/sort_order', () => {
      const parsed = createManualGroupSchema.parse({ project_id: PID, name: '我的分组' });
      expect(parsed.name).toBe('我的分组');
      expect(parsed.parent_key).toBe('project:');
      expect(parsed.sort_order).toBe(0);
    });
    it('rejects empty name', () => {
      expect(createManualGroupSchema.safeParse({ project_id: PID, name: '' }).success).toBe(false);
    });
  });

  describe('setAgentGroupSchema', () => {
    it('accepts manual_group_key null (回落) or 纯 uuid（对齐服务层 uuid 列）', () => {
      expect(setAgentGroupSchema.safeParse({ manual_group_key: null }).success).toBe(true);
      expect(setAgentGroupSchema.safeParse({ manual_group_key: '33333333-3333-4333-8333-333333333333' }).success).toBe(true);
    });
    it('rejects 非 uuid 或 manual: 前缀字符串（旧前缀已弃用）', () => {
      expect(setAgentGroupSchema.safeParse({ manual_group_key: 'manual:33333333-3333-4333-8333-333333333333' }).success).toBe(false);
      expect(setAgentGroupSchema.safeParse({ manual_group_key: 'flow:1' }).success).toBe(false);
      expect(setAgentGroupSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('switchToolSchema', () => {
    it('requires non-empty agent_id', () => {
      expect(switchToolSchema.safeParse({ agent_id: AGENT_ID }).success).toBe(true);
      expect(switchToolSchema.safeParse({ agent_id: null }).success).toBe(false);
      expect(switchToolSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('resetRoleDefaultFlowSchema', () => {
    it('defaults mode to fill', () => {
      const parsed = resetRoleDefaultFlowSchema.parse({});
      expect(parsed.mode).toBe('fill');
    });
    it('accepts replace, rejects unknown mode', () => {
      expect(resetRoleDefaultFlowSchema.safeParse({ mode: 'replace' }).success).toBe(true);
      expect(resetRoleDefaultFlowSchema.safeParse({ mode: 'other' }).success).toBe(false);
    });
  });
});
