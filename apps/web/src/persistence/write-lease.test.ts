import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteLease } from './write-lease';

const leases: WriteLease[] = [];
afterEach(async () => {
  await Promise.all(leases.map((lease) => lease.stop()));
  leases.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('WriteLease', () => {
  it('allows one writer and permits explicit takeover only after expiry', async () => {
    vi.useFakeTimers();
    const chapterId = crypto.randomUUID();
    const first = new WriteLease(chapterId, crypto.randomUUID());
    const second = new WriteLease(chapterId, crypto.randomUUID());
    leases.push(first, second);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(await second.takeover()).toBe(false);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await second.takeover()).toBe(true);
    expect(second.currentToken).toBeGreaterThan(first.currentToken);
    expect(await first.heartbeat()).toBe(false);
    expect(first.canWrite()).toBe(false);
  });

  it('heartbeats every five seconds and prevents expiry takeover while alive', async () => {
    vi.useFakeTimers();
    const chapterId = crypto.randomUUID();
    const first = new WriteLease(chapterId, crypto.randomUUID());
    const second = new WriteLease(chapterId, crypto.randomUUID());
    leases.push(first, second);
    expect(await first.start(vi.fn())).toBe(true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(first.canWrite()).toBe(true);
    expect(await second.takeover()).toBe(false);
    await first.stop();
    expect(await second.acquire()).toBe(true);
    await second.release();
    expect(second.canWrite()).toBe(false);
  });

  it('stops heartbeats and reports loss immediately', async () => {
    vi.useFakeTimers();
    const first = new WriteLease(crypto.randomUUID(), crypto.randomUUID());
    leases.push(first);
    const lost = vi.fn();
    expect(await first.start(lost)).toBe(true);
    vi.spyOn(first, 'heartbeat').mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(first.canWrite()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
