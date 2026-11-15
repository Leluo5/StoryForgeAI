import { ApiError, login } from './auth-client';

const session = {
  author: {
    id: '0f7b70de-24f0-4f0f-a568-96bb1a95bd62',
    email: 'author@example.com',
    display_name: 'M0 Author'
  },
  csrf_token: 'a'.repeat(64)
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it('uses same-origin credentials and validates the success envelope', async () => {
  const requestId = crypto.randomUUID();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: session, request_id: requestId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(login({ email: 'author@example.com', password: 'correct horse' })).resolves.toEqual(session);
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify({ email: 'author@example.com', password: 'correct horse' })
  }));
});

it('preserves structured API errors', async () => {
  const requestId = crypto.randomUUID();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' }, request_id: requestId
  }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

  const promise = login({ email: 'author@example.com', password: 'wrong password' });
  await expect(promise).rejects.toMatchObject({
    name: 'ApiError', status: 401, code: 'UNAUTHORIZED', requestId
  });
  await expect(promise).rejects.toBeInstanceOf(ApiError);
});
