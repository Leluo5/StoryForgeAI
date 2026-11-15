import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@storyforge/contracts';
import type { RequestWithId } from './http';

type ErrorCode = ApiError['error']['code'];

function errorCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'UPSTREAM_ERROR';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'BAD_REQUEST';
}

@Catch()
export class HttpEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<RequestWithId>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : undefined;
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const message = typeof body === 'string'
      ? body
      : typeof record.message === 'string'
        ? record.message
        : exception instanceof HttpException ? exception.message : 'Internal server error';
    const details = record.details && typeof record.details === 'object'
      ? record.details as Record<string, unknown>
      : undefined;

    response.status(status).json({
      error: {
        code: errorCode(status),
        message,
        ...(details ? { details } : {})
      },
      request_id: request.requestId
    });
  }
}
