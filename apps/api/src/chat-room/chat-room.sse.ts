import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import type { ChatRoomEvent, ChatRoomEventType } from '@storyforge/contracts';
import { ChatRoomEventEntity } from '../database/chat-room-event.entity';
import { ChatRoomEntity } from '../database/chat-room.entity';
import { WorkEntity } from '../database/work.entity';

// ───────────────────────────── 事件总线 ─────────────────────────────

/**
 * 房间事件总线：进程内 EventEmitter，key = `room:${roomId}`。
 * step/continue 写入 chat_room_events 后广播给该房间所有 SSE 订阅者；进程重启后订阅丢失，
 * 由客户端重连 + Last-Event-ID/since 补取（chat_room_events 表）恢复，SSE 只推送不承载状态。
 */
@Injectable()
export class ChatRoomEventBus {
  private readonly emitter = new EventEmitter();

  private key(roomId: string): string {
    return `room:${roomId}`;
  }

  publish(roomId: string, event: ChatRoomEventEntity): void {
    this.emitter.emit(this.key(roomId), event);
  }

  subscribe(roomId: string, listener: (event: ChatRoomEventEntity) => void): void {
    this.emitter.on(this.key(roomId), listener);
  }

  unsubscribe(roomId: string, listener: (event: ChatRoomEventEntity) => void): void {
    this.emitter.off(this.key(roomId), listener);
  }
}

export const CHAT_ROOM_EVENT_BUS = Symbol('CHAT_ROOM_EVENT_BUS');

// ───────────────────────────── SSE 序列化 ─────────────────────────────

/** 实体 → 契约事件视图 */
function toEventView(entity: ChatRoomEventEntity): ChatRoomEvent {
  return {
    id: entity.id,
    room_id: entity.room_id,
    event_seq: entity.event_seq,
    type: entity.type as ChatRoomEvent['type'],
    payload: entity.payload,
    created_at: entity.created_at.toISOString()
  };
}

/** 传输层推送事件（含 snapshot 包装类型） */
interface SsePushEvent extends ChatRoomEvent {
  type: ChatRoomEventType | 'snapshot';
}

/**
 * SSE 帧序列化：`event: <type>\nid: <event_seq>\ndata: <json>\n\n`。
 * id 用于 Last-Event-ID 断线重连补取；对齐旧前端长连接帧语义（event: + data: 帧）。
 */
function serializeEvent(event: SsePushEvent): string {
  return `event: ${event.type}\nid: ${event.event_seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

// ───────────────────────────── SSE 连接处理 ─────────────────────────────

/** 房间推衍事件流（对齐 ai-task.sse.ts 流程：归属校验 → SSE 头 → snapshot → 游标补取 → 实时转发 → 心跳清理） */
@Injectable()
export class ChatRoomSseService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(CHAT_ROOM_EVENT_BUS) private readonly bus: ChatRoomEventBus
  ) {}

  async handleEvents(params: {
    authorId: string;
    workId: string;
    roomId: string;
    request: Request;
    response: Response;
    lastEventId?: string | null;
    since?: number;
  }): Promise<void> {
    const { authorId, workId, roomId, request, response, lastEventId, since } = params;

    // 1. 归属校验（房间 → 作品 → 作者；无权限/不存在 → 404）
    const room = await this.assertOwnedRoom(authorId, workId, roomId);

    // 2. SSE 响应头（no-cache + keep-alive + 关闭代理缓冲）
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    // 3. 先推 snapshot（房间状态基线：状态 / 步骤号 / 分支数）
    response.write(
      serializeEvent({
        id: `snapshot-${room.id}`,
        room_id: room.id,
        event_seq: room.step_index,
        type: 'snapshot',
        payload: {
          status: room.status,
          step_index: room.step_index,
          random_seed: room.random_seed,
          branch_count: room.branch.length
        },
        created_at: room.updated_at.toISOString()
      })
    );

    // 4. 游标补取：仅当客户端显式提供 Last-Event-ID / since 才补取历史
    const headerCursor = Number(lastEventId ?? 0);
    const queryCursor = Number(since ?? 0);
    const hasHeader = lastEventId != null && String(lastEventId).trim() !== '' && Number.isFinite(headerCursor);
    const hasQuery = since != null && Number.isFinite(queryCursor);
    if (hasHeader || hasQuery) {
      const sinceSeq = Math.max(hasHeader ? headerCursor : 0, hasQuery ? queryCursor : 0);
      const missed = await this.dataSource.getRepository(ChatRoomEventEntity).createQueryBuilder('event')
        .where('event.room_id = :roomId', { roomId })
        .andWhere('event.event_seq > :since', { since: sinceSeq })
        .orderBy('event.event_seq', 'ASC')
        .getMany();
      for (const event of missed) response.write(serializeEvent(toEventView(event)));
    }

    // 5. 订阅实时转发
    const listener = (event: ChatRoomEventEntity): void => {
      response.write(serializeEvent(toEventView(event)));
    };
    this.bus.subscribe(room.id, listener);

    // 6. 心跳（15s 注释帧保活）+ 断开清理
    const heartbeat = setInterval(() => {
      response.write(': ping\n\n');
    }, 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      this.bus.unsubscribe(room.id, listener);
    };
    request.on('close', cleanup);
  }

  private async assertOwnedRoom(authorId: string, workId: string, roomId: string): Promise<ChatRoomEntity> {
    const room = await this.dataSource.getRepository(ChatRoomEntity).createQueryBuilder('room')
      .innerJoin(WorkEntity, 'work', 'work.id = room.work_id')
      .where('room.id = :roomId', { roomId })
      .andWhere('room.work_id = :workId', { workId })
      .andWhere('work.author_id = :authorId', { authorId })
      .getOne();
    if (!room) throw new NotFoundException('聊天室不存在');
    return room;
  }
}