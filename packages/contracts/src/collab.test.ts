import { describe, expect, it } from 'vitest';
import {
  collabRoleFieldLimitsSchema,
  collabSettingsSchema,
  createRoleProfileTaskRequestSchema,
  putCollabSettingsRequestSchema,
  collabGenerateResultSchema,
  collabChannelSchema,
  collabErrorCodeSchema
} from './collab';

describe('F11 collab contracts', () => {
  describe('role field limits', () => {
    it('aligns with character.entity column constraints', () => {
      const limits = collabRoleFieldLimitsSchema.parse({ identity: 80, personality: 2000, experience: 20000 });
      expect(limits.identity).toBe(80);
      expect(limits.personality).toBe(2000);
      expect(limits.experience).toBe(20000);
    });
  });

  describe('collab settings', () => {
    const base = {
      work_id: '11111111-1111-4111-8111-111111111111',
      test_character_id: '22222222-2222-4222-8222-222222222222',
      agent_id: '33333333-3333-4333-8333-333333333333',
      whitelist_fields: ['identity', 'personality'],
      enabled: true,
      created_at: '2026-11-21T00:00:00.000Z',
      updated_at: '2026-11-21T00:00:00.000Z'
    };

    it('accepts 2-3 whitelist fields', () => {
      expect(collabSettingsSchema.safeParse({ ...base, whitelist_fields: ['identity', 'personality', 'experience'] }).success).toBe(true);
      expect(collabSettingsSchema.safeParse({ ...base, whitelist_fields: ['identity', 'personality'] }).success).toBe(true);
    });

    it('rejects 1 or 4 whitelist fields', () => {
      expect(collabSettingsSchema.safeParse({ ...base, whitelist_fields: ['identity'] }).success).toBe(false);
      expect(collabSettingsSchema.safeParse({ ...base, whitelist_fields: ['identity', 'personality', 'experience', 'identity'] }).success).toBe(false);
    });

    it('rejects unknown whitelist field', () => {
      expect(collabSettingsSchema.safeParse({ ...base, whitelist_fields: ['identity', 'name'] }).success).toBe(false);
    });

    it('defaults enabled to false', () => {
      const parsed = collabSettingsSchema.parse({ ...base, enabled: undefined } as never);
      expect(parsed.enabled).toBe(false);
    });

    it('enforces same 2-3 rule on PUT request', () => {
      expect(putCollabSettingsRequestSchema.safeParse({ ...base, work_id: undefined, created_at: undefined, updated_at: undefined, whitelist_fields: ['identity'] }).success).toBe(false);
      expect(putCollabSettingsRequestSchema.safeParse({ ...base, work_id: undefined, created_at: undefined, updated_at: undefined }).success).toBe(true);
    });
  });

  describe('create role-profile task', () => {
    const base = {
      character_id: '22222222-2222-4222-8222-222222222222',
      fields: ['identity', 'personality'],
      instruction: '补充角色在边城的生活经历'
    };

    it('accepts valid request', () => {
      expect(createRoleProfileTaskRequestSchema.safeParse(base).success).toBe(true);
    });

    it('rejects fewer than 2 fields', () => {
      expect(createRoleProfileTaskRequestSchema.safeParse({ ...base, fields: ['identity'] }).success).toBe(false);
    });

    it('rejects empty or oversized instruction', () => {
      expect(createRoleProfileTaskRequestSchema.safeParse({ ...base, instruction: '' }).success).toBe(false);
      expect(createRoleProfileTaskRequestSchema.safeParse({ ...base, instruction: 'x'.repeat(501) }).success).toBe(false);
    });
  });

  describe('generate result', () => {
    it('accepts fields object with notes', () => {
      const parsed = collabGenerateResultSchema.parse({ fields: { identity: '边城少年', personality: '沉静' }, notes: '基于边城生活' });
      expect(parsed.fields.identity).toBe('边城少年');
      expect(parsed.notes).toBe('基于边城生活');
    });

    it('defaults notes to empty string', () => {
      const parsed = collabGenerateResultSchema.parse({ fields: { identity: '边城少年', personality: '沉静' } });
      expect(parsed.notes).toBe('');
    });

    it('rejects unknown top-level keys (strict)', () => {
      expect(collabGenerateResultSchema.safeParse({ fields: {}, extra: 'x' }).success).toBe(false);
    });

    it('rejects non-string field values', () => {
      expect(collabGenerateResultSchema.safeParse({ fields: { identity: 123 } }).success).toBe(false);
    });
  });

  describe('channel and error codes', () => {
    it('accepts flowise and coze only', () => {
      expect(collabChannelSchema.safeParse('flowise').success).toBe(true);
      expect(collabChannelSchema.safeParse('coze').success).toBe(true);
      expect(collabChannelSchema.safeParse('mock').success).toBe(false);
    });

    it('defines all documented error codes', () => {
      const codes = [
        'COLLAB_DISABLED',
        'COLLAB_TEST_ROLE_MISMATCH',
        'COLLAB_FIELD_NOT_ALLOWED',
        'COLLAB_CHANNEL_NOT_CONFIGURED',
        'COLLAB_NO_CITATION',
        'COLLAB_UPSTREAM_TIMEOUT',
        'COLLAB_UPSTREAM_FAILED',
        'COLLAB_INVALID_RESULT',
        'COLLAB_FIELD_CONFLICT'
      ];
      for (const c of codes) expect(collabErrorCodeSchema.safeParse(c).success).toBe(true);
      expect(collabErrorCodeSchema.safeParse('COLLAB_UNKNOWN').success).toBe(false);
    });
  });
});
