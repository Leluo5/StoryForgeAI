import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CollabWriteback, CollabWritebackField } from '@storyforge/contracts';
import type { CollabClient } from './collab-client';
import { CollabWritebackList } from './collab-writeback-list';

// T19 写回历史列表：加载列表 / 撤销入口置灰 / 打开弹窗 / onReverted 更新状态

const workId = crypto.randomUUID();
const characterId = crypto.randomUUID();

function field(key: CollabWritebackField['field_key'], status: 'applied' | 'reverted'): CollabWritebackField {
  return { field_key: key, before_value: '旧', after_value: '新', status, reverted_at: null, reverted_by: null };
}

function writeback(overrides: Partial<CollabWriteback> = {}): CollabWriteback {
  return {
    id: crypto.randomUUID(),
    task_id: 'task-abcdef12',
    work_id: workId,
    character_id: characterId,
    channel: 'flowise',
    status: 'applied',
    applied_version: 1,
    applied_at: new Date().toISOString(),
    fields: [field('identity', 'applied')],
    ...overrides
  };
}

function makeClient(items: CollabWriteback[]): CollabClient {
  return {
    listWritebacks: vi.fn().mockResolvedValue(items),
    revertWritebackField: vi.fn()
  } as unknown as CollabClient;
}

describe('CollabWritebackList（写回历史列表）', () => {
  it('加载并展示写回单与字段', async () => {
    const client = makeClient([writeback()]);
    render(<CollabWritebackList workId={workId} characterId={characterId} client={client} />);
    expect(await screen.findByText('写回历史（1）')).toBeVisible();
    expect(screen.getByText(/task-abc/)).toBeVisible();
    expect(screen.getByText('身份定位')).toBeVisible();
    expect(screen.getByText(/新值：新/)).toBeVisible();
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
  });

  it('已撤销字段按钮置灰显示「已撤销」', async () => {
    const client = makeClient([writeback({ fields: [field('personality', 'reverted')] })]);
    render(<CollabWritebackList workId={workId} characterId={characterId} client={client} />);
    expect(await screen.findByText('写回历史（1）')).toBeVisible();
    const btn = screen.getByRole('button', { name: '已撤销' });
    expect(btn).toBeDisabled();
  });

  it('点击撤销打开弹窗，确认后更新本地状态为已撤销', async () => {
    const client = makeClient([writeback()]);
    vi.mocked(client.revertWritebackField).mockResolvedValue({
      field_key: 'identity', status: 'reverted', reverted_at: new Date().toISOString(), reverted_by: 'author'
    });
    const user = userEvent.setup();
    render(<CollabWritebackList workId={workId} characterId={characterId} client={client} />);
    await screen.findByText('写回历史（1）');
    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(await screen.findByText('撤销「身份定位」')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '再次确认' }));
    await user.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => {
      expect(client.revertWritebackField).toHaveBeenCalledWith(workId, expect.any(String), 'identity');
    });
    expect(await screen.findByRole('button', { name: '已撤销' })).toBeDisabled();
  });

  it('无写回记录时显示空态', async () => {
    const client = makeClient([]);
    render(<CollabWritebackList workId={workId} characterId={characterId} client={client} />);
    expect(await screen.findByText(/暂无写回记录/)).toBeVisible();
  });
});
