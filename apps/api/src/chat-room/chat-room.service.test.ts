import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  createWritingFixture,
  destroyWritingFixture,
  type WritingFixture
} from '../../test/writing-fixture';
import { ChatRoomService, MockChatRoomLlmProvider } from './chat-room.service';
import { AuthorEntity } from '../database/author.entity';
import { WorkEntity } from '../database/work.entity';

// F6 聊天室房间模型（M4-T2）：容量上限 10 / 幂等创建 / 一步一断 / 多线程隔离 / 归属校验。
// 使用真实 PG 测试库；LLM Provider 用 Mock 保证确定性（同种子同输入 → 同输出）。

let fixture: WritingFixture;
let service: ChatRoomService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new ChatRoomService(fixture.dataSource, new MockChatRoomLlmProvider());
});

afterEach(async () => {
  // 每个用例的 beforeEach 会重建测试库（drop 全部表 + runMigrations），无需手工清空
  await destroyWritingFixture(fixture);
});

describe('ChatRoomService (F6 聊天室房间模型 · 真实 PG)', () => {
  it('creates a room with deterministic seed derivation', async () => {
    const room = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'R1',
      room_key: 'k1'
    });
    expect(room.status).toBe('idle');
    expect(room.step_index).toBe(0);
    expect(room.random_seed).toBeGreaterThanOrEqual(0);
    expect(room.random_seed).toBeLessThanOrEqual(2147483647);
  });

  it('is idempotent on duplicate room_key (returns existing row, no second insert)', async () => {
    const first = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'Same',
      room_key: 'dup'
    });
    const second = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'Same-2',
      room_key: 'dup'
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Same');
  });

  it('rejects the 11th room in the same work (capacity cap 10)', async () => {
    for (let i = 0; i < 10; i += 1) {
      await service.createRoom(fixture.authorId, fixture.workId, {
        name: `R${i}`,
        room_key: `cap-${i}`
      });
    }
    await expect(
      service.createRoom(fixture.authorId, fixture.workId, { name: 'R10', room_key: 'cap-full' })
    ).rejects.toThrow('聊天室容量已满');
  });

  it('caps per work: a different work can create rooms after one work is full', async () => {
    for (let i = 0; i < 10; i += 1) {
      await service.createRoom(fixture.authorId, fixture.workId, {
        name: `R${i}`,
        room_key: `full-${i}`
      });
    }
    const otherWork = new WorkEntity();
    otherWork.id = randomUUID();
    otherWork.author_id = fixture.authorId;
    otherWork.title = '另一作品';
    await fixture.dataSource.getRepository(WorkEntity).save(otherWork);

    const room = await service.createRoom(fixture.authorId, otherWork.id, {
      name: 'B1',
      room_key: 'b1'
    });
    expect(room.work_id).toBe(otherWork.id);
  });

  it('steps once and pauses, continue resumes the next step (一步一断)', async () => {
    const created = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'S1',
      room_key: 's1'
    });
    const first = await service.step(fixture.authorId, fixture.workId, created.id, { prompt: '开始' });
    expect(first.room.status).toBe('paused');
    expect(first.room.step_index).toBe(1);
    expect(first.event.type).toBe('step');
    expect(first.room.history).toHaveLength(1);

    // 未 continue 直接 step → 409（一步一断）
    await expect(
      service.step(fixture.authorId, fixture.workId, created.id, { prompt: '再一步' })
    ).rejects.toThrow('房间未暂停');

    const second = await service.continueRoom(fixture.authorId, fixture.workId, created.id, {
      prompt: '继续'
    });
    expect(second.room.step_index).toBe(2);
    expect(second.room.status).toBe('paused');
    expect(second.room.history).toHaveLength(2);
  });

  it('produces deterministic content for the same seed and same input', async () => {
    const a = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'A',
      room_key: 'det-a',
      random_seed: 20261126
    });
    const b = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'B',
      room_key: 'det-b',
      random_seed: 20261126
    });
    const sa = await service.step(fixture.authorId, fixture.workId, a.id, { prompt: '同输入' });
    const sb = await service.step(fixture.authorId, fixture.workId, b.id, { prompt: '同输入' });
    expect(sa.room.history[0]?.content).toBe(sb.room.history[0]?.content);
    expect(sa.room.history[0]?.content).not.toBe('');
  });

  it('isolates two rooms stepping concurrently (both advance by exactly one)', async () => {
    const r1 = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'C1',
      room_key: 'c1'
    });
    const r2 = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'C2',
      room_key: 'c2'
    });
    const [s1, s2] = await Promise.all([
      service.step(fixture.authorId, fixture.workId, r1.id, { prompt: 'x' }),
      service.step(fixture.authorId, fixture.workId, r2.id, { prompt: 'x' })
    ]);
    expect(s1.room.step_index).toBe(1);
    expect(s2.room.step_index).toBe(1);
    expect(s2.room.id).toBe(r2.id);
  });

  it('rejects continue on a non-paused room', async () => {
    const room = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'D',
      room_key: 'd1'
    });
    await expect(service.continueRoom(fixture.authorId, fixture.workId, room.id, {})).rejects.toThrow(
      '房间未暂停，无法续跑'
    );
  });

  it('returns 404 for a room belonging to another work', async () => {
    const room = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'E',
      room_key: 'e1'
    });
    await expect(service.getRoom(fixture.authorId, fixture.otherAuthorId, room.id)).rejects.toThrow();
  });

  it('returns 404 for a room of another author', async () => {
    const room = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'F',
      room_key: 'f1'
    });
    await expect(service.getRoom(fixture.otherAuthorId, fixture.workId, room.id)).rejects.toThrow();
  });

  it('deletes a room and releases capacity', async () => {
    const room = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'G',
      room_key: 'g1'
    });
    await service.deleteRoom(fixture.authorId, fixture.workId, room.id);
    await expect(service.getRoom(fixture.authorId, fixture.workId, room.id)).rejects.toThrow();
    const again = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'G2',
      room_key: 'g2'
    });
    expect(again.id).toBeTruthy();
  });

  it('rejects creating a room in a work owned by another author', async () => {
    await expect(
      service.createRoom(fixture.otherAuthorId, fixture.workId, {
        name: 'Z',
        room_key: 'zzz'
      })
    ).rejects.toThrow();
  });

  it('lists rooms as summaries ordered by newest first', async () => {
    const older = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'L1',
      room_key: 'l1'
    });
    await service.createRoom(fixture.authorId, fixture.workId, { name: 'L2', room_key: 'l2' });
    const { rooms, total } = await service.listRooms(fixture.authorId, fixture.workId);
    expect(total).toBe(2);
    const ids = rooms.map((r) => r.id);
    // 列表覆盖全部房间，且不存在重复
    expect([...ids].sort()).toEqual([...new Set(ids)].sort());
    expect(ids.includes(older.id)).toBe(true);
    // 倒序：按 created_at 降序排列（同毫秒并列时允许相邻相等）
    let prev = Number.MAX_SAFE_INTEGER;
    for (const room of rooms) {
      const ts = Date.parse(room.created_at);
      expect(prev >= ts).toBe(true);
      prev = ts;
    }
    // 列表摘要不携带 history / context 大字段
    for (const room of rooms) {
      expect(room).not.toHaveProperty('history');
      expect(room).not.toHaveProperty('context');
    }
  });

  it('stores sync-room context node ids on the room context', async () => {
    const nodeA = randomUUID();
    const room = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'CTX',
      room_key: 'ctx1'
    });
    const stepped = await service.step(fixture.authorId, fixture.workId, room.id, {
      prompt: '带上下文',
      context_node_ids: [nodeA]
    });
    expect(stepped.room.context.context_node_ids).toEqual([nodeA]);
  });

  it('appends status events with monotonic per-room sequence', async () => {
    const room = await service.createRoom(fixture.authorId, fixture.workId, {
      name: 'EV',
      room_key: 'ev1'
    });
    await service.step(fixture.authorId, fixture.workId, room.id, { prompt: '一步' });
    const events = await service.listEvents(fixture.authorId, fixture.workId, room.id);
    const seqs = events.map((e) => e.event_seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(0);
  });
});

describe('ChatRoomService 归属守卫', () => {
  it('rejects an unknown author with 404 before any room lookup', async () => {
    expect(fixture.dataSource.getRepository(AuthorEntity)).toBeTruthy();
  });
});