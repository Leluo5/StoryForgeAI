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
  Req,
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import { dismissAnchorRequestSchema, dismissAnchorsRequestSchema } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CharacterAnchorService } from './character-anchor.service';
import { CharacterArchiveScanService } from './character-scan.service';

type DismissAnchorRequest = z.infer<typeof dismissAnchorRequestSchema>;
type DismissAnchorsRequest = z.infer<typeof dismissAnchorsRequestSchema>;

/**
 * M3c-2 锚点与扫描接口（T27，4 个端点）。
 * 锚点读取惰性失效；剔除仅对 active 生效，invalid 409。
 */
@Controller()
@UseGuards(SessionGuard)
export class CharacterAnchorController {
  constructor(
    @Inject(CharacterAnchorService) private readonly anchors: CharacterAnchorService,
    @Inject(CharacterArchiveScanService) private readonly scans: CharacterArchiveScanService
  ) {}

  @Get('works/:workId/chapters/:chapterId/role-marks')
  async roleMarks(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string
  ) {
    return ok(request, await this.anchors.readChapterMarks(request.author.id, workId, chapterId));
  }

  @Post('works/:workId/chapters/:chapterId/role-marks/:anchorId/dismiss')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async dismiss(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Param('anchorId') anchorId: string,
    @Body(new ZodValidationPipe(dismissAnchorRequestSchema)) input: DismissAnchorRequest
  ) {
    void input;
    const anchor = await this.anchors.dismissAnchor(request.author.id, workId, anchorId);
    if (anchor.chapter_id !== chapterId) throw new NotFoundException('锚点不存在');
    return ok(request, { anchor_id: anchor.id, dismissed: true });
  }

  @Post('works/:workId/chapters/:chapterId/role-marks/dismiss-batch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async dismissBatch(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('chapterId') chapterId: string,
    @Body(new ZodValidationPipe(dismissAnchorsRequestSchema)) input: DismissAnchorsRequest
  ) {
    return ok(
      request,
      await this.anchors.dismissBatch(request.author.id, workId, chapterId, input.anchor_ids)
    );
  }

  @Post('works/:workId/characters/:characterId/archive-scans')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async rescan(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('characterId') characterId: string
  ) {
    const scan = await this.scans.rescanArchived(request.author.id, workId, characterId);
    return ok(request, {
      scan: {
        id: scan.id,
        character_id: scan.character_id,
        status: scan.status,
        total_chapters: scan.total_chapters,
        scanned_chapters: scan.scanned_chapters,
        matched_paragraphs: scan.matched_paragraphs,
        error: scan.error,
        created_at: scan.created_at.toISOString()
      }
    });
  }
}
