import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { HttpEnvelopeFilter } from './common/http-exception.filter';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalFilters(new HttpEnvelopeFilter());
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
}
