import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { sendArkClawMessage } from './arkclaw-client';
import { ArkClawPage } from './arkclaw-page';

vi.mock('./arkclaw-client', () => ({ sendArkClawMessage: vi.fn() }));

function renderPage() {
  return render(<MemoryRouter initialEntries={['/arkclaw']}><Routes>
    <Route path="/arkclaw" element={<ArkClawPage />} />
    <Route path="/works" element={<p>作品库页面</p>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(sendArkClawMessage).mockReset();
});

describe('ArkClawPage', () => {
  it('rejects blank input without calling the API', async () => {
    renderPage();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(sendArkClawMessage).not.toHaveBeenCalled();
  });

  it('disables input and duplicate submission while pending', async () => {
    let finish!: (value: { answer: string }) => void;
    vi.mocked(sendArkClawMessage).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPage();
    await userEvent.type(screen.getByLabelText('问题'), '请介绍自己');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled();
    expect(screen.getByLabelText('问题')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '发送中…' }));
    expect(sendArkClawMessage).toHaveBeenCalledTimes(1);
    await act(async () => finish({ answer: '完整回答' }));
    expect(await screen.findByText('完整回答')).toBeVisible();
    expect(screen.getByLabelText('问题')).toBeEnabled();
  });

  it('replaces the previous answer on a new successful question', async () => {
    vi.mocked(sendArkClawMessage)
      .mockResolvedValueOnce({ answer: '第一次回答' })
      .mockResolvedValueOnce({ answer: '第二次回答' });
    renderPage();
    const input = screen.getByLabelText('问题');
    await userEvent.type(input, '第一问');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('第一次回答')).toBeVisible();

    await userEvent.clear(input);
    await userEvent.type(input, '第二问');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('第二次回答')).toBeVisible();
    expect(screen.queryByText('第一次回答')).not.toBeInTheDocument();
  });

  it('shows a sanitized error and preserves the current input after failure', async () => {
    vi.mocked(sendArkClawMessage).mockRejectedValue(new ApiError(
      503, 'INTERNAL_ERROR', 'ArkClaw 服务尚未配置', {}, 'req-1'
    ));
    renderPage();
    const input = screen.getByLabelText('问题');
    await userEvent.type(input, '保留这个问题');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ArkClaw 服务尚未配置');
    expect(input).toHaveValue('保留这个问题');
  });

  it('returns to the works library', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: '返回作品库' }));
    expect(await screen.findByText('作品库页面')).toBeVisible();
  });
});
