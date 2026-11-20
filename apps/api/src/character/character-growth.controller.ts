import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import {
  createCharacterGrowthEventRequestSchema,
  updateCharacterGrowthEventRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CharacterGrowthService } from './character-growth.service';

type CreateGrowthEventRequest = z.infer<typeof createCharacterGrowthEventRequestSchema>;
type UpdateGrowthEventRequest = z.infer<typeof updateCharacterGrowthEventRequestSchema>;

/**
 * M3c-2 成长线接口（T24，4 个端点）。
 * 归档角色写操作由服务层抛 409；节点缺失以 warnings 返回。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterGrowthController {
  constructor(@Inject(CharacterGrowthService) private readonly growth: CharacterGrowthService) {}

  @Get('works/:workId/characters/:characterId/growth-events')
  async list(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string
  ) {
    return ok(request, await this.growth.list(request.author.id, workId, characterId));
  }

  @Post('works/:workId/characters/:characterId/growth-events')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async create(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Body(new ZodValidationPipe(createCharacterGrowthEventRequestSchema)) input: CreateGrowthEventRequest
  ) {
    const result = await this.growth.create(request.author.id, workId, characterId, {
      title: input.title,
      content: input.content,
      ...(input.event_time !== undefined ? { event_time: input.event_time } : {}),
      ...(input.plot_node_id !== undefined ? { plot_node_id: input.plot_node_id } : {}),
      ...(input.chapter_id !== undefined ? { chapter_id: input.chapter_id } : {})
    });
    return ok(request, {
      event: result.event,
      warnings: result.warning ? [result.warning.code] : []
    });
  }

  @Patch('works/:workId/characters/:characterId/growth-events/:eventId')
  @UseGuards(CsrfGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Param('eventId') eventId: string,
    @Body(new ZodValidationPipe(updateCharacterGrowthEventRequestSchema)) input: UpdateGrowthEventRequest
  ) {
    const event = await this.growth.update(request.author.id, workId, eventId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.event_time !== undefined ? { event_time: input.event_time } : {}),
      ...(input.plot_node_id !== undefined ? { plot_node_id: input.plot_node_id } : {}),
      ...(input.chapter_id !== undefined ? { chapter_id: input.chapter_id } : {})
    });
    if (event.character_id !== characterId) throw new NotFoundException('成长事件不存在');
    return ok(request, { event });
  }

  @Delete('works/:workId/characters/:characterId/growth-events/:eventId')
  @UseGuards(CsrfGuard)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Param('eventId') eventId: string
  ) {
    await this.growth.delete(request.author.id, workId, eventId);
    void characterId;
    return ok(request, { deleted: true });
  }
}
