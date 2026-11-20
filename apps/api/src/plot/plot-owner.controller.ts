import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Put,
  Req,
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import { setPlotNodeOwnersRequestSchema } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { PlotOwnerService } from './plot-owner.service';

type SetOwnersRequest = z.infer<typeof setPlotNodeOwnersRequestSchema>;

/**
 * M3c-2 剧情节点归属接口（T29，2 个端点）。
 * 写入为 A6/Q4 差异更新：只影响 active 归属，归档行保留。
 */
@Controller()
@UseGuards(SessionGuard)
export class PlotOwnerController {
  constructor(@Inject(PlotOwnerService) private readonly owners: PlotOwnerService) {}

  @Put('works/:workId/plot-tree/nodes/:nodeId/owners')
  @UseGuards(CsrfGuard)
  async setOwners(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(setPlotNodeOwnersRequestSchema)) input: SetOwnersRequest
  ) {
    const result = await this.owners.set(request.author.id, workId, nodeId, input.owners);
    return ok(request, { node_id: result.node_id, owners: result.owners });
  }

  @Delete('works/:workId/plot-tree/nodes/:nodeId/owners/:characterId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async removeOwner(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('nodeId') nodeId: string,
    @Param('characterId') characterId: string
  ) {
    const result = await this.owners.remove(request.author.id, workId, nodeId, characterId);
    return ok(request, { node_id: result.node_id, removed: result.removed });
  }
}
