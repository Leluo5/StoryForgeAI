import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import {
  assignPlotNodeGroupRequestSchema,
  confirmDerivationCandidateRequestSchema,
  createDerivationCandidateRequestSchema,
  createDerivationSessionRequestSchema,
  createPlotGroupRequestSchema,
  createPlotLinkRequestSchema,
  createPlotNodeRequestSchema,
  createPlotTreeRequestSchema,
  importPlotTreeRequestSchema,
  movePlotNodeRequestSchema,
  plotTreeQuerySchema,
  updateDerivationSessionRequestSchema,
  updateDerivationStepRequestSchema,
  updatePlotGroupRequestSchema,
  updatePlotNodeRequestSchema,
  updatePlotPositionsRequestSchema,
  updatePlotTreeRequestSchema
} from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { PlotTreeService } from './plot-tree.service';
import { PlotDerivationService } from './plot-derivation.service';

type CreatePlotTreeRequest = z.infer<typeof createPlotTreeRequestSchema>;
type UpdatePlotTreeRequest = z.infer<typeof updatePlotTreeRequestSchema>;
type CreatePlotNodeRequest = z.infer<typeof createPlotNodeRequestSchema>;
type UpdatePlotNodeRequest = z.infer<typeof updatePlotNodeRequestSchema>;
type MovePlotNodeRequest = z.infer<typeof movePlotNodeRequestSchema>;
type AssignPlotNodeGroupRequest = z.infer<typeof assignPlotNodeGroupRequestSchema>;
type UpdatePlotPositionsRequest = z.infer<typeof updatePlotPositionsRequestSchema>;
type CreatePlotLinkRequest = z.infer<typeof createPlotLinkRequestSchema>;
type CreatePlotGroupRequest = z.infer<typeof createPlotGroupRequestSchema>;
type UpdatePlotGroupRequest = z.infer<typeof updatePlotGroupRequestSchema>;
type ImportPlotTreeRequest = z.infer<typeof importPlotTreeRequestSchema>;
type CreateDerivationSessionRequest = z.infer<typeof createDerivationSessionRequestSchema>;
type UpdateDerivationSessionRequest = z.infer<typeof updateDerivationSessionRequestSchema>;
type UpdateDerivationStepRequest = z.infer<typeof updateDerivationStepRequestSchema>;
type CreateDerivationCandidateRequest = z.infer<typeof createDerivationCandidateRequestSchema>;
type ConfirmDerivationCandidateRequest = z.infer<typeof confirmDerivationCandidateRequestSchema>;

/**
 * M3c-1 剧情树接口层。
 * 读取仅需 SessionGuard；所有写操作额外 CsrfGuard。
 */
@Controller()
@UseGuards(SessionGuard)
export class PlotController {
  constructor(
    @Inject(PlotTreeService) private readonly plotTree: PlotTreeService,
    @Inject(PlotDerivationService) private readonly derivations: PlotDerivationService
  ) {}

  @Get('works/:workId/plot-tree')
  async getTree(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Query(new ZodValidationPipe(plotTreeQuerySchema)) query: { includeArchivedOwner: boolean }
  ) {
    return ok(
      request,
      await this.plotTree.getTree(request.author.id, workId, {
        includeArchivedOwner: query.includeArchivedOwner
      })
    );
  }

