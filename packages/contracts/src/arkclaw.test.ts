import { describe, expect, it } from 'vitest';
import { arkClawChatRequestSchema, arkClawChatResponseSchema } from './arkclaw';

describe('ArkClaw chat contracts', () => {
  it('trims a valid message and enforces the 1–4000 character boundary', () => {
    expect(arkClawChatRequestSchema.parse({ message: '  请介绍自己  ' })).toEqual({ message: '请介绍自己' });
    expect(arkClawChatRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(arkClawChatRequestSchema.safeParse({ message: '问'.repeat(4000) }).success).toBe(true);
    expect(arkClawChatRequestSchema.safeParse({ message: '问'.repeat(4001) }).success).toBe(false);
  });

  it('accepts only a non-blank answer object', () => {
    expect(arkClawChatResponseSchema.parse({ answer: '第一段\n第二段' })).toEqual({ answer: '第一段\n第二段' });
    expect(arkClawChatResponseSchema.safeParse({ answer: '   ' }).success).toBe(false);
    expect(arkClawChatResponseSchema.safeParse({ answer: '有效', extra: true }).success).toBe(false);
  });
});
