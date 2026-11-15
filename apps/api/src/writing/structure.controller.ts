import type { ChapterInput, VolumeInput } from './structure-input.types';
import { chapterInputSchema, reorderRequestSchema, volumeInputSchema } from '@storyforge/contracts';
import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StructureService } from './structure.service';

@Controller('works/:workId')
@UseGuards(SessionGuard)
export class StructureController {
  constructor(private readonly service: StructureService) {}

  @Get('tree')
  async tree(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.service.tree(request.author.id, workId));
  }

  @Post('volumes')
  @UseGuards(CsrfGuard)
  async createVolume(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Body(new ZodValidationPipe(volumeInputSchema)) input: VolumeInput) {
    return ok(request, await this.service.createVolume(request.author.id, workId, input));
  }

  @Patch('volumes/:volumeId')
  @UseGuards(CsrfGuard)
  async renameVolume(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('volumeId') volumeId: string, @Body(new ZodValidationPipe(volumeInputSchema)) input: VolumeInput) {
    return ok(request, await this.service.renameVolume(request.author.id, workId, volumeId, input));
  }

  @Put('volumes/order')
  @UseGuards(CsrfGuard)
  async reorderVolumes(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Body(new ZodValidationPipe(reorderRequestSchema)) input: { ordered_ids: string[] }) {
    return ok(request, await this.service.reorderVolumes(request.author.id, workId, input.ordered_ids));
  }

  @Post('volumes/:volumeId/chapters')
  @UseGuards(CsrfGuard)
  async createChapter(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('volumeId') volumeId: string, @Body(new ZodValidationPipe(chapterInputSchema)) input: ChapterInput) {
    return ok(request, await this.service.createChapter(request.author.id, workId, volumeId, input));
  }

  @Patch('chapters/:chapterId')
  @UseGuards(CsrfGuard)
  async renameChapter(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('chapterId') chapterId: string, @Body(new ZodValidationPipe(chapterInputSchema)) input: ChapterInput) {
    return ok(request, await this.service.renameChapter(request.author.id, workId, chapterId, input));
  }

  @Put('volumes/:volumeId/chapters/order')
  @UseGuards(CsrfGuard)
  async reorderChapters(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('volumeId') volumeId: string, @Body(new ZodValidationPipe(reorderRequestSchema)) input: { ordered_ids: string[] }) {
    return ok(request, await this.service.reorderChapters(request.author.id, workId, volumeId, input.ordered_ids));
  }

  @Get('chapters/:chapterId')
  async getChapter(@Req() request: AuthenticatedRequest, @Param('workId') workId: string,
    @Param('chapterId') chapterId: string) {
    return ok(request, await this.service.getChapter(request.author.id, workId, chapterId));
  }
}
