import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { requestIdSchema } from '@storyforge/contracts';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { AppModule } from '../src/app.module';

describe('HTTP envelope', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses one UUID for success, errors and the response header', async () => {
    const missing = await request(app.getHttpServer()).get('/api/v1/missing').expect(404);
    expect(requestIdSchema.parse(missing.body.request_id)).toBe(missing.headers['x-request-id']);
    expect(missing.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Cannot GET /api/v1/missing' },
      request_id: missing.headers['x-request-id']
    });

    const health = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(health.body).toEqual({
      data: { status: 'ok' },
      request_id: health.headers['x-request-id']
    });
    expect(requestIdSchema.safeParse(health.body.request_id).success).toBe(true);
  });
});
