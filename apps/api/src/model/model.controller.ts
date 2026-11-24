import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import type { CreateModelRequest, UpdateModelRequest } from '@storyforge/contracts';
import { createModelRequestSchema, updateModelRequestSchema } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { ModelService } from './model.service';

/**
 * 模型管理：作者级 AI 模型选型目录接口层。
 * 路由体系（均挂 SessionGuard，写操作额外 CsrfGuard）：
 * - GET    /ai-models                     列出作者全部模型（keyword/status 过滤 + 分页）
 * - POST   /ai-models                     创建模型
 * - GET    /ai-models/:modelId            模型详情
 * - PATCH  /ai-models/:modelId            更新模型（白名单）
 * - DELETE /ai-models/:modelId            删除模型（直接硬删）
 */
@Controller()
@UseGuards(SessionGuard)
export class ModelController {
  constructor(@Inject(ModelService) private readonly modelService: ModelService) {}

  // ── 列出模型 ──

  @Get('ai-models')
  async listModels(
    @Req() request: AuthenticatedRequest,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string
  ) {
    return ok(
      request,
      await this.modelService.listModels(request.author.id, {
        ...(keyword ? { keyword } : {}),
        ...(status ? { status } : {}),
        ...(page ? { page: Number(page) } : {}),
        ...(pageSize ? { page_size: Number(pageSize) } : {})
      })
    );
  }

  // ── 模型详情 ──

  @Get('ai-models/:modelId')
  async getModel(@Req() request: AuthenticatedRequest, @Param('modelId') modelId: string) {
    return ok(request, await this.modelService.getModel(request.author.id, modelId));
  }

  // ── 创建模型 ──

  @Post('ai-models')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CsrfGuard)
  async createModel(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createModelRequestSchema)) input: CreateModelRequest
  ) {
    return ok(request, await this.modelService.createModel(request.author.id, input));
  }

  // ── 更新模型 ──

  @Patch('ai-models/:modelId')
  @UseGuards(CsrfGuard)
  async updateModel(
    @Req() request: AuthenticatedRequest,
    @Param('modelId') modelId: string,
    @Body(new ZodValidationPipe(updateModelRequestSchema)) input: UpdateModelRequest
  ) {
    return ok(request, await this.modelService.updateModel(request.author.id, modelId, input));
  }

  // ── 删除模型 ──

  @Delete('ai-models/:modelId')
  @UseGuards(CsrfGuard)
  async deleteModel(@Req() request: AuthenticatedRequest, @Param('modelId') modelId: string) {
    return ok(request, await this.modelService.deleteModel(request.author.id, modelId));
  }
}
