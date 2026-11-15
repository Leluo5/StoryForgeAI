import { loginRequestSchema, sessionResponseSchema, type LoginRequest, type SessionResponse } from '@storyforge/contracts';
import { apiRequest } from '../api/client';

export { ApiError } from '../api/client';

export function login(input: LoginRequest): Promise<SessionResponse> {
  return apiRequest('/api/v1/auth/login', sessionResponseSchema, {
    method: 'POST',
    body: JSON.stringify(loginRequestSchema.parse(input))
  });
}

export function getSession(): Promise<SessionResponse> {
  return apiRequest('/api/v1/auth/session', sessionResponseSchema);
}
