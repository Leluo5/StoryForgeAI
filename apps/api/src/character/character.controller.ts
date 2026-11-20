import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import {
  archiveCharacterRequestSchema,
  createCharacterRequestSchema,
  mergeCharacterRequestSchema,
  randomCharacterRequestSchema,
  updateCharacterRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CharacterGrowthEventEntity } from '../database/character-growth-event.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterService, type CreateCharacterInput, type UpdateCharacterInput } from './character.service';

type CreateCharacterRequest = z.infer<typeof createCharacterRequestSchema>;
type UpdateCharacterRequest = z.infer<typeof updateCharacterRequestSchema>;
type ArchiveCharacterRequest = z.infer<typeof archiveCharacterRequestSchema>;
type MergeCharacterRequest = z.infer<typeof mergeCharacterRequestSchema>;
type RandomCharacterRequest = z.infer<typeof randomCharacterRequestSchema>;

const SIX_DIMS = [
  'country_region',
  'faith',
  'faction',
  'race',
  'occupation',
  'age_band'
] as const;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * M3c-2 角色接口（T21，9 个端点）。
 * 注意：`duplicates` / `random` 静态段必须声明在 `:characterId` 之前。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterController {
  constructor(
    @Inject(CharacterService) private readonly characters: CharacterService,
    @Inject(DataSource) private readonly dataSource: DataSource
  ) {}

  // ── 静态段优先 ──

  @Get('works/:workId/characters/duplicates')
  async duplicates(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    const groups = await this.characters.findDuplicates(request.author.id, workId);
    return ok(request, { groups });
  }

  @Post('works/:workId/characters/random')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async random(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(randomCharacterRequestSchema)) input: RandomCharacterRequest
  ) {
    void workId;
    return ok(request, await this.characters.randomDossier(input.seed));
  }

  // ── 集合 ──

  @Get('works/:workId/characters')
  async list(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Query() query: Record<string, string | undefined>
  ) {
    const limit = this.parseLimit(query.limit);
    const offset = this.parseCursor(query.cursor);
    const status = this.parseStatus(query.status);
    const keyword = (query.keyword ?? '').trim().toLowerCase();

    const all = await this.characters.list(request.author.id, workId);
    let items = all;
    if (status) items = items.filter((c) => c.status === status);
    if (keyword) {
      items = items.filter(
        (c) =>
          c.name.toLowerCase().includes(keyword) ||
          c.aliases.some((alias) => alias.toLowerCase().includes(keyword))
      );
    }
    for (const dim of SIX_DIMS) {
      const value = query[dim];
      if (value !== undefined && value !== '') {
        items = items.filter((c) => c[dim] === value);
      }
    }

    const page = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? String(offset + limit) : null;
    return ok(request, { items: page, next_cursor: next });
  }

  @Post('works/:workId/characters')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async create(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createCharacterRequestSchema)) input: CreateCharacterRequest
  ) {
    const payload: CreateCharacterInput = {
      name: input.name,
      aliases: input.aliases,
      personality: input.personality,
      experience: input.experience,
      attributes: input.attributes,
      origin: input.origin,
      ...(input.identity !== undefined ? { identity: input.identity } : {}),
      ...(input.age !== undefined ? { age: input.age } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.country_region !== undefined ? { country_region: input.country_region } : {}),
      ...(input.faith !== undefined ? { faith: input.faith } : {}),
      ...(input.faction !== undefined ? { faction: input.faction } : {}),
      ...(input.race !== undefined ? { race: input.race } : {}),
      ...(input.occupation !== undefined ? { occupation: input.occupation } : {}),
      ...(input.age_band !== undefined ? { age_band: input.age_band } : {}),
      ...(input.expected_version !== undefined ? { expected_version: input.expected_version } : {})
    };
    return ok(request, await this.characters.create(request.author.id, workId, payload));
  }

  // ── 单体 ──

  @Get('works/:workId/characters/:characterId')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string
  ) {
    const character = await this.characters.get(request.author.id, workId, characterId);
    const [relationTotal, growthEventCount] = await Promise.all([
      this.dataSource.getRepository(CharacterRelationEntity).count({
        where: [
          { work_id: workId, source_id: characterId },
          { work_id: workId, target_id: characterId }
        ]
      }),
      this.dataSource
        .getRepository(CharacterGrowthEventEntity)
        .count({ where: { work_id: workId, character_id: characterId } })
    ]);
    return ok(request, {
      character,
      relation_summary: { total: relationTotal },
      growth_event_count: growthEventCount
    });
  }

  @Patch('works/:workId/characters/:characterId')
  @UseGuards(CsrfGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Body(new ZodValidationPipe(updateCharacterRequestSchema)) input: UpdateCharacterRequest
  ) {
    const payload: UpdateCharacterInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.identity !== undefined ? { identity: input.identity } : {}),
      ...(input.age !== undefined ? { age: input.age } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.personality !== undefined ? { personality: input.personality } : {}),
      ...(input.experience !== undefined ? { experience: input.experience } : {}),
      ...(input.country_region !== undefined ? { country_region: input.country_region } : {}),
      ...(input.faith !== undefined ? { faith: input.faith } : {}),
      ...(input.faction !== undefined ? { faction: input.faction } : {}),
      ...(input.race !== undefined ? { race: input.race } : {}),
      ...(input.occupation !== undefined ? { occupation: input.occupation } : {}),
      ...(input.age_band !== undefined ? { age_band: input.age_band } : {}),
      ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
      ...(input.expected_version !== undefined ? { expected_version: input.expected_version } : {})
    };
    return ok(request, await this.characters.update(request.author.id, workId, characterId, payload));
  }

  @Post('works/:workId/characters/:characterId/archive')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async archive(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Body(new ZodValidationPipe(archiveCharacterRequestSchema)) input: ArchiveCharacterRequest
  ) {
    return ok(
      request,
      await this.characters.archive(request.author.id, workId, characterId, input.expected_version)
    );
  }

  @Post('works/:workId/characters/:characterId/restore')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async restore(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string
  ) {
    return ok(request, await this.characters.restore(request.author.id, workId, characterId));
  }

  @Post('works/:workId/characters/:characterId/merge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async merge(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Body(new ZodValidationPipe(mergeCharacterRequestSchema)) input: MergeCharacterRequest
  ) {
    return ok(
      request,
      await this.characters.mergeInto(
        request.author.id,
        workId,
        characterId,
        input.target_character_id,
        input.keep_alias,
        input.expected_version
      )
    );
  }

  // ── 查询参数解析 ──

  private parseLimit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return DEFAULT_LIMIT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw new UnprocessableEntityException({ message: 'limit 必须为 1~500 的整数' });
    }
    return value;
  }

  private parseCursor(raw: string | undefined): number {
    if (raw === undefined || raw === '') return 0;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new UnprocessableEntityException({ message: 'cursor 非法' });
    }
    return value;
  }

  private parseStatus(raw: string | undefined): 'active' | 'archived' | undefined {
    if (raw === undefined || raw === '') return undefined;
    if (raw !== 'active' && raw !== 'archived') {
      throw new UnprocessableEntityException({ message: 'status 仅支持 active/archived' });
    }
    return raw;
  }
}
