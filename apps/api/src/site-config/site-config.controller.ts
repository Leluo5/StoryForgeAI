import { Body, Controller, Get, Inject, Put, Req, UseGuards } from '@nestjs/common';
import type { UpdateSiteConfigRequest } from '@storyforge/contracts';
import { updateSiteConfigRequestSchema } from '@storyforge/contracts';
import { SessionGuard } from '../auth/session.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ok, type AuthenticatedRequest } from '../common/http';
import { SiteConfigService } from './site-config.service';

// F4 作者级站点设置：作者登录即可访问自己的后台（复用 SessionGuard），无独立认证。
// - GET /api/v1/site-config   读取当前作者站点设置（无记录返回默认值）
// - PUT /api/v1/site-config   更新当前作者站点设置（写操作挂 CsrfGuard）
@Controller()
@UseGuards(SessionGuard)
export class SiteConfigController {
  constructor(@Inject(SiteConfigService) private readonly siteConfig: SiteConfigService) {}

  @Get('site-config')
  async getConfig(@Req() request: AuthenticatedRequest) {
    return ok(request, { config: await this.siteConfig.getConfig(request.author.id) });
  }

  @Put('site-config')
  @UseGuards(CsrfGuard)
  async updateConfig(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateSiteConfigRequestSchema)) input: UpdateSiteConfigRequest
  ) {
    return ok(request, { config: await this.siteConfig.updateConfig(request.author.id, input) });
  }
}
