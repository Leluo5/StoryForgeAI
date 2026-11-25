import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  ChatExperienceRequest,
  VerifyWorkAccessRequest
} from '@storyforge/contracts';
import {
  chatExperienceRequestSchema,
  verifyWorkAccessRequestSchema
} from '@storyforge/contracts';
import { ok, type RequestWithId } from '../common/http';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ExperienceService } from './experience.service';

/** F3 在线体验控制器：公开无登录。写作向作品库走 /works（SessionGuard），二者分离。 */
@Controller('experience/works')
export class ExperienceController {
  constructor(@Inject(ExperienceService) private readonly service: ExperienceService) {}

  /** 公开作品列表 */
  @Get()
  async list(@Req() request: RequestWithId) {
    return ok(request, await this.service.listPublicWorks());
  }

  /** 公开作品详情（含 Coze 绑定元信息，用于渲染体验聊天） */
  @Get(':workId')
  async detail(@Req() request: RequestWithId, @Param('workId') workId: string) {
    return ok(request, await this.service.getPublicWork(workId));
  }

  /** 访问码验证：无码放行（granted + 无 token）；有码校验，通过颁发签名 token */
  @Post(':workId/verify')
  async verify(
    @Req() request: RequestWithId,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(verifyWorkAccessRequestSchema)) input: VerifyWorkAccessRequest
  ) {
    return ok(request, await this.service.verifyAccess(workId, input));
  }

  /** SSE 流式聊天：header X-Access-Token（设访问码时必带） */
  @Post(':workId/chat')
  async chat(
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(chatExperienceRequestSchema)) input: ChatExperienceRequest,
    @Req() request: { headers: Record<string, string | undefined> },
    @Res() response: Response
  ) {
    const token = request.headers['x-access-token'] ?? null;
    await this.service.chatStream({ workId, input, accessToken: token, response });
  }
}
