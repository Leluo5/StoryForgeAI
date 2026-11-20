import {
  Body,
  ConflictException,
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
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import {
  createCharacterRelationRequestSchema,
  createCharacterRelationTypeRequestSchema,
  updateCharacterRelationRequestSchema,
  updateCharacterRelationTypeRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CharacterEntity } from '../database/character.entity';
import {
  CharacterRelationService,
  CharacterRelationTypeService,
  type RelationInput,
  type RelationTypeInput
} from './character-relation.service';

type CreateRelationTypeRequest = z.infer<typeof createCharacterRelationTypeRequestSchema>;
type UpdateRelationTypeRequest = z.infer<typeof updateCharacterRelationTypeRequestSchema>;
type CreateRelationRequest = z.infer<typeof createCharacterRelationRequestSchema>;
type UpdateRelationRequest = z.infer<typeof updateCharacterRelationRequestSchema>;

/**
 * M3c-2 关系类型（4）+ 关系（4）接口（T22）。
 * 错误码沿用服务层 `ConflictException({ code })` 风格。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterRelationController {
  constructor(
    @Inject(CharacterRelationTypeService) private readonly types: CharacterRelationTypeService,
    @Inject(CharacterRelationService) private readonly relations: CharacterRelationService,
    @Inject(DataSource) private readonly dataSource: DataSource
  ) {}

  // ── 关系类型 ──

  @Get('works/:workId/character-relation-types')
  async listTypes(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.types.list(request.author.id, workId));
  }

  @Post('works/:workId/character-relation-types')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createType(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createCharacterRelationTypeRequestSchema)) input: CreateRelationTypeRequest
  ) {
    // 注意：服务层忽略请求 code，自动生成 custom_ 前缀（契约冻结，不在此改写）
    const payload: RelationTypeInput = {
      label: input.label,
      group_key: input.group_key,
      group_label: input.group_label,
      directed: input.directed,
      ...(input.reverse_label !== undefined ? { reverse_label: input.reverse_label } : {}),
      ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {})
    };
    return ok(request, await this.types.create(request.author.id, workId, payload));
  }

  @Patch('works/:workId/character-relation-types/:typeId')
  @UseGuards(CsrfGuard)
  async updateType(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('typeId') typeId: string,
    @Body(new ZodValidationPipe(updateCharacterRelationTypeRequestSchema)) input: UpdateRelationTypeRequest
  ) {
    const payload: Partial<RelationTypeInput> = {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.group_key !== undefined ? { group_key: input.group_key } : {}),
      ...(input.group_label !== undefined ? { group_label: input.group_label } : {}),
      ...(input.directed !== undefined ? { directed: input.directed } : {}),
      ...(input.reverse_label !== undefined ? { reverse_label: input.reverse_label } : {}),
      ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {})
    };
    return ok(request, await this.types.update(request.author.id, workId, typeId, payload));
  }

  @Delete('works/:workId/character-relation-types/:typeId')
  @UseGuards(CsrfGuard)
  async deleteType(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('typeId') typeId: string
  ) {
    await this.types.delete(request.author.id, workId, typeId);
    return ok(request, { deleted: true });
  }

  // ── 关系实例 ──

  @Get('works/:workId/character-relations')
  async listRelations(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Query() query: Record<string, string | undefined>
  ) {
    let items = await this.relations.list(request.author.id, workId);
    if (query.type_id) items = items.filter((r) => r.type_id === query.type_id);
    if (query.character_id) {
      items = items.filter(
        (r) => r.source_id === query.character_id || r.target_id === query.character_id
      );
    }
    if (query.include_archived !== 'true') {
      const characters = await this.dataSource
        .getRepository(CharacterEntity)
        .find({ where: { work_id: workId } });
      const activeIds = new Set(characters.filter((c) => c.status === 'active').map((c) => c.id));
      items = items.filter((r) => activeIds.has(r.source_id) && activeIds.has(r.target_id));
    }
    return ok(request, items);
  }

  @Post('works/:workId/character-relations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createRelation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createCharacterRelationRequestSchema)) input: CreateRelationRequest
  ) {
    const types = await this.types.list(request.author.id, workId);
    const type = types.find((t) => t.id === input.type_id);
    if (!type) throw new NotFoundException('关系类型不存在');

    const label = input.label ?? type.label;
    const payload: RelationInput = {
      source_id: input.source_id,
      target_id: input.target_id,
      type_id: input.type_id,
      label,
      ...(input.reverse_label !== undefined ? { reverse_label: input.reverse_label } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.line_style !== undefined ? { line_style: input.line_style } : {}),
      ...(input.tag !== undefined ? { tag: input.tag } : {})
    };
    const result = await this.relations.create(request.author.id, workId, payload);
    if (!result.created) {
      throw new ConflictException({ code: 'CHARACTER_RELATION_EXISTS', existing_id: result.id });
    }
    return ok(request, { id: result.id, created: true });
  }

  @Patch('works/:workId/character-relations/:relationId')
  @UseGuards(CsrfGuard)
  async updateRelation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('relationId') relationId: string,
    @Body(new ZodValidationPipe(updateCharacterRelationRequestSchema)) input: UpdateRelationRequest
  ) {
    const payload: Partial<RelationInput> = {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.reverse_label !== undefined ? { reverse_label: input.reverse_label } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.line_style !== undefined ? { line_style: input.line_style } : {}),
      ...(input.tag !== undefined ? { tag: input.tag } : {})
    };
    return ok(request, await this.relations.update(request.author.id, workId, relationId, payload));
  }

  @Delete('works/:workId/character-relations/:relationId')
  @UseGuards(CsrfGuard)
  async deleteRelation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('relationId') relationId: string
  ) {
    await this.relations.delete(request.author.id, workId, relationId);
    return ok(request, { deleted: true });
  }
}
