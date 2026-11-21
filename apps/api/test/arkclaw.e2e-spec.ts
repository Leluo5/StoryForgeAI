import { randomUUID } from 'node:crypto';
import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Author } from '@storyforge/contracts';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { ArkClawController } from '../src/arkclaw/arkclaw.controller';
import { ArkClawService } from '../src/arkclaw/arkclaw.service';
import { AuthService } from '../src/auth/auth.service';
import { CsrfGuard } from '../src/auth/csrf.guard';
import { SessionGuard } from '../src/auth/session.guard';
import { RequestIdMiddleware } from '../src/common/request-id.middleware';

const author: Author = { id: randomUUID(), email: 'author@example.com', display_name: 'Author' };
const chat = vi.fn();
const validate = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ArkClawController],
    providers: [
      { provide: ArkClawService, useValue: { chat } },
      { provide: AuthService, useValue: { validate } },
      SessionGuard,
      CsrfGuard
    ]
  }).compile();
  app = module.createNestApplication();
  const requestId = new RequestIdMiddleware();
  app.use(requestId.use.bind(requestId));
  configureApp(app);
  await app.init();
});

afterAll(async () => app.close());

beforeEach(() => {
  chat.mockReset();
  validate.mockReset().mockImplementation(async (raw?: string) => raw === 'session' ? author : null);
});

function authorizedPost() {
  return request(app.getHttpServer())
    .post('/api/v1/arkclaw/chat')
    .set('Cookie', ['storyforge_session=session', 'storyforge_csrf=csrf'])
    .set('x-csrf-token', 'csrf');
}

describe('ArkClaw chat endpoint', () => {
  it('requires Session and CSRF before calling the service', async () => {
    await request(app.getHttpServer()).post('/api/v1/arkclaw/chat').send({ message: '问题' }).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/arkclaw/chat')
      .set('Cookie', ['storyforge_session=session', 'storyforge_csrf=csrf'])
      .send({ message: '问题' })
      .expect(403);
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns field errors for a blank message without calling the service', async () => {
    const response = await authorizedPost().send({ message: '   ' }).expect(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.field_errors.message).toBeDefined();
    expect(chat).not.toHaveBeenCalled();
  });

  it('trims input and wraps the answer with the response request id', async () => {
    chat.mockResolvedValue({ answer: '完整回答' });
    const response = await authorizedPost().send({ message: '  请介绍自己  ' }).expect(200);
    expect(chat).toHaveBeenCalledWith('请介绍自己');
    expect(response.body).toEqual({
      data: { answer: '完整回答' },
      request_id: response.headers['x-request-id']
    });
  });

  it.each([
    { exception: new ServiceUnavailableException('ArkClaw 服务尚未配置'), status: 503 },
    { exception: new BadGatewayException('ArkClaw 调用失败'), status: 502 },
    { exception: new GatewayTimeoutException('ArkClaw 调用超时，请稍后手动重试'), status: 504 }
  ])('preserves only fixed service errors with the expected status', async ({ exception, status }) => {
    chat.mockRejectedValue(exception);
    const response = await authorizedPost().send({ message: '问题' }).expect(status);
    expect(response.body.error.message).toBe(exception.message);
    expect(JSON.stringify(response.body)).not.toContain('fake-key');
    expect(JSON.stringify(response.body)).not.toContain('clawId=');
  });
});
