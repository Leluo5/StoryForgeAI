import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestWithId } from '../common/http';
import { CSRF_COOKIE } from './auth.constants';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithId>();
    const header = request.get('x-csrf-token');
    const cookie = request.cookies[CSRF_COOKIE] as string | undefined;
    if (!header || !cookie) throw new ForbiddenException('CSRF token mismatch');

    const supplied = Buffer.from(header);
    const expected = Buffer.from(cookie);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ForbiddenException('CSRF token mismatch');
    }
    return true;
  }
}
