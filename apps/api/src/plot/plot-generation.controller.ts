import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  commitPlotGenerationRequestSchema,
  createPlotGenerationRequestSchema,
  updatePlotGenerationDraftRequestSchema
} from '@storyforge/contracts';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PlotGenerationService } from './plot-generation.service';

type CreatePlotGenerationRequest = z.infer<typeof createPlotGenerationRequestSchema>;
type UpdatePlotGenerationDraftRequest = z.infer<typeof updatePlotGenerationDraftRequestSchema>;
type CommitPlotGenerationRequest = z.infer<typeof commitPlotGenerationRequestSchema>;

@Controller('works/:workId/plot-tree/generations')
@UseGuards(SessionGuard)
export class PlotGenerationController {
  constructor(@Inject(PlotGenerationService) private readonly generations: PlotGenerationService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async create(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createPlotGenerationRequestSchema)) input: CreatePlotGenerationRequest
  ) {
    return ok(request, await this.generations.create(request.author.id, workId, input));
  }

  @Patch(':draftId')
  @UseGuards(CsrfGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string,
    @Body(new ZodValidationPipe(updatePlotGenerationDraftRequestSchema)) input: UpdatePlotGenerationDraftRequest
  ) {
    return ok(request, await this.generations.update(request.author.id, workId, draftId, input.payload));
  }

  @Post(':draftId/commit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async commit(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string,
    @Body(new ZodValidationPipe(commitPlotGenerationRequestSchema)) input: CommitPlotGenerationRequest
  ) {
    return ok(request, await this.generations.commit(request.author.id, workId, draftId, input));
  }

  @Post(':draftId/discard')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async discard(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string
  ) {
    return ok(request, await this.generations.discard(request.author.id, workId, draftId));
  }

  @Get(':draftId')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('draftId') draftId: string
  ) {
    return ok(request, await this.generations.get(request.author.id, workId, draftId));
  }
}
