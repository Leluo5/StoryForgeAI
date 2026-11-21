import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { env } from '../config/env';
import { ArkClawController } from './arkclaw.controller';
import { ArkClawService } from './arkclaw.service';

@Module({
  imports: [AuthModule],
  controllers: [ArkClawController],
  providers: [{
    provide: ArkClawService,
    useFactory: () => new ArkClawService(env.ARKCLAW_A2A_ENDPOINT)
  }]
})
export class ArkClawModule {}
