import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TypeSelector, KNOWLEDGE_TYPE_OPTIONS } from './type-selector';

describe('TypeSelector', () => {
  it('renders auto plus the five entry types as radio options', () => {
    render(<TypeSelector value="auto" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(KNOWLEDGE_TYPE_OPTIONS.length);
    expect(radios.map((r) => r.textContent)).toEqual(['自动', '文章', '论文', '小说', '灵感', '设定']);
  });

  it('marks the selected option with aria-checked', () => {
    render(<TypeSelector value="paper" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '论文' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '自动' })).toHaveAttribute('aria-checked', 'false');
  });

  it('reports the chosen type on click', async () => {
    const onChange = vi.fn();
    render(<TypeSelector value="auto" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: '设定' }));
    expect(onChange).toHaveBeenCalledWith('setting');
  });

  it('is disabled when disabled is true', () => {
    render(<TypeSelector value="auto" onChange={() => {}} disabled />);
    expect(screen.getByRole('radio', { name: '自动' })).toBeDisabled();
  });
});
