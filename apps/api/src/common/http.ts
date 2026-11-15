import type { Author } from '@storyforge/contracts';
import type { Request } from 'express';

export interface RequestWithId extends Request {
  requestId: string;
}

export interface AuthenticatedRequest extends RequestWithId {
  author: Author;
}

export interface SuccessEnvelope<T> {
  data: T;
  request_id: string;
}

export function ok<T>(request: RequestWithId, data: T): SuccessEnvelope<T> {
  return { data, request_id: request.requestId };
}
