import { openWritingDB } from './database';

export class WriteLease {
  readonly ttlMs = 15_000;
  readonly heartbeatMs = 5_000;
  private token = 0;
  private held = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  // 用 BroadcastChannel 探测租约持有者是否仍存活，让崩溃或刷新后的新页面能立即接管
  private readonly channel: BroadcastChannel | undefined;

  constructor(private readonly chapterId: string, private readonly ownerId: string) {
    this.channel = typeof BroadcastChannel === 'undefined'
      ? undefined
      : new BroadcastChannel(`storyforge-lease:${chapterId}`);
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; probeId?: string } | undefined;
        // 只有仍实际持有租约的页面才回应；崩溃、关闭或冻结的页面不会回应
        if (data?.type === 'probe' && this.held) {
          this.channel?.postMessage({ type: 'alive', probeId: data.probeId });
        }
      };
    }
  }
  get currentToken(): number { return this.token; }
  canWrite(): boolean { return this.held; }
  /** 主动核对租约：供页面重新可见时立即发现 token 已被其他标签接管 */
  verify(): Promise<boolean> { return this.heartbeat(); }
  acquire(): Promise<boolean> { return this.claim(false); }

  private probe(probeOwnerAlive = true): Promise<boolean> {
    // 无法探测时保守视为存活，绝不静默抢占他人租约
    if (!this.channel || probeOwnerAlive === false) return Promise.resolve(true);
    return new Promise((resolve) => {
      const probeId = crypto.randomUUID();
      const listener = (event: MessageEvent) => {
        const data = event.data as { type?: string; probeId?: string } | undefined;
        if (data?.type === 'alive' && data.probeId === probeId) {
          clearTimeout(timeout);
          this.channel?.removeEventListener('message', listener);
          resolve(true);
        }
      };
      const timeout = setTimeout(() => {
        this.channel?.removeEventListener('message', listener);
        resolve(false);
      }, 400);
      this.channel?.addEventListener('message', listener);
      this.channel?.postMessage({ type: 'probe', probeId });
    });
  }

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
    // 先只读取出当前租约，再在事务外探测持有者，避免长耗时探测让 IDB 事务提前提交
    const read = db.transaction('leases', 'readonly');
    const current = await read.store.get(this.chapterId);
    await read.done;
    const now = Date.now();
    if (current && current.owner_id !== this.ownerId) {
      if (current.expires_at > now) {
        // 持有者已崩溃或已刷新页面时立即接管，仍存活则拒绝
        if (await this.probe()) { this.held = false; return false; }
      } else if (!takeover) {
        this.held = false;
        return false;
      }
    }
    const tx = db.transaction('leases', 'readwrite');
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
    this.channel?.close();
    if (this.token > 0) await this.release();
  }
}
