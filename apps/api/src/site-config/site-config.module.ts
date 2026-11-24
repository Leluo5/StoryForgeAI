import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SiteConfigEntity } from '../database/site-config.entity';
import { AuthModule } from '../auth/auth.module';
import { SiteConfigService } from './site-config.service';
import { SiteConfigController } from './site-config.controller';

// F4 作者级站点设置模块：仅站点设置页，无独立认证（复用作者 SessionGuard）。
// 导出 SiteConfigService 供 collab/agent 等消费方注入，实现平台凭据作者级接管（优先 site_config、env 兜底）。
@Module({
  imports: [TypeOrmModule.forFeature([SiteConfigEntity]), AuthModule],
  providers: [SiteConfigService],
  controllers: [SiteConfigController],
  exports: [SiteConfigService]
})
export class SiteConfigModule {}
