import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeSearchBar } from './knowledge-search-bar';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('KnowledgeSearchBar', () => {
  it('debounces search by 300ms and fires once', () => {
    const onSearch = vi.fn();
    render(<KnowledgeSearchBar onSearch={onSearch} />);
    const input = screen.getByPlaceholderText('搜索标题、标签、内容…');
    fireEvent.change(input, { target: { value: '灵感' } });
    expect(onSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('灵感');
  });

  it('clears the keyword and triggers an empty search', () => {
    const onSearch = vi.fn();
    render(<KnowledgeSearchBar onSearch={onSearch} />);
    const input = screen.getByPlaceholderText('搜索标题、标签、内容…');
    fireEvent.change(input, { target: { value: 'abc' } });
    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenCalledWith('abc');

    const clear = screen.getByRole('button', { name: '清空' });
    fireEvent.click(clear);
    expect(onSearch).toHaveBeenLastCalledWith('');
    expect(input).toHaveValue('');
  });

  it('syncs to initialValue when it changes externally', () => {
    const onSearch = vi.fn();
    const { rerender } = render(<KnowledgeSearchBar initialValue="" onSearch={onSearch} />);
    rerender(<KnowledgeSearchBar initialValue="小说" onSearch={onSearch} />);
    expect(screen.getByPlaceholderText('搜索标题、标签、内容…')).toHaveValue('小说');
  });
});
