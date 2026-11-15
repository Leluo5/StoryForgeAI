import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('creates 256-bit tokens and stores only their SHA-256 hash', () => {
    const service = new AuthService({} as never, {} as never, {} as never);
    const raw = service.createRawToken();

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(service.createRawToken()).not.toBe(raw);
    expect(service.hashToken(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(service.hashToken(raw)).not.toBe(raw);
  });

  it('keeps repeated logout calls successful without exposing the raw token', async () => {
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const service = new AuthService({} as never, { update } as never, {} as never);
    const raw = service.createRawToken();

    await expect(service.logout(raw)).resolves.toBeUndefined();
    await expect(service.logout(raw)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(
      { token_hash: service.hashToken(raw) },
      expect.objectContaining({ revoked_at: expect.any(Date) })
    );
  });
});
