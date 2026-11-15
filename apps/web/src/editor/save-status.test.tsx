import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SaveStatusView } from './save-status';

describe('SaveStatusView', () => {
  it('requires confirmation before restoring the server snapshot from save_failed', async () => {
    const onRestore = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SaveStatusView status="save_failed" onRetry={vi.fn()} onTakeover={vi.fn()} onRestore={onRestore} />);
    const restore = screen.getByRole('button', { name: '从服务端恢复' });

    await userEvent.click(restore);
    expect(onRestore).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(restore);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
