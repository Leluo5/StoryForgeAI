import type { ZodType } from 'zod';

export class ApiError<T = unknown> extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: T,
    public readonly requestId: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function csrfToken(): string {
  const cookie = document.cookie.split('; ').find((item) => item.startsWith('storyforge_csrf='));
  return decodeURIComponent(cookie?.slice('storyforge_csrf='.length) ?? '');
}

// 泛型取 schema 的「输出」类型（Output），避免 .default() 使 Input≠Output 时被推断成 Input。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiRequest<T>(path: string, schema: ZodType<T, any, any>, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'x-csrf-token': csrfToken() } : {}),
      ...init.headers
    }
  });
  const json = await response.json() as {
    data?: unknown;
    request_id?: string;
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      json.error?.code ?? 'UNKNOWN',
      json.error?.message ?? 'Request failed',
      json.error?.details,
      json.request_id ?? ''
    );
  }
  return schema.parse(json.data);
}
