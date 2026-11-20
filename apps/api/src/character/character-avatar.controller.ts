import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { adoptCharacterAvatarRequestSchema } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { AiTaskService } from '../ai/ai-task.service';
import { CharacterAvatarService } from './character-avatar.service';
import { CharacterService } from './character.service';
import type { CharacterAvatarAssetEntity } from '../database/character-avatar-asset.entity';

type AdoptAvatarRequest = z.infer<typeof adoptCharacterAvatarRequestSchema>;

/**
 * M3c-2 头像接口（T25，4 个端点）。
 * 生成走 AI 任务队列（202），读取二进制直出，不提供删除接口。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterAvatarController {
  constructor(
    @Inject(CharacterAvatarService) private readonly avatars: CharacterAvatarService,
    @Inject(CharacterService) private readonly characters: CharacterService,
    @Inject(AiTaskService) private readonly tasks: AiTaskService
  ) {}

  private toAsset(asset: CharacterAvatarAssetEntity) {
    return {
      id: asset.id,
      work_id: asset.work_id,
      character_id: asset.character_id,
      status: asset.status,
      mime: asset.mime,
      byte_size: asset.byte_size,
      width: asset.width,
      height: asset.height,
      content_hash: asset.content_hash,
      content_url: `/api/v1/works/${asset.work_id}/characters/${asset.character_id}/avatar/content?asset_id=${asset.id}`,
      created_at: asset.created_at.toISOString(),
      updated_at: asset.updated_at.toISOString()
    };
  }

  @Post('works/:workId/characters/:characterId/avatar/generations')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async generate(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string
  ) {
    const character = await this.characters.get(request.author.id, workId, characterId);
    const { task } = await this.tasks.createCharacterTask(request.author.id, workId, {
      tool: 'character_avatar_generate',
      inputSummary: { character_id: characterId },
      idempotencyKey: randomUUID()
    });
    return ok(request, { task, character_version: character.version });
  }

  @Get('works/:workId/characters/:characterId/avatar')
  async current(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string
  ) {
    const { active, pending } = await this.avatars.getCurrent(request.author.id, workId, characterId);
    return ok(request, {
      active: active ? this.toAsset(active) : null,
      pending: pending.map((asset) => this.toAsset(asset))
    });
  }

  @Get('works/:workId/characters/:characterId/avatar/content')
  async content(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Query('asset_id') assetId?: string
  ) {
    const { buffer, mime, content_hash } = await this.avatars.getContent(
      request.author.id,
      workId,
      characterId,
      assetId
    );
    const allowed = ['image/svg+xml', 'image/png'] as const;
    if (!allowed.includes(mime)) throw new NotFoundException('头像文件类型不支持');
    response.setHeader('Content-Type', mime);
    response.setHeader('ETag', `"${content_hash}"`);
    response.setHeader('Cache-Control', 'private,max-age=31536000,immutable');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (mime === 'image/svg+xml') {
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    response.setHeader('Content-Length', String(buffer.byteLength));
    response.status(200).send(buffer);
  }

  @Post('works/:workId/characters/:characterId/avatar/adopt')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async adopt(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string,
    @Body(new ZodValidationPipe(adoptCharacterAvatarRequestSchema)) input: AdoptAvatarRequest
  ) {
    const asset = await this.avatars.adopt(request.author.id, workId, input.asset_id);
    if (asset.character_id !== characterId) throw new NotFoundException('头像资产不存在');
    const character = await this.characters.get(request.author.id, workId, characterId);
    return ok(request, { asset: this.toAsset(asset), character_version: character.version });
  }
}
