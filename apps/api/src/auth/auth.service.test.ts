import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

function createService(overrides: {
  findOne?: ReturnType<typeof vi.fn>;
  save?: ReturnType<typeof vi.fn>;
  sessionSave?: ReturnType<typeof vi.fn>;
  notificationSave?: ReturnType<typeof vi.fn>;
}): AuthService {
  const authors = { findOne: overrides.findOne ?? vi.fn(), save: overrides.save ?? vi.fn(), create: vi.fn((v: unknown) => v) };
  const sessions = { save: overrides.sessionSave ?? vi.fn(), create: vi.fn((v: unknown) => v) };
  const notifications = { save: overrides.notificationSave ?? vi.fn(), create: vi.fn((v: unknown) => v) };
  const passwords = { hash: vi.fn(async () => `hashed:${Date.now()}`), verify: vi.fn(async () => false) };
  return new AuthService(authors as never, sessions as never, passwords as never, notifications as never);
}

describe('AuthService', () => {
  it('creates 256-bit tokens and stores only their SHA-256 hash', () => {
    const service = new AuthService({} as never, {} as never, {} as never, {} as never);
    const raw = service.createRawToken();

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(service.createRawToken()).not.toBe(raw);
    expect(service.hashToken(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(service.hashToken(raw)).not.toBe(raw);
  });

  it('keeps repeated logout calls successful without exposing the raw token', async () => {
    const update = vi.fn().mockResolvedValue({ affected: 1 });
    const service = new AuthService({} as never, { update } as never, {} as never, {} as never);
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

describe('AuthService.loginOrRegister', () => {
  const author = { id: 'a1', email: 'new@example.com', display_name: 'new' };

  it('auto-registers an unknown account, records a notice and returns created=true', async () => {
    const service = createService({
      findOne: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(author),
      sessionSave: vi.fn().mockResolvedValue({}),
      notificationSave: vi.fn().mockResolvedValue({})
    });

    const result = await service.loginOrRegister('New@Example.com', 'password123');

    expect(result.created).toBe(true);
    expect(result.author.id).toBe('a1');
    // 通知留存：写入了一条包含账号信息的通知
    const notifRepo = service['notifications'] as unknown as { save: ReturnType<typeof vi.fn> };
    expect(notifRepo.save).toHaveBeenCalledTimes(1);
    const notice = notifRepo.save.mock.calls[0]?.[0] as { content: string };
    expect(notice.content).toContain('new@example.com');
    // 会话已创建
    const sessionRepo = service['sessions'] as unknown as { save: ReturnType<typeof vi.fn> };
    expect(sessionRepo.save).toHaveBeenCalledTimes(1);
  });

  it('keeps normal login for an already registered account', async () => {
    const service = createService({
      findOne: vi.fn().mockResolvedValue(author),
      sessionSave: vi.fn().mockResolvedValue({}),
      notificationSave: vi.fn()
    });
    service['passwords'].verify = vi.fn(async () => true);

    const result = await service.loginOrRegister('new@example.com', 'password123');

    expect(result.created).toBe(false);
    expect((service['authors'] as unknown as { save: ReturnType<typeof vi.fn> }).save).not.toHaveBeenCalled();
    expect((service['notifications'] as unknown as { save: ReturnType<typeof vi.fn> }).save).not.toHaveBeenCalled();
  });

  it('throws Unauthorized for a registered account with a wrong password', async () => {
    const service = createService({
      findOne: vi.fn().mockResolvedValue(author),
      sessionSave: vi.fn(),
      notificationSave: vi.fn()
    });
    service['passwords'].verify = vi.fn(async () => false);

    await expect(service.loginOrRegister('new@example.com', 'wrongpass')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('falls back to login on concurrent unique-violation instead of duplicating the account', async () => {
    const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
    const service = createService({
      findOne: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(conflict),
      sessionSave: vi.fn().mockResolvedValue({}),
      notificationSave: vi.fn()
    });
    // 冲突回退后，login 再查一次应命中已存在的作者，且密码通过
    service['passwords'].verify = vi.fn(async () => true);
    const authorRepo = service['authors'] as unknown as { findOne: ReturnType<typeof vi.fn> };
    authorRepo.findOne
      .mockResolvedValueOnce(null) // 首次未找到 → 尝试创建
      .mockResolvedValueOnce(author); // 冲突后回退 login 再查 → 命中

    const result = await service.loginOrRegister('new@example.com', 'password123');

    expect(result.created).toBe(false);
    expect((service['authors'] as unknown as { save: ReturnType<typeof vi.fn> }).save).toHaveBeenCalledTimes(1);
    expect((service['notifications'] as unknown as { save: ReturnType<typeof vi.fn> }).save).not.toHaveBeenCalled();
  });

  it('rethrows non-unique errors instead of masking data inconsistencies', async () => {
    const service = createService({
      findOne: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(new Error('connection lost')),
      sessionSave: vi.fn(),
      notificationSave: vi.fn()
    });

    await expect(service.loginOrRegister('new@example.com', 'password123')).rejects.toThrow('connection lost');
  });
});
