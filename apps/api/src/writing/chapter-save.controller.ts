import { saveChangeRequestSchema, type SaveChangeRequest } from '@storyforge/contracts';
import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ChapterSaveService } from './chapter-save.service';

@Controller('works/:workId/chapters/:chapterId')
@UseGuards(SessionGuard)
export class ChapterSaveController {
  constructor(@Inject(ChapterSaveService) private readonly service: ChapterSaveService) {}

  @Post('changes')
  // 幂等保存返回当前版本状态而非新建资源，固定 200
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async save(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Body(new ZodValidationPipe(saveChangeRequestSchema)) input: SaveChangeRequest
  ) {
    return ok(request, await this.service.save(request.author.id, workId, chapterId, input));
  }
}
