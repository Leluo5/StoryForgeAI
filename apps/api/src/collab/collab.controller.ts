import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards
} from '@nestjs/common';
import type { PutCollabSettingsRequest } from '@storyforge/contracts';
import { putCollabSettingsRequestSchema, collabRoleFieldSchema } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { CollabService } from './collab.service';
import { CollabReadinessService } from './collab-readiness.service';
import { CollabRevertService } from './collab-revert.service';
import { CollabUpstreamError } from './channel/collab-upstream.error';

/**
 * F11 多平台 Agent 协同 · 配置与就绪接口层。
 * 全部挂 SessionGuard，写操作追加 CsrfGuard；成功响应 ok(request, data)。
 * - GET /works/:workId/collab-settings       读取配置（未配置返回 null）
 * - PUT /works/:workId/collab-settings       保存配置（覆盖式）
 * - GET /works/:workId/collab-readiness      就绪检查（只返回布尔与缺失项名称）
 */
@Controller()
@UseGuards(SessionGuard)
export class CollabController {
  constructor(
    @Inject(CollabService) private readonly collabService: CollabService,
    @Inject(CollabReadinessService) private readonly readinessService: CollabReadinessService,
    @Inject(CollabRevertService) private readonly revertService: CollabRevertService
  ) {}

  @Get('works/:workId/collab-settings')
  async getCollabSettings(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.collabService.getCollabSettings(request.author.id, workId));
  }

  @Get('works/:workId/collab-readiness')
  async getCollabReadiness(@Req() request: AuthenticatedRequest, @Param('workId') workId: string) {
    return ok(request, await this.readinessService.getReadiness(request.author.id, workId));
  }

  @Put('works/:workId/collab-settings')
  @UseGuards(CsrfGuard)
  async putCollabSettings(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Body(new ZodValidationPipe(putCollabSettingsRequestSchema)) input: PutCollabSettingsRequest
  ) {
    return ok(request, await this.collabService.putCollabSettings(request.author.id, workId, input));
  }

  /**
   * 撤销一次角色写回的单个字段（按字段撤销，冲突返回 409）。
   * 路径参数 fieldKey 用 collabRoleFieldSchema 校验；请求体可选 { expected_value } 前置校验。
   */
  @Post('works/:workId/role-profile/writebacks/:writebackId/fields/:fieldKey/revert')
  @UseGuards(CsrfGuard)
  async revertField(
    @Req() request: AuthenticatedRequest,
    @Param('workId') workId: string,
    @Param('writebackId') writebackId: string,
    @Param('fieldKey', new ZodValidationPipe(collabRoleFieldSchema)) fieldKey: string,
    @Body() input?: { expected_value?: unknown }
  ) {
    try {
      const result = await this.revertService.revertField(
        request.author.id,
        workId,
        writebackId,
        fieldKey as never,
        input?.expected_value
      );
      return ok(request, result);
    } catch (err) {
      if (err instanceof CollabUpstreamError) {
        const status =
          err.code === 'COLLAB_FIELD_CONFLICT' ? HttpStatus.CONFLICT :
          err.code === 'COLLAB_TEST_ROLE_MISMATCH' ? HttpStatus.NOT_FOUND :
          err.code === 'COLLAB_FIELD_NOT_ALLOWED' ? HttpStatus.BAD_REQUEST :
          HttpStatus.BAD_REQUEST;
        throw new HttpException({ error: err.code, message: err.message }, status);
      }
      throw err;
    }
  }
}
