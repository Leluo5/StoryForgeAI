import { describe, expect, it } from 'vitest';
import { buildRoleContext, type BuildRoleContextInput } from './collab-context.builder';

function makeInput(overrides: Partial<BuildRoleContextInput> = {}): BuildRoleContextInput {
  return {
    instruction: '补充角色经历',
    character: {
      name: '林默',
      fields: {
        identity: '边城少年',
        personality: '坚韧',
        experience: '经历内容',
        // 禁止泄漏：非白名单字段
        gender: '男',
        occupation: '船夫'
      }
    },
    outputFields: ['identity', 'personality'],
    citations: [
      { source_id: 'doc-1', title: '资料一', snippet: '摘录内容' }
    ],
    ...overrides
  };
}

describe('buildRoleContext (T12)', () => {
  it('只透出白名单字段，禁止其他角色资料泄漏', () => {
    const ctx = buildRoleContext(makeInput());
    expect(Object.keys(ctx.character.fields).sort()).toEqual(['identity', 'personality']);
    expect(ctx.character.fields.identity).toBe('边城少年');
    expect(ctx.character.fields.personality).toBe('坚韧');
    // 明确禁止泄漏的字段不存在
    expect('gender' in ctx.character.fields).toBe(false);
    expect('occupation' in ctx.character.fields).toBe(false);
  });

  it('保留指令与角色名', () => {
    const ctx = buildRoleContext(makeInput());
    expect(ctx.instruction).toBe('补充角色经历');
    expect(ctx.character.name).toBe('林默');
  });

  it('引用仅透出 source_id/title/snippet 三项', () => {
    const ctx = buildRoleContext(makeInput());
    expect(ctx.citations).toEqual([
      { source_id: 'doc-1', title: '资料一', snippet: '摘录内容' }
    ]);
  });

  it('白名单字段在角色资料中缺失时不注入该键', () => {
    const ctx = buildRoleContext(
      makeInput({ outputFields: ['identity', 'personality', 'experience'] })
    );
    expect(Object.keys(ctx.character.fields).sort()).toEqual(['experience', 'identity', 'personality']);
  });

  it('空引用数组安全透传', () => {
    const ctx = buildRoleContext(makeInput({ citations: [] }));
    expect(ctx.citations).toEqual([]);
  });
});
