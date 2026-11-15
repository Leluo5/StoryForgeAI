import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../common/http';
import { SESSION_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const raw = request.cookies[SESSION_COOKIE] as string | undefined;
    const author = await this.auth.validate(raw);
    if (!author) throw new UnauthorizedException('Authentication required');
    request.author = author;
    return true;
  }
}
