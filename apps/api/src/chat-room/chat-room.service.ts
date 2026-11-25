import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type {
  ChatRoomContinueInput,
  ChatRoomStepInput,
  ChatRoomSummary,
  CreateChatRoomInput
} from '@storyforge/contracts';
import { ChatRoomEventEntity } from '../database/chat-room-event.entity';
import { ChatRoomEntity } from '../database/chat-room.entity';
import { WorkEntity } from '../database/work.entity';
import { CHAT_ROOM_EVENT_BUS } from './chat-room.sse';

/** 单作品聊天室容量上限（DoD #10 硬约束） */
export const CHAT_ROOM_MAX_PER_WORK = 10;

type CreateRoomDto = CreateChatRoomInput;
type StepDto = ChatRoomStepInput;
type ContinueDto = ChatRoomContinueInput;

/**
 * 房间推衍模型 Provider（M4-T2）。
 * 旧 story_thread.py 走内存态推衍；新架构经 Provider 抽象，Mock 保证确定性（同种子同输入 → 同输出），
 * 真实 LLM 接入不阻塞本里程碑（对齐 ai-model.provider.ts 的 Mock 优先模式）。
 */
export interface ChatRoomModelContext {
  workId: string;
  roomId: string;
  randomSeed: number;
  prompt: string;
  roles: string[];
  /** plot sync-room 联动注入的剧情节点 */
  contextNodeIds: string[];
  history: Record<string, unknown>[];
  stepNo: number;
}

/** 房间推衍输出：本轮文本 + 可选分支记录 */
export interface ChatRoomStepCandidate {
  content: string;
  speaker?: string;
  branch?: Record<string, unknown>;
}

/** 模型调用错误（可重试标记，对齐 AiModelError 语义） */
export class ChatRoomModelError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code: string) {
    super(message);
    this.name = 'ChatRoomModelError';
  }
}

export interface ChatRoomLlmProvider {
  derive(context: ChatRoomModelContext): Promise<ChatRoomStepCandidate>;
}

export const CHAT_ROOM_LLM_PROVIDER = Symbol('CHAT_ROOM_LLM_PROVIDER');

/**
 * Mock 房间推衍 Provider：确定性输出（同种子 + 同输入 → 同内容），供单测与本地开发打通闭环。
 */
@Injectable()
export class MockChatRoomLlmProvider implements ChatRoomLlmProvider {
  async derive(context: ChatRoomModelContext): Promise<ChatRoomStepCandidate> {
    const seedTag = String(context.randomSeed).slice(0, 6);
    const promptTag = context.prompt.slice(0, 24).replace(/\s+/g, ' ');
    return {
      content: `【第 ${context.stepNo} 步 · seed=${seedTag}】${promptTag}`,
      speaker: context.roles[0] ?? 'narrator'
    };
  }
}

/** 事件总线最小结构（SSE 模块提供；解耦 service → sse，避免循环依赖） */
export interface ChatRoomEventBusLike {
  publish(roomId: string, event: ChatRoomEventEntity): void;
}

