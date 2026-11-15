import type { CreateWorkRequest, UpdateWorkRequest } from '@storyforge/contracts';
import { createWorkRequestSchema, updateWorkRequestSchema } from '@storyforge/contracts';
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { WorkService } from './work.service';

@Controller('works')
@UseGuards(SessionGuard)
export class WorkController {
  constructor(private readonly service: WorkService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query('q') query = '') {
    return ok(request, await this.service.list(request.author.id, query));
  }

  @Post()
  @UseGuards(CsrfGuard)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createWorkRequestSchema)) input: CreateWorkRequest
  ) {
    return ok(request, await this.service.create(request.author.id, input));
  }

  @Patch(':workId')
  @UseGuards(CsrfGuard)
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(updateWorkRequestSchema)) input: UpdateWorkRequest
  ) {
    return ok(request, await this.service.update(request.author.id, workId, input));
  }
}
