import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunHandler } from './workflow-run.handler';
import { CollabUpstreamError } from './channel/collab-upstream.error';
import type { CozeImportClient } from './coze-import.client';

describe('WorkflowRunHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('runs the upstream workflow and returns a structured summary', async () => {
    const client = { runWorkflow: vi.fn(async () => ({ data: { node_title: '结尾' } })) } as unknown as CozeImportClient;
    const handler = new WorkflowRunHandler(client as unknown as CozeImportClient);

    const summary = await handler.handle({
      taskId: 't-1',
      authorId: 'a-1',
      workId: 'w-1',
      tool: 'workflow_run',
      inputSummary: {
        workflow_id: 'wf-local-1',
        platform_config: { workflow_id: 'wf-upstream-9' },
        parameters: { outline: '三章' }
      }
    });

    expect(client.runWorkflow).toHaveBeenCalledWith('a-1', 'wf-upstream-9', { outline: '三章' });
    expect(summary).toMatchObject({ scope: 'workflow_run', channel: 'coze', data: { node_title: '结尾' } });
  });

  it('fails fast when the workflow has no upstream id', async () => {
    const client = { runWorkflow: vi.fn() } as unknown as CozeImportClient;
    const handler = new WorkflowRunHandler(client);
    await expect(handler.handle({
      taskId: 't-2',
      authorId: 'a-1',
      workId: 'w-1',
      tool: 'workflow_run',
      inputSummary: { workflow_id: 'wf-local-1', platform_config: {} }
    })).rejects.toBeInstanceOf(CollabUpstreamError);
  });

  it('maps upstream code!=0 into a retryable upstream error', async () => {
    const client = { runWorkflow: vi.fn(async () => ({ code: 10000, msg: '工作流不存在' })) } as unknown as CozeImportClient;
    const handler = new WorkflowRunHandler(client);
    await expect(handler.handle({
      taskId: 't-3',
      authorId: 'a-1',
      workId: 'w-1',
      tool: 'workflow_run',
      inputSummary: { workflow_id: 'wf-local-1', platform_config: { workflow_id: 'wf-x' } }
    })).rejects.toBeInstanceOf(CollabUpstreamError);
  });
});
