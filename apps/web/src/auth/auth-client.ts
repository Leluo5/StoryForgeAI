import { loginOrRegisterResponseSchema, loginRequestSchema, sessionResponseSchema, type LoginOrRegisterResponse, type LoginRequest, type SessionResponse } from '@storyforge/contracts';
import { z } from 'zod';
import { apiRequest } from '../api/client';

export { ApiError } from '../api/client';

const logoutResponseSchema = z.object({ logged_out: z.literal(true) });

export function login(input: LoginRequest): Promise<SessionResponse> {
  return apiRequest('/api/v1/auth/login', sessionResponseSchema, {
    method: 'POST',
    body: JSON.stringify(loginRequestSchema.parse(input))
  });
}

export function loginOrRegister(input: LoginRequest): Promise<LoginOrRegisterResponse> {
  return apiRequest('/api/v1/auth/login-or-register', loginOrRegisterResponseSchema, {
    method: 'POST',
    body: JSON.stringify(loginRequestSchema.parse(input))
  });
}

export function getSession(): Promise<SessionResponse> {
  return apiRequest('/api/v1/auth/session', sessionResponseSchema);
}

export function logout(): Promise<{ logged_out: true }> {
  return apiRequest('/api/v1/auth/logout', logoutResponseSchema, { method: 'POST' });
}
