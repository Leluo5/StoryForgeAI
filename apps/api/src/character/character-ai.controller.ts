import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import {
  confirmCharacterAiItemRequestSchema,
  confirmCharacterAiItemsRequestSchema,
  createCharacterAiDraftRequestSchema,
  discardCharacterAiDraftRequestSchema,
  rejectCharacterAiItemRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { AiTaskService } from '../ai/ai-task.service';
import {
  CharacterAiService,
  mapDraft,
  mapItem,
  type ConfirmItemOptions,
  type StartDraftInput
} from './character-ai.service';

type CreateDraftRequest = z.infer<typeof createCharacterAiDraftRequestSchema>;
type ConfirmItemRequest = z.infer<typeof confirmCharacterAiItemRequestSchema>;
type RejectItemRequest = z.infer<typeof rejectCharacterAiItemRequestSchema>;
type ConfirmBatchRequest = z.infer<typeof confirmCharacterAiItemsRequestSchema>;
type DiscardDraftRequest = z.infer<typeof discardCharacterAiDraftRequestSchema>;

const TOOL_BY_KIND = {
  characters_relations: 'character_extract',
  growth_events: 'character_growth_extract'
} as const;

/**
 * M3c-2 AI 候选接口（T26，7 个端点）。
 * SSE 复用既有 GET /works/:workId/ai-tasks/:taskId/events，不新增通道。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterAiController {
  constructor(
    @Inject(CharacterAiService) private readonly ai: CharacterAiService,
    @Inject(AiTaskService) private readonly tasks: AiTaskService
  ) {}

  @Post('works/:workId/character-ai/drafts')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async createDraft(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createCharacterAiDraftRequestSchema)) input: CreateDraftRequest,
    @Headers('idempotency-key') idempotencyHeader?: string
  ) {
    const idempotencyKey = (idempotencyHeader ?? '').trim() || randomUUID();
    const startInput: StartDraftInput = {
      kind: input.kind,
      input_scope: input.source,
      input_chapter_id: input.source === 'chapter' ? input.chapter_id : null,
      idempotency_key: idempotencyKey
    };
    const draft = await this.ai.startDraft(request.author.id, workId, startInput);

    const inputSummary: Record<string, unknown> = {
      draft_id: draft.id,
      kind: draft.kind
    };
    if (draft.input_chapter_id) inputSummary['chapter_id'] = draft.input_chapter_id;
    if (input.kind === 'growth_events') inputSummary['character_ids'] = input.character_ids;

    const { task } = await this.tasks.createCharacterTask(request.author.id, workId, {
      tool: TOOL_BY_KIND[draft.kind],
      inputSummary,
      idempotencyKey: `character-ai-draft:${draft.id}`
    });
    const linked = draft.task_id ? draft : await this.ai.linkTask(draft.id, task.id, {
      authorId: request.author.id,
      workId
    });
    return ok(request, { draft: mapDraft(linked), task });
  }

  @Get('works/:workId/character-ai/drafts')
  async listDrafts(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string
  ) {
    return ok(
      request,
      await this.ai.listDrafts(request.author.id, workId, {
        ...(limit !== undefined && limit !== '' ? { limit: Number(limit) } : {}),
        ...(cursor !== undefined && cursor !== '' ? { cursor } : {})
      })
    );
  }

  @Get('works/:workId/character-ai/drafts/:draftId')
  async getDraft(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string
  ) {
    const draft = await this.ai.getDraft(request.author.id, workId, draftId);
    const items = await this.ai.listItems(request.author.id, workId, draftId);
    return ok(request, { draft: mapDraft(draft), items: items.map(mapItem) });
  }

  @Post('works/:workId/character-ai/drafts/:draftId/items/:itemId/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async confirmItem(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(confirmCharacterAiItemRequestSchema)) input: ConfirmItemRequest
  ) {
    const item = await this.findItem(request.author.id, workId, draftId, itemId);
    const options: ConfirmItemOptions = {
      ...(input.mode !== undefined ? { resolution: input.mode } : {}),
      ...(input.target_character_id !== undefined
        ? { targetCharacterId: input.target_character_id }
        : {}),
      ...(input.expected_version !== undefined ? { expectedVersion: input.expected_version } : {})
    };
    const confirmed = await this.ai.confirmItem(
      request.author.id,
      workId,
      draftId,
      item.item_index,
      options
    );
    return ok(request, { item: mapItem(confirmed) });
  }

  @Post('works/:workId/character-ai/drafts/:draftId/items/:itemId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async rejectItem(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(rejectCharacterAiItemRequestSchema)) input: RejectItemRequest
  ) {
    void input;
    const item = await this.findItem(request.author.id, workId, draftId, itemId);
    const rejected = await this.ai.rejectItem(
      request.author.id,
      workId,
      draftId,
      item.item_index
    );
    return ok(request, { item: mapItem(rejected) });
  }

  @Post('works/:workId/character-ai/drafts/:draftId/confirm-batch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async confirmBatch(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string,
    @Body(new ZodValidationPipe(confirmCharacterAiItemsRequestSchema)) input: ConfirmBatchRequest
  ) {
    const resolutions = (input.resolutions ?? []).map((resolution) => ({
      item_id: resolution.item_id,
      action: resolution.action,
      ...(resolution.target_character_id !== undefined
        ? { target_character_id: resolution.target_character_id }
        : {})
    }));
    return ok(
      request,
      await this.ai.confirmBatch(request.author.id, workId, draftId, input.item_ids, resolutions)
    );
  }

  @Post('works/:workId/character-ai/drafts/:draftId/discard')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async discard(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string,
    @Body(new ZodValidationPipe(discardCharacterAiDraftRequestSchema)) input: DiscardDraftRequest
  ) {
    void input;
    const draft = await this.ai.discardDraft(request.author.id, workId, draftId);
    return ok(request, { draft: mapDraft(draft) });
  }

  private async findItem(authorId: string, workId: string, draftId: string, itemId: string) {
    await this.ai.getDraft(authorId, workId, draftId);
    const items = await this.ai.listItems(authorId, workId, draftId);
    const item = items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('候选条目不存在');
    return item;
  }
}
