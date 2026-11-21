import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CollabClient } from './collab-client';
import { CollabRevertDialog } from './collab-revert-dialog';

// T19 写回撤销弹窗：前后值展示 / 二次确认 / 已撤销态 / aria-live 播报

const workId = crypto.randomUUID();
const writebackId = crypto.randomUUID();

function makeClient(): CollabClient {
  return {
    revertWritebackField: vi.fn().mockResolvedValue({
      field_key: 'identity' as const,
      status: 'reverted' as const,
      reverted_at: new Date().toISOString(),
      reverted_by: 'author'
    })
  } as unknown as CollabClient;
}

describe('CollabRevertDialog（写回撤销弹窗）', () => {
  it('展示先前值与当前值', () => {
    const client = makeClient();
    render(
      <CollabRevertDialog
        workId={workId}
        writebackId={writebackId}
        field={{ field_key: 'identity', before_value: '旧身份', after_value: '新身份', status: 'applied', reverted_at: null, reverted_by: null }}
        client={client}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('旧身份')).toBeVisible();
    expect(screen.getByText('新身份')).toBeVisible();
    expect(screen.getByText('撤销')).toBeVisible();
  });

  it('二次确认后调用 revertWritebackField 并回调 onReverted + onClose', async () => {
    const client = makeClient();
    const revert = vi.mocked(client.revertWritebackField);
    const onReverted = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <CollabRevertDialog
        workId={workId}
        writebackId={writebackId}
        field={{ field_key: 'personality', before_value: '旧', after_value: '新', status: 'applied', reverted_at: null, reverted_by: null }}
        client={client}
        onClose={onClose}
        onReverted={onReverted}
      />
    );
    await user.click(screen.getByRole('button', { name: '再次确认' }));
    await user.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => {
      expect(revert).toHaveBeenCalledWith(workId, writebackId, 'personality');
    });
    expect(onReverted).toHaveBeenCalledWith('personality');
    expect(onClose).toHaveBeenCalled();
  });

  it('已撤销字段不显示确认按钮', () => {
    render(
      <CollabRevertDialog
        workId={workId}
        writebackId={writebackId}
        field={{ field_key: 'experience', before_value: '旧', after_value: '新', status: 'reverted', reverted_at: new Date().toISOString(), reverted_by: 'author' }}
        client={makeClient()}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/已撤销/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认撤销' })).not.toBeInTheDocument();
  });

  it('撤销失败时展示错误并在 aria-live 播报', async () => {
    const client = makeClient();
    vi.mocked(client.revertWritebackField).mockRejectedValueOnce(new Error('冲突'));
    const user = userEvent.setup();
    render(
      <CollabRevertDialog
        workId={workId}
        writebackId={writebackId}
        field={{ field_key: 'identity', before_value: '旧', after_value: '新', status: 'applied', reverted_at: null, reverted_by: null }}
        client={client}
        onClose={() => {}}
      />
    );
    await user.click(screen.getByRole('button', { name: '再次确认' }));
    await user.click(screen.getByRole('button', { name: '确认撤销' }));
    const alerts = await screen.findAllByText('冲突');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]).toHaveAttribute('role', 'alert');
  });
});
