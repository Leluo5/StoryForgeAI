import { describe, expect, it } from 'vitest';
import { validateGeneratedResult, collabFieldLengthLimits } from './collab-result.validator';

const expected = ['identity', 'personality'] as const;

describe('validateGeneratedResult (T12)', () => {
  it('接受合法 JSON 结果', () => {
    const r = validateGeneratedResult({
      rawText: '{"fields":{"identity":"林默","personality":"坚韧"},"notes":"补充"}',
      expectedFields: [...expected]
    });
    expect(r.fields.identity).toBe('林默');
    expect(r.fields.personality).toBe('坚韧');
    expect(r.notes).toBe('补充');
  });

  it('去除代码围栏后解析', () => {
    const r = validateGeneratedResult({
      rawText: '```json\n{"fields":{"identity":"林默","personality":"坚韧"}}\n```',
      expectedFields: [...expected]
    });
    expect(r.fields.identity).toBe('林默');
  });

  it('拒绝非法 JSON', () => {
    expect(() =>
      validateGeneratedResult({ rawText: 'not-json', expectedFields: [...expected] })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('拒绝缺项（缺少 personality）', () => {
    expect(() =>
      validateGeneratedResult({
        rawText: '{"fields":{"identity":"林默"}}',
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('拒绝多项（多出 experience）', () => {
    expect(() =>
      validateGeneratedResult({
        rawText: '{"fields":{"identity":"林默","personality":"坚韧","experience":"x"}}',
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('拒绝非字符串值', () => {
    expect(() =>
      validateGeneratedResult({
        rawText: '{"fields":{"identity":123,"personality":"坚韧"}}',
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('拒绝空白值', () => {
    expect(() =>
      validateGeneratedResult({
        rawText: '{"fields":{"identity":"   ","personality":"坚韧"}}',
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('拒绝仅标点值', () => {
    expect(() =>
      validateGeneratedResult({
        rawText: '{"fields":{"identity":"。。。","personality":"坚韧"}}',
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('拒绝超长值（identity 超过 80）', () => {
    expect(() =>
      validateGeneratedResult({
        rawText: `{"fields":{"identity":"${'林'.repeat(81)}","personality":"坚韧"}}`,
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('接受恰好等于长度上限的值', () => {
    const r = validateGeneratedResult({
      rawText: `{"fields":{"identity":"${'林'.repeat(collabFieldLengthLimits.identity)}","personality":"坚韧"}}`,
      expectedFields: [...expected]
    });
    expect(r.fields.identity).toHaveLength(collabFieldLengthLimits.identity);
  });

  it('拒绝额外键（notes 之外的顶层键）', () => {
    expect(() =>
      validateGeneratedResult({
        rawText: '{"fields":{"identity":"林默","personality":"坚韧"},"other":"x"}',
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });

  it('notes 超过 2000 字拒绝', () => {
    const longNotes = '字'.repeat(2001);
    expect(() =>
      validateGeneratedResult({
        rawText: `{"fields":{"identity":"林默","personality":"坚韧"},"notes":"${longNotes}"}`,
        expectedFields: [...expected]
      })
    ).toThrowError(expect.objectContaining({ code: 'COLLAB_INVALID_RESULT' }));
  });
});
