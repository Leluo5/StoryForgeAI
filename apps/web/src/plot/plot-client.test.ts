import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { plotClient } from './plot-client';

const { confirmCandidate, createNode, deleteNode, exportTree, fetchTree, importTree, updatePositions } = plotClient;

const workId = '11111111-1111-4111-8111-111111111111';
const nodeId = '22222222-2222-4222-8222-222222222222';

interface Captured {
  url: string;
  method: string;
  body?: unknown;
}

const calls: Captured[] = [];

function respond(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ data, request_id: 'req-1' }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const url = String(input);
  calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (url.endsWith('/export')) {
    return respond({
      schema_version: 1,
      exported_at: new Date().toISOString(),
      tree: { title: '主线' },
      nodes: [],
      links: [],
      groups: []
    });
  }
  if (url.endsWith('/positions')) return respond({ updated: 2 });
  if (url.endsWith('/import')) return respond({ tree: null, nodes: [], links: [], groups: [] });
  if (url.includes('/candidates/')) return respond({ nodes: [], version: 5 });
  if (url.includes('/nodes/')) return respond({ deleted: 3, version: 2 });
  if (url.endsWith('/nodes')) {
    return respond({
      node: {
        id: nodeId, tree_id: '33333333-3333-4333-8333-333333333333', parent_id: null, sibling_order: 0,
        title: '新节点', summary: null, content: '', attributes: {}, position: { x: 0, y: 0 },
        group_id: null, origin: 'manual', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      version: 2
    });
  }
  return respond({ tree: null, nodes: [], links: [], groups: [] });
});

beforeEach(() => {
  calls.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('plot-client', () => {
  it('loads the whole tree via GET', async () => {
    const result = await fetchTree(workId);
    expect(result.tree).toBeNull();
    expect(calls[0]).toMatchObject({ url: `/api/v1/works/${workId}/plot-tree`, method: 'GET' });
  });

  it('creates nodes with parsed defaults and expected version', async () => {
    await createNode(workId, { title: '新节点', expected_version: 1 });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`/api/v1/works/${workId}/plot-tree/nodes`);
    expect(calls[0]!.body).toMatchObject({
      title: '新节点', content: '', attributes: {}, position: { x: 0, y: 0 }, origin: 'manual', expected_version: 1
    });
  });

  it('submits batched positions with PUT', async () => {
    const result = await updatePositions(workId, [{ node_id: nodeId, x: 10, y: 20 }]);
    expect(result.updated).toBe(2);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `/api/v1/works/${workId}/plot-tree/positions` });
    expect(calls[0]!.body).toEqual({ positions: [{ node_id: nodeId, x: 10, y: 20 }] });
  });

  it('deletes a node and returns cascade count', async () => {
    const result = await deleteNode(workId, nodeId);
    expect(result).toEqual({ deleted: 3, version: 2 });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `/api/v1/works/${workId}/plot-tree/nodes/${nodeId}` });
  });

  it('exports and imports JSON through the plot-tree endpoints', async () => {
    const exported = await exportTree(workId);
    expect(exported.schema_version).toBe(1);
    expect(calls[0]!.url).toBe(`/api/v1/works/${workId}/plot-tree/export`);

    await importTree(workId, {
      schema_version: 1,
      tree: { title: '主线' },
      nodes: [{ title: '开场' }],
      links: [],
      groups: []
    });
    expect(calls[1]).toMatchObject({ method: 'POST', url: `/api/v1/works/${workId}/plot-tree/import` });
    expect(calls[1]!.body).toMatchObject({ schema_version: 1, nodes: [{ title: '开场', origin: 'import' }] });
  });

  it('confirms candidates with expected version', async () => {
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const candidateId = '55555555-5555-4555-8555-555555555555';
    await confirmCandidate(workId, sessionId, candidateId, 7);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/plot-tree/derivations/${sessionId}/candidates/${candidateId}/confirm`
    });
    expect(calls[0]!.body).toEqual({ expected_version: 7 });
  });

  it('surfaces API errors as ApiError with code', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      error: { code: 'PLOT_VERSION_CONFLICT', message: 'conflict', details: { current_version: 9 } },
      request_id: 'req-2'
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    await expect(createNode(workId, { title: 'x' })).rejects.toMatchObject({
      status: 409, code: 'PLOT_VERSION_CONFLICT'
    });
    await expect(createNode(workId, { title: 'x' })).rejects.toBeInstanceOf(ApiError);
  });
});