/** 房间推衍服务：PG 持久化 + 事务行锁 + 一步一断 + 容量上限。 */
@Injectable()
export class ChatRoomService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Optional() @Inject(CHAT_ROOM_LLM_PROVIDER)
    private readonly modelProvider: ChatRoomLlmProvider = new MockChatRoomLlmProvider(),
    @Optional() @Inject(CHAT_ROOM_EVENT_BUS) private readonly eventBus?: ChatRoomEventBusLike
  ) {}

  /** 创建房间：容量校验 + (work_id, room_key) 幂等；缺省种子由幂等键确定性派生 */
  async createRoom(authorId: string, workId: string, dto: CreateRoomDto): Promise<ChatRoomEntity> {
    return this.dataSource.transaction(async (tx) => {
      await this.assertOwnedWork(tx, authorId, workId);

      const repo = tx.getRepository(ChatRoomEntity);
      const existing = await repo.findOneBy({ work_id: workId, room_key: dto.room_key });
      if (existing) return existing;

      const count = await repo.count({ where: { work_id: workId } });
      if (count >= CHAT_ROOM_MAX_PER_WORK) throw new ConflictException('聊天室容量已满');

      const room = repo.create({
        work_id: workId,
        room_key: dto.room_key,
        name: dto.name,
        roles: dto.roles ?? [],
        random_seed: dto.random_seed ?? deriveSeed(workId, dto.room_key),
        step_index: 0,
        branch: [],
        context: {},
        status: 'idle',
        history: []
      });
      try {
        return await repo.save(room);
      } catch (err) {
        // 并发重复创建：唯一约束兜底 → 返回已存在行（幂等）
        if (isUniqueViolation(err)) return existing ?? (await repo.findOneByOrFail({ work_id: workId, room_key: dto.room_key }));
        throw err;
      }
    });
  }

  async listRooms(authorId: string, workId: string): Promise<{ rooms: ChatRoomSummary[]; total: number }> {
    await this.assertOwnedWork(this.dataSource, authorId, workId);
    const entities = await this.dataSource.getRepository(ChatRoomEntity).find({
      where: { work_id: workId },
      order: { created_at: 'DESC', id: 'DESC' }
    });
    // 列表只回摘要（不含 history / context 大字段），减少带宽
    const rooms = entities.map(({ id, work_id, name, step_index, status, created_at, updated_at }) => ({
      id,
      work_id,
      name,
      step_index,
      status,
      created_at: created_at.toISOString(),
      updated_at: updated_at.toISOString()
    }));
    return { rooms, total: rooms.length };
  }

  async getRoom(authorId: string, workId: string, roomId: string): Promise<ChatRoomEntity> {
    return this.loadOwnedRoom(this.dataSource, authorId, workId, roomId);
  }

  async deleteRoom(authorId: string, workId: string, roomId: string): Promise<void> {
    await this.dataSource.transaction(async (tx) => {
      await this.assertOwnedWork(tx, authorId, workId);
      const room = await this.lockRoom(tx, workId, roomId);
      if (!room) throw new NotFoundException('聊天室不存在');
      await tx.getRepository(ChatRoomEventEntity).delete({ room_id: room.id });
      await tx.getRepository(ChatRoomEntity).delete({ id: room.id });
    });
  }

  /** 推衍一步（一步一断）：status idle/running 才可 step，成功后 status=paused */
  async step(
    authorId: string,
    workId: string,
    roomId: string,
    dto: StepDto
  ): Promise<{ room: ChatRoomEntity; event: ChatRoomEventEntity }> {
    return this.advance(authorId, workId, roomId, dto, { from: ['idle', 'running'] });
  }

  /** 续跑下一步：仅 paused 可续跑 */
  async continueRoom(
    authorId: string,
    workId: string,
    roomId: string,
    dto: ContinueDto
  ): Promise<{ room: ChatRoomEntity; event: ChatRoomEventEntity }> {
    return this.advance(authorId, workId, roomId, dto, {
      from: ['paused'],
      idleHint: '房间未暂停，无法续跑'
    });
  }

  /**
   * 推进一步（step / continue 共用）。
   * 三阶段避免长事务持锁：① 短事务行锁读状态 → ② 事务外调模型 → ③ 短事务乐观写回（step_index 未变才写）。
   */
  private async advance(
    authorId: string,
    workId: string,
    roomId: string,
    dto: StepDto,
    opts: { from: string[]; idleHint?: string }
  ): Promise<{ room: ChatRoomEntity; event: ChatRoomEventEntity }> {
    const locked = await this.dataSource.transaction(async (tx) => {
      await this.assertOwnedWork(tx, authorId, workId);
      const room = await this.lockRoom(tx, workId, roomId);
      if (!room) throw new NotFoundException('聊天室不存在');
      if (!opts.from.includes(room.status)) {
        throw new ConflictException(opts.idleHint ?? '房间未暂停，不可推衍');
      }
      return room;
    });
    const expectedStep = locked.step_index;

    // 阶段2：事务外调模型（不持锁，长耗时不阻塞同房间其他操作）
    const candidate = await this.modelProvider.derive({
      workId,
      roomId: locked.id,
      randomSeed: locked.random_seed ?? 0,
      prompt: dto.prompt ?? `第 ${expectedStep + 1} 步推衍`,
      roles: locked.roles,
      contextNodeIds: dto.context_node_ids ?? [],
      history: locked.history,
      stepNo: expectedStep + 1
    });

    // 阶段3：短事务乐观写回
    return this.dataSource.transaction(async (tx) => {
      const fresh = await this.lockRoom(tx, workId, roomId);
      if (!fresh) throw new NotFoundException('聊天室不存在');
      if (fresh.step_index !== expectedStep) throw new ConflictException('房间状态已变化，请重试');

      const stepNo = fresh.step_index + 1;
      fresh.step_index = stepNo;
      fresh.status = 'paused';
      fresh.history = [
        ...fresh.history,
        {
          step_no: stepNo,
          content: candidate.content,
          ...(candidate.speaker ? { speaker: candidate.speaker } : {}),
          ...(dto.prompt ? { prompt: dto.prompt } : {})
        }
      ];
      if (dto.context_node_ids?.length) {
        fresh.context = { ...fresh.context, context_node_ids: dto.context_node_ids };
      }
      if (candidate.branch) fresh.branch = [...fresh.branch, candidate.branch];
      await tx.getRepository(ChatRoomEntity).save(fresh);
      const event = await this.appendEvent(tx, roomId, 'step', {
        step_no: stepNo,
        content: candidate.content,
        status: fresh.status
      });
      return { room: fresh, event };
    });
  }

  /** 房间事件列表（SSE snapshot / 补取共用） */
  async listEvents(authorId: string, workId: string, roomId: string): Promise<ChatRoomEventEntity[]> {
    await this.loadOwnedRoom(this.dataSource, authorId, workId, roomId);
    return this.dataSource.getRepository(ChatRoomEventEntity).find({
      where: { room_id: roomId },
      order: { event_seq: 'ASC' }
    });
  }

  /** 写入一条房间事件：event_seq 在房间行锁内 max+1 推进（同房间串行保证唯一） */
  async appendEvent(
    tx: EntityManager,
    roomId: string,
    type: 'step' | 'status' | 'snapshot',
    payload: Record<string, unknown>
  ): Promise<ChatRoomEventEntity> {
    const repo = tx.getRepository(ChatRoomEventEntity);
    const last = await repo.findOne({ where: { room_id: roomId }, order: { event_seq: 'DESC' } });
    const event = repo.create({
      id: randomUUID(),
      room_id: roomId,
      event_seq: (last?.event_seq ?? -1) + 1,
      type,
      payload
    });
    try {
      const saved = await repo.save(event);
      this.eventBus?.publish(roomId, saved);
      return saved;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('房间事件序列冲突，请重试');
      throw err;
    }
  }

  /** 行锁读房间（同房间串行、跨房间并行） */
  private async lockRoom(tx: EntityManager, workId: string, roomId: string): Promise<ChatRoomEntity | null> {
    return tx
      .getRepository(ChatRoomEntity)
      .createQueryBuilder('room')
      .setLock('pessimistic_write')
      .where('room.id = :roomId', { roomId })
      .andWhere('room.work_id = :workId', { workId })
      .getOne();
  }

  /** 归属 + 房间双重校验（对齐 ai-task assertOwnedTask：先锁房间行再校验作品归属） */
  private async loadOwnedRoom(
    manager: DataSource | EntityManager,
    authorId: string,
    workId: string,
    roomId: string
  ): Promise<ChatRoomEntity> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
    const room = await manager.getRepository(ChatRoomEntity).findOneBy({ id: roomId, work_id: workId });
    if (!room) throw new NotFoundException('聊天室不存在');
    return room;
  }

  private async assertOwnedWork(manager: DataSource | EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }
}

/** 由幂等键确定性派生随机种子（同一 room_key 重试得到同一种子，保证可复现） */
function deriveSeed(workId: string, roomKey: string): number {
  let hash = 0x811c9dc5;
  const text = `${workId}::${roomKey}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // 落到 [0, 2^31-1]（PG integer 有符号上界）
  return (hash >>> 0) % 2147483648;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}