  @Post('works/:workId/plot-tree')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createTree(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createPlotTreeRequestSchema)) input: CreatePlotTreeRequest
  ) {
    return ok(request, await this.plotTree.createTree(request.author.id, workId, input));
  }

  @Patch('works/:workId/plot-tree')
  @UseGuards(CsrfGuard)
  async updateTree(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(updatePlotTreeRequestSchema)) input: UpdatePlotTreeRequest
  ) {
    return ok(request, await this.plotTree.updateTree(request.author.id, workId, input));
  }

  @Post('works/:workId/plot-tree/nodes')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createNode(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createPlotNodeRequestSchema)) input: CreatePlotNodeRequest
  ) {
    return ok(request, await this.plotTree.createNode(request.author.id, workId, input));
  }

  @Patch('works/:workId/plot-tree/nodes/:nodeId')
  @UseGuards(CsrfGuard)
  async updateNode(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(updatePlotNodeRequestSchema)) input: UpdatePlotNodeRequest
  ) {
    return ok(request, await this.plotTree.updateNode(request.author.id, workId, nodeId, input));
  }

  @Delete('works/:workId/plot-tree/nodes/:nodeId')
  @UseGuards(CsrfGuard)
  async deleteNode(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('nodeId') nodeId: string
  ) {
    return ok(request, await this.plotTree.deleteNode(request.author.id, workId, nodeId));
  }

  @Patch('works/:workId/plot-tree/nodes/:nodeId/parent')
  @UseGuards(CsrfGuard)
  async moveNode(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(movePlotNodeRequestSchema)) input: MovePlotNodeRequest
  ) {
    return ok(request, await this.plotTree.moveNode(request.author.id, workId, nodeId, input));
  }

  @Patch('works/:workId/plot-tree/nodes/:nodeId/group')
  @UseGuards(CsrfGuard)
  async assignGroup(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('nodeId') nodeId: string,
    @Body(new ZodValidationPipe(assignPlotNodeGroupRequestSchema)) input: AssignPlotNodeGroupRequest
  ) {
    return ok(request, await this.plotTree.assignGroup(request.author.id, workId, nodeId, input));
  }

  @Put('works/:workId/plot-tree/positions')
  @UseGuards(CsrfGuard)
  async updatePositions(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(updatePlotPositionsRequestSchema)) input: UpdatePlotPositionsRequest
  ) {
    return ok(request, await this.plotTree.updatePositions(request.author.id, workId, input));
  }

  @Post('works/:workId/plot-tree/links')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createLink(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createPlotLinkRequestSchema)) input: CreatePlotLinkRequest
  ) {
    return ok(request, await this.plotTree.createLink(request.author.id, workId, input));
  }

  @Delete('works/:workId/plot-tree/links/:linkId')
  @UseGuards(CsrfGuard)
  async deleteLink(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('linkId') linkId: string
  ) {
    return ok(request, await this.plotTree.deleteLink(request.author.id, workId, linkId));
  }

  @Post('works/:workId/plot-tree/groups')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createGroup(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createPlotGroupRequestSchema)) input: CreatePlotGroupRequest
  ) {
    return ok(request, await this.plotTree.createGroup(request.author.id, workId, input));
  }

  @Patch('works/:workId/plot-tree/groups/:groupId')
  @UseGuards(CsrfGuard)
  async updateGroup(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('groupId') groupId: string,
    @Body(new ZodValidationPipe(updatePlotGroupRequestSchema)) input: UpdatePlotGroupRequest
  ) {
    return ok(request, await this.plotTree.updateGroup(request.author.id, workId, groupId, input));
  }

  @Delete('works/:workId/plot-tree/groups/:groupId')
  @UseGuards(CsrfGuard)
  async deleteGroup(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('groupId') groupId: string
  ) {
    return ok(request, await this.plotTree.deleteGroup(request.author.id, workId, groupId));
  }

  @Get('works/:workId/plot-tree/export')
  @Header('Content-Disposition', 'attachment; filename="plot-tree.json"')
  async exportTree(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.plotTree.exportTree(request.author.id, workId));
  }

  @Post('works/:workId/plot-tree/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async importTree(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(importPlotTreeRequestSchema)) input: ImportPlotTreeRequest
  ) {
    return ok(request, await this.plotTree.importTree(request.author.id, workId, input));
  }

  // ── 推衍 ──

  @Post('works/:workId/plot-tree/derivations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createDerivation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(createDerivationSessionRequestSchema)) input: CreateDerivationSessionRequest
  ) {
    return ok(request, await this.derivations.createSession(request.author.id, workId, input));
  }

  @Get('works/:workId/plot-tree/derivations/:sessionId')
  async getDerivation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('sessionId') sessionId: string
  ) {
    return ok(request, await this.derivations.getSession(request.author.id, workId, sessionId));
  }

  @Patch('works/:workId/plot-tree/derivations/:sessionId')
  @UseGuards(CsrfGuard)
  async updateDerivation(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(updateDerivationSessionRequestSchema)) input: UpdateDerivationSessionRequest
  ) {
    return ok(request, await this.derivations.updateSession(request.author.id, workId, sessionId, input));
  }

  @Post('works/:workId/plot-tree/derivations/:sessionId/steps')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CsrfGuard)
  async generateDerivationStep(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('sessionId') sessionId: string
  ) {
    return ok(request, await this.derivations.generateStep(request.author.id, workId, sessionId));
  }

  @Patch('works/:workId/plot-tree/derivations/:sessionId/steps/:stepNo')
  @UseGuards(CsrfGuard)
  async updateDerivationStep(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('sessionId') sessionId: string,
    @Param('stepNo') stepNo: string,
    @Body(new ZodValidationPipe(updateDerivationStepRequestSchema)) input: UpdateDerivationStepRequest
  ) {
    const parsed = Number(stepNo);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new UnprocessableEntityException({ message: 'Invalid step number' });
    }
    return ok(request, await this.derivations.updateStep(request.author.id, workId, sessionId, parsed, input));
  }

  @Post('works/:workId/plot-tree/derivations/:sessionId/candidates')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createDerivationCandidate(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(createDerivationCandidateRequestSchema)) input: CreateDerivationCandidateRequest
  ) {
    return ok(request, await this.derivations.createCandidate(request.author.id, workId, sessionId, input));
  }

  @Post('works/:workId/plot-tree/derivations/:sessionId/candidates/:candidateId/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async confirmDerivationCandidate(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('sessionId') sessionId: string,
    @Param('candidateId') candidateId: string,
    @Body(new ZodValidationPipe(confirmDerivationCandidateRequestSchema)) input: ConfirmDerivationCandidateRequest
  ) {
    return ok(
      request,
      await this.derivations.confirmCandidate(request.author.id, workId, sessionId, candidateId, input)
    );
  }

  @Post('works/:workId/plot-tree/derivations/:sessionId/candidates/:candidateId/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard)
  async rejectDerivationCandidate(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('sessionId') sessionId: string,
    @Param('candidateId') candidateId: string
  ) {
    return ok(request, await this.derivations.rejectCandidate(request.author.id, workId, sessionId, candidateId));
  }
}
