import {
  apiErrorSchema,
  apiSuccessSchema,
  loginRequestSchema,
  sessionResponseSchema,
  type LoginRequest,
  type SessionResponse
} from '@storyforge/contracts';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiRequest<T>(
  path: string,
  init: RequestInit,
  readData: (json: unknown) => T
): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  const json: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorSchema.parse(json);
    throw new ApiError(response.status, error.error.code, error.error.message, error.request_id);
  }
  return readData(json);
}

export function login(input: LoginRequest): Promise<SessionResponse> {
  const body = loginRequestSchema.parse(input);
  return apiRequest('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, (json) => apiSuccessSchema(sessionResponseSchema).parse(json).data);
}

export function getSession(): Promise<SessionResponse> {
  return apiRequest('/api/v1/auth/session', { method: 'GET' }, (json) =>
    apiSuccessSchema(sessionResponseSchema).parse(json).data);
}

export function logout(csrfToken: string): Promise<{ logged_out: true }> {
  return apiRequest('/api/v1/auth/logout', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken }
  }, (json) => apiSuccessSchema(z.object({ logged_out: z.literal(true) })).parse(json).data);
}

export const authClient = { login, getSession, logout };
