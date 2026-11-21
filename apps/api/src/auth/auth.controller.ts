import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { loginRequestSchema, type SessionResponse } from '@storyforge/contracts';
import type { CookieOptions, Response } from 'express';
import { env } from '../config/env';
import { ok, type AuthenticatedRequest, type RequestWithId, type SuccessEnvelope } from '../common/http';
import { CSRF_COOKIE, SESSION_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { SessionGuard } from './session.guard';

function cookieOptions(httpOnly: boolean): CookieOptions {
  return {
    httpOnly,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/'
  };
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: RequestWithId,
    @Res({ passthrough: true }) response: Response
  ): Promise<SuccessEnvelope<SessionResponse>> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: 'Invalid login input',
        details: { fields: parsed.error.flatten().fieldErrors }
      });
    }

    const result = await this.auth.login(parsed.data.email, parsed.data.password);
    const maxAge = env.SESSION_TTL_SECONDS * 1000;
    response.cookie(SESSION_COOKIE, result.sessionToken, { ...cookieOptions(true), maxAge });
    response.cookie(CSRF_COOKIE, result.csrfToken, { ...cookieOptions(false), maxAge });
    return ok(request, { author: result.author, csrf_token: result.csrfToken });
  }

  @Post('login-or-register')
  @HttpCode(HttpStatus.OK)
  async loginOrRegister(
    @Body() body: unknown,
    @Req() request: RequestWithId,
    @Res({ passthrough: true }) response: Response
  ): Promise<SuccessEnvelope<SessionResponse & { created: boolean }>> {
    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: 'Invalid login input',
        details: { fields: parsed.error.flatten().fieldErrors }
      });
    }

    const result = await this.auth.loginOrRegister(parsed.data.email, parsed.data.password);
    const maxAge = env.SESSION_TTL_SECONDS * 1000;
    response.cookie(SESSION_COOKIE, result.sessionToken, { ...cookieOptions(true), maxAge });
    response.cookie(CSRF_COOKIE, result.csrfToken, { ...cookieOptions(false), maxAge });
    return ok(request, { author: result.author, csrf_token: result.csrfToken, created: result.created });
  }

  @Get('session')
  @UseGuards(SessionGuard)
  session(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): SuccessEnvelope<SessionResponse> {
    let csrfToken = request.cookies[CSRF_COOKIE] as string | undefined;
    if (!csrfToken) {
      csrfToken = this.auth.createRawToken();
      response.cookie(CSRF_COOKIE, csrfToken, {
        ...cookieOptions(false),
        maxAge: env.SESSION_TTL_SECONDS * 1000
      });
    }
    return ok(request, { author: request.author, csrf_token: csrfToken });
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): Promise<SuccessEnvelope<{ logged_out: true }>> {
    await this.auth.logout(request.cookies[SESSION_COOKIE] as string);
    response.clearCookie(SESSION_COOKIE, cookieOptions(true));
    response.clearCookie(CSRF_COOKIE, cookieOptions(false));
    return ok(request, { logged_out: true });
  }
}
