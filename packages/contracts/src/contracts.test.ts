import { describe, expect, it } from 'vitest';
import { apiSuccessSchema, loginRequestSchema } from './index';

describe('shared contracts', () => {
  it('rejects invalid login input', () => {
    expect(loginRequestSchema.safeParse({ email: 'bad', password: '' }).success).toBe(false);
  });

  it('validates a success envelope', () => {
    const schema = apiSuccessSchema(loginRequestSchema);
    expect(schema.parse({ data: { email: 'a@example.com', password: '12345678' }, request_id: crypto.randomUUID() }).data.email).toBe('a@example.com');
  });
});
