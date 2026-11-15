import { PasswordService } from './password.service';

describe('PasswordService', () => {
  it('uses Argon2id and never stores plaintext', async () => {
    const service = new PasswordService();
    const password = 'correct horse battery';
    const hash = await service.hash(password);

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(password);
    await expect(service.verify(hash, password)).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong password')).resolves.toBe(false);
    await expect(service.hash(password)).resolves.not.toBe(hash);
  });
});
