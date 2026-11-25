import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatRoomEntity } from '../database/chat-room.entity';
import { ChatRoomEventEntity } from '../database/chat-room-event.entity';
import { AuthModule } from '../auth/auth.module';
import { ChatRoomController } from './chat-room.controller';
import { ChatRoomService, MockChatRoomLlmProvider, CHAT_ROOM_LLM_PROVIDER } from './chat-room.service';
import { ChatRoomSseService, ChatRoomEventBus, CHAT_ROOM_EVENT_BUS } from './chat-room.sse';

/**
 * F6 聊天室模块（M4-T2）。
 * 房间数据持久化到 PG（chat_rooms / chat_room_events），SSE 复用 ai-task 事件总线模式。
 * 模型 Provider 缺省 Mock（同种子同输入 → 同输出），后续接真实 LLM 仅替换 provider 绑定。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ChatRoomEntity, ChatRoomEventEntity]), AuthModule],
  controllers: [ChatRoomController],
  providers: [
    ChatRoomService,
    ChatRoomSseService,
    { provide: CHAT_ROOM_EVENT_BUS, useClass: ChatRoomEventBus },
    { provide: CHAT_ROOM_LLM_PROVIDER, useClass: MockChatRoomLlmProvider }
  ],
  exports: [ChatRoomService, ChatRoomSseService, CHAT_ROOM_EVENT_BUS]
})
export class ChatRoomModule {}