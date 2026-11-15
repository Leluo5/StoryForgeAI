import { Controller, Get, Req } from '@nestjs/common';
import { ok, type RequestWithId, type SuccessEnvelope } from './common/http';

@Controller('health')
export class HealthController {
  @Get()
  health(@Req() request: RequestWithId): SuccessEnvelope<{ status: 'ok' }> {
    return ok(request, { status: 'ok' });
  }
}
