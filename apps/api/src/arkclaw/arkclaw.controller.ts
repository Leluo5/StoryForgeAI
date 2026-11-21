import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { arkClawChatRequestSchema, type ArkClawChatRequest, type ArkClawChatResponse } from '@storyforge/contracts';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest, type SuccessEnvelope } from '../common/http';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ArkClawService } from './arkclaw.service';

@Controller('arkclaw')
@UseGuards(SessionGuard)
export class ArkClawController {
  constructor(@Inject(ArkClawService) private readonly arkClaw: ArkClawService) {}

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async chat(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(arkClawChatRequestSchema)) input: ArkClawChatRequest
  ): Promise<SuccessEnvelope<ArkClawChatResponse>> {
    return ok(request, await this.arkClaw.chat(input.message));
  }
}
