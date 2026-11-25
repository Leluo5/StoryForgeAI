import { describe, expect, it } from 'vitest';
import {
  chatExperienceEventSchema,
  chatExperienceRequestSchema,
  listPublicWorksResponseSchema,
  publicWorkSchema,
  verifyWorkAccessRequestSchema,
  verifyWorkAccessResponseSchema
} from './experience';

const baseWork = {
  id: crypto.randomUUID(),
  name: '星河彼岸',
  description: '',
  icon_url: null,
  coze_bot_id: 'bot-1',
  interaction_type: 'chat',
  system_prompt: null,
  prologue: '你好，我是角色。',
  suggested_questions: ['你是谁？', '介绍一下世界'],
  parameters: [],
  model_name: null,
  response_format: null,
  requires_access_code: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

describe('experience contracts', () => {
  it('parses a public work with defaults', () => {
    const work = publicWorkSchema.parse(baseWork);
    expect(work.name).toBe('星河彼岸');
    expect(work.requires_access_code).toBe(false);
    expect(work.suggested_questions).toHaveLength(2);
  });

  it('lists public works', () => {
    const res = listPublicWorksResponseSchema.parse({ works: [baseWork] });
    expect(res.works).toHaveLength(1);
  });

  it('validates verify access request and response', () => {
    expect(verifyWorkAccessRequestSchema.parse({ access_code: '  abc  ' }).access_code).toBe('abc');
    expect(verifyWorkAccessResponseSchema.parse({ granted: true, token: null }).token).toBeNull();
    expect(verifyWorkAccessResponseSchema.parse({ granted: true, token: 'x.y.z' }).token).toBe('x.y.z');
  });

  it('parses chat request with optional conversation_id', () => {
    const req = chatExperienceRequestSchema.parse({ user_id: 'visitor_1', message: '你好' });
    expect(req.conversation_id).toBeNull();
    const req2 = chatExperienceRequestSchema.parse({ user_id: 'visitor_1', conversation_id: 'c-1', message: '你好' });
    expect(req2.conversation_id).toBe('c-1');
  });

  it('parses SSE events delta/done/error', () => {
    expect(chatExperienceEventSchema.parse({ type: 'delta', content: '你' }).content).toBe('你');
    expect(chatExperienceEventSchema.parse({ type: 'done', conversation_id: 'c-2' }).conversation_id).toBe('c-2');
    expect(chatExperienceEventSchema.parse({ type: 'error', message: '失败' }).message).toBe('失败');
  });
});
