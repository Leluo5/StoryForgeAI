import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  chatRoomContinueRequestSchema,
  chatRoomEventQuerySchema,
  chatRoomStepRequestSchema,
  createChatRoomRequestSchema,
  type ChatRoomContinueRequest,
  type ChatRoomEventQuery,
  type ChatRoomStepRequest,
  type CreateChatRoomRequest
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { ChatRoomService } from './chat-room.service';
import { ChatRoomSseService } from './chat-room.sse';

/**
 * F6 聊天室房间模型（M4-T2）HTTP 入口。
 * 7 端点：rooms CRUD（4）+ step（一步一断）+ continue（续跑）+ SSE 事件流。
 * 写操作经 SessionGuard + CsrfGuard；输入经 ZodValidationPipe。
 */
@Controller('works/:workId/chat-rooms')
@UseGuards(SessionGuard)
export class ChatRoomController {
  constructor(
    @Inject(ChatRoomService) private readonly chatRoomService: ChatRoomService,
    @Inject(ChatRoomSseService) private readonly chatRoomSseService: ChatRoomSseService
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async createRoom(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createChatRoomRequestSchema)) dto: CreateChatRoomRequest
  ) {
    const room = await this.chatRoomService.createRoom(request.author.id, workId, dto);
    return ok(request, { room });
  }

  @Get()
  async listRooms(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    const { rooms, total } = await this.chatRoomService.listRooms(request.author.id, workId);
    return ok(request, { rooms, total });
  }

  @Get(':roomId')
  async getRoom(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('roomId') roomId: string
  ) {
    const room = await this.chatRoomService.getRoom(request.author.id, workId, roomId);
    return ok(request, { room });
  }

  @Delete(':roomId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async deleteRoom(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('roomId') roomId: string
  ) {
    await this.chatRoomService.deleteRoom(request.author.id, workId, roomId);
    return ok(request, { id: roomId, deleted: true });
  }

  /** 推衍一步（一步一断：成功后 status=paused，需 continue 续跑） */
  @Post(':roomId/step')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async stepRoom(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('roomId') roomId: string,
    @Body(new ZodValidationPipe(chatRoomStepRequestSchema)) dto: ChatRoomStepRequest
  ) {
    const result = await this.chatRoomService.step(request.author.id, workId, roomId, dto);
    return ok(request, result);
  }

  /** 续跑下一步（仅 paused 房间可续跑） */
  @Post(':roomId/continue')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async continueRoom(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('roomId') roomId: string,
    @Body(new ZodValidationPipe(chatRoomContinueRequestSchema)) dto: ChatRoomContinueRequest
  ) {
    const result = await this.chatRoomService.continueRoom(request.author.id, workId, roomId, dto);
    return ok(request, result);
  }

  /** SSE 事件流：snapshot + Last-Event-ID/since 补取 + 实时转发 + 15s 心跳 */
  @Get(':roomId/events')
  async streamRoomEvents(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('roomId') roomId: string,
    @Query(new ZodValidationPipe(chatRoomEventQuerySchema)) query: ChatRoomEventQuery,
    @Res() response: Response
  ): Promise<void> {
    const lastEventId = (request.headers['last-event-id'] as string | undefined) ?? null;
    await this.chatRoomSseService.handleEvents({
      authorId: request.author.id,
      workId,
      roomId,
      request: request as unknown as Request,
      response,
      lastEventId,
      ...(query.since != null ? { since: query.since } : {})
    });
  }
}