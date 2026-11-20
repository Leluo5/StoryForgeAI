import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import {
  addCharacterViewMembersRequestSchema,
  createCharacterViewRequestSchema,
  updateCharacterViewLayoutRequestSchema,
  updateCharacterViewRequestSchema
} from '@storyforge/contracts';
import type { CharacterViewFilters } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import {
  CharacterViewService,
  type LayoutUpsertInput,
  type ViewUpdateInput
} from './character-view.service';

type CreateViewRequest = z.infer<typeof createCharacterViewRequestSchema>;
type UpdateViewRequest = z.infer<typeof updateCharacterViewRequestSchema>;
type AddMembersRequest = z.infer<typeof addCharacterViewMembersRequestSchema>;
type UpdateLayoutRequest = z.infer<typeof updateCharacterViewLayoutRequestSchema>;

/**
 * M3c-2 视图与布局接口（T23，8 个端点）。
 * board 单请求读全；layout 批量幂等。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterViewController {
  constructor(@Inject(CharacterViewService) private readonly views: CharacterViewService) {}

  @Get('works/:workId/character-views')
  async list(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.views.list(request.author.id, workId));
  }

  @Post('works/:workId/character-views')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async create(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createCharacterViewRequestSchema)) input: CreateViewRequest
  ) {
    const view = await this.views.create(request.author.id, workId, {
      name: input.name,
      filters: input.filters
    });
    if (input.members && input.members.length > 0) {
      await this.views.addMember(request.author.id, workId, view.id, input.members);
    }
    return ok(request, view);
  }

  @Patch('works/:workId/character-views/:viewId')
  @UseGuards(CsrfGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('viewId') viewId: string,
    @Body(new ZodValidationPipe(updateCharacterViewRequestSchema)) input: UpdateViewRequest
  ) {
    const payload: ViewUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
      ...(input.expected_version !== undefined ? { version: input.expected_version } : {})
    };
    return ok(request, await this.views.update(request.author.id, workId, viewId, payload));
  }

  @Delete('works/:workId/character-views/:viewId')
  @UseGuards(CsrfGuard)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('viewId') viewId: string
  ) {
    await this.views.delete(request.author.id, workId, viewId);
    return ok(request, { deleted: true });
  }

  @Get('works/:workId/character-views/:viewId/board')
  async board(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('viewId') viewId: string,
    @Query('include_archived') includeArchived?: string
  ) {
    const result = await this.views.getBoard(request.author.id, workId, viewId, {
      include_archived: includeArchived === 'true'
    });
    const memberIds = new Set(result.members.map((m) => m.id));
    const nodes = [...result.nodes].sort(
      (a, b) => a.sort_index - b.sort_index || a.created_at.getTime() - b.created_at.getTime()
    );
    const layout = nodes
      .filter((node) => memberIds.has(node.character_id))
      .map((node) => {
        const position = result.layouts.get(node.character_id);
        return {
          character_id: node.character_id,
          x: position ? position.x : null,
          y: position ? position.y : null,
          arranged: node.arranged && position !== undefined,
          sort_index: node.sort_index
        };
      });

    return ok(request, {
      view: {
        id: result.view.id,
        name: result.view.name,
        filters: result.view.filters as CharacterViewFilters,
        version: result.view.version,
        is_default: result.view.is_default
      },
      characters: result.members.map((character) => ({
        id: character.id,
        name: character.name,
        status: character.status,
        avatar_asset_id: character.avatar_asset_id,
        six_dim: {
          country_region: character.country_region,
          faith: character.faith,
          faction: character.faction,
          race: character.race,
          occupation: character.occupation,
          age_band: character.age_band
        }
      })),
      relations: result.relations.map((relation) => ({
        id: relation.id,
        source_id: relation.source_id,
        target_id: relation.target_id,
        type_id: relation.type_id,
        directed: relation.directed,
        label: relation.label,
        reverse_label: relation.reverse_label,
        color: relation.color,
        line_style: relation.line_style,
        tag: relation.tag
      })),
      relation_types: result.relation_types.map((type) => ({
        id: type.id,
        code: type.code,
        label: type.label,
        group_key: type.group_key
      })),
      layout
    });
  }

  @Post('works/:workId/character-views/:viewId/members')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async addMembers(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('viewId') viewId: string,
    @Body(new ZodValidationPipe(addCharacterViewMembersRequestSchema)) input: AddMembersRequest
  ) {
    const added = await this.views.addMember(request.author.id, workId, viewId, input.character_ids);
    return ok(request, { added });
  }

  @Delete('works/:workId/character-views/:viewId/members/:characterId')
  @UseGuards(CsrfGuard)
  async removeMember(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('viewId') viewId: string,
    @Param('characterId') characterId: string
  ) {
    const removed = await this.views.removeMember(request.author.id, workId, viewId, [characterId]);
    return ok(request, { removed });
  }

  @Put('works/:workId/character-views/:viewId/layout')
  @UseGuards(CsrfGuard)
  async updateLayout(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('viewId') viewId: string,
    @Body(new ZodValidationPipe(updateCharacterViewLayoutRequestSchema)) input: UpdateLayoutRequest
  ) {
    const layouts: LayoutUpsertInput[] = input.positions.map((position) => ({
      character_id: position.character_id,
      x: position.x,
      y: position.y,
      arranged: position.arranged
    }));
    const result = await this.views.upsertLayout(request.author.id, workId, viewId, layouts);
    return ok(request, result);
  }
}
