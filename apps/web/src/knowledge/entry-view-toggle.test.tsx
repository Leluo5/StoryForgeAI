import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EntryViewToggle } from './entry-view-toggle';

describe('EntryViewToggle', () => {
  it('renders both tabs with original active by default', () => {
    render(<EntryViewToggle value="original" structuredDisabled={false} onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: '原文' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '结构化' })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches to structured when enabled', async () => {
    const onChange = vi.fn();
    render(<EntryViewToggle value="original" structuredDisabled={false} onChange={onChange} />);
    await userEvent.click(screen.getByRole('tab', { name: '结构化' }));
    expect(onChange).toHaveBeenCalledWith('structured');
  });

  it('disables structured when unavailable', () => {
    render(<EntryViewToggle value="original" structuredDisabled onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: '结构化' })).toBeDisabled();
  });
});
