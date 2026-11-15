import { openWritingDB } from './database';

export class WriteLease {
  readonly ttlMs = 15_000;
  readonly heartbeatMs = 5_000;
  private token = 0;
  private held = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly chapterId: string, private readonly ownerId: string) {}
  get currentToken(): number { return this.token; }
  canWrite(): boolean { return this.held; }
  acquire(): Promise<boolean> { return this.claim(false); }

  private arm(onLost: () => void): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.heartbeat().then((alive) => {
        if (!alive && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
          this.held = false;
          onLost();
        }
      });
    }, this.heartbeatMs);
  }

  private async startClaim(takeover: boolean, onLost: () => void): Promise<boolean> {
    const acquired = await this.claim(takeover);
    if (acquired) this.arm(onLost);
    return acquired;
  }

  private async claim(takeover: boolean): Promise<boolean> {
    const db = await openWritingDB();
    const tx = db.transaction('leases', 'readwrite');
    const current = await tx.store.get(this.chapterId);
    const now = Date.now();
    const otherActive = current && current.owner_id !== this.ownerId && current.expires_at > now;
    const otherExpiredNeedsTakeover = current && current.owner_id !== this.ownerId && current.expires_at <= now && !takeover;
    if (otherActive || otherExpiredNeedsTakeover) {
      this.held = false;
      await tx.done;
      return false;
    }
    this.token = current?.owner_id === this.ownerId ? current.fencing_token : (current?.fencing_token ?? 0) + 1;
    await tx.store.put({
      chapter_id: this.chapterId,
      owner_id: this.ownerId,
      fencing_token: this.token,
      expires_at: now + this.ttlMs
    });
    await tx.done;
    this.held = true;
    return true;
  }

  async heartbeat(): Promise<boolean> {
    const db = await openWritingDB();
    const tx = db.transaction('leases', 'readwrite');
    const current = await tx.store.get(this.chapterId);
    if (!current || current.owner_id !== this.ownerId || current.fencing_token !== this.token || current.expires_at <= Date.now()) {
      this.held = false;
      await tx.done;
      return false;
    }
    await tx.store.put({ ...current, expires_at: Date.now() + this.ttlMs });
    await tx.done;
    this.held = true;
    return true;
  }

  start(onLost: () => void): Promise<boolean> {
    return this.startClaim(false, onLost);
  }

  takeover(onLost: () => void = () => undefined): Promise<boolean> {
    return this.startClaim(true, onLost);
  }

  async release(): Promise<void> {
    const db = await openWritingDB();
    const tx = db.transaction('leases', 'readwrite');
    const current = await tx.store.get(this.chapterId);
    if (current?.owner_id === this.ownerId && current.fencing_token === this.token) await tx.store.delete(this.chapterId);
    await tx.done;
    this.held = false;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.token > 0) await this.release();
  }
}
