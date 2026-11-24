import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryCreate, parseTags } from './entry-create';
import { knowledgeClient } from './knowledge-client';
import { ApiError } from '../api/client';

vi.mock('./knowledge-client', () => ({
  knowledgeClient: {
    createEntry: vi.fn()
  }
}));

const createEntry = knowledgeClient.createEntry as ReturnType<typeof vi.fn>;

const detailResponse = {
  kind: 'entry',
  id: 'entry-1',
  entry_type: 'article',
  title: '测试标题',
  excerpt: '摘要',
  tags: [],
  structure_status: 'pending',
  favorite: false,
  pinned: false,
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
  original_text: '正文',
  structured: null,
  outline: null,
  version: 1,
  content_hash: 'h'
};

describe('parseTags', () => {
  it('splits by comma / Chinese comma / ideographic comma / newline', () => {
    expect(parseTags('世界观, 人物、组织\n地点')).toEqual(['世界观', '人物', '组织', '地点']);
  });

  it('trims and dedupes case-insensitively', () => {
    expect(parseTags(' 人物 , 人物 , 人物 ')).toEqual(['人物']);
  });

  it('returns empty for blank input', () => {
    expect(parseTags('  ')).toEqual([]);
  });
});

describe('EntryCreate', () => {
  beforeEach(() => {
    createEntry.mockReset();
  });

  it('disables submit until title and text are filled', async () => {
    render(<EntryCreate scope="global" />);
    const submit = screen.getByRole('button', { name: '录入素材' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('标题'), 'T');
    await userEvent.type(screen.getByLabelText('正文'), 'B');
    expect(submit).toBeEnabled();
  });

  it('submits with scope and text, defaulting type to auto', async () => {
    createEntry.mockResolvedValue(detailResponse);
    render(<EntryCreate scope="global" />);
    await userEvent.type(screen.getByLabelText('标题'), '我的标题');
    await userEvent.type(screen.getByLabelText('正文'), '正文内容');
    await userEvent.click(screen.getByRole('button', { name: '录入素材' }));

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'global',
      text: '正文内容',
      title: '我的标题'
    }));
    expect(createEntry.mock.calls[0]![0]).not.toHaveProperty('entry_type');
  });

  it('includes work_id and entry_type when selected', async () => {
    createEntry.mockResolvedValue(detailResponse);
    render(<EntryCreate scope="work" workId="work-9" />);
    await userEvent.type(screen.getByLabelText('标题'), 'T');
    await userEvent.type(screen.getByLabelText('正文'), 'B');
    await userEvent.click(screen.getByRole('radio', { name: '论文' }));
    await userEvent.click(screen.getByRole('button', { name: '录入素材' }));

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'work',
      work_id: 'work-9',
      entry_type: 'paper'
    }));
  });

  it('includes parsed tags when provided', async () => {
    createEntry.mockResolvedValue(detailResponse);
    render(<EntryCreate scope="global" />);
    await userEvent.type(screen.getByLabelText('标题'), 'T');
    await userEvent.type(screen.getByLabelText('正文'), 'B');
    await userEvent.type(screen.getByLabelText('标签（可选，逗号分隔）'), '世界观, 人物');
    await userEvent.click(screen.getByRole('button', { name: '录入素材' }));

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['世界观', '人物']
    }));
  });

  it('shows an error message on duplicate conflict', async () => {
    createEntry.mockRejectedValue(new ApiError(409, 'KNOWLEDGE_ENTRY_DUPLICATE', '素材已存在', { current_version: 3 }, 'rq'));
    render(<EntryCreate scope="global" />);
    await userEvent.type(screen.getByLabelText('标题'), 'T');
    await userEvent.type(screen.getByLabelText('正文'), 'B');
    await userEvent.click(screen.getByRole('button', { name: '录入素材' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('版本冲突'));
    expect(screen.getByRole('alert')).toHaveTextContent('3');
  });

  it('calls onCreated with the new entry id on success', async () => {
    createEntry.mockResolvedValue(detailResponse);
    const onCreated = vi.fn();
    render(<EntryCreate scope="global" onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText('标题'), 'T');
    await userEvent.type(screen.getByLabelText('正文'), 'B');
    await userEvent.click(screen.getByRole('button', { name: '录入素材' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('entry-1'));
  });

  it('resets the form after successful creation', async () => {
    createEntry.mockResolvedValue(detailResponse);
    render(<EntryCreate scope="global" />);
    await userEvent.type(screen.getByLabelText('标题'), 'T');
    await userEvent.type(screen.getByLabelText('正文'), 'B');
    await userEvent.click(screen.getByRole('button', { name: '录入素材' }));

    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue(''));
    expect(screen.getByLabelText('正文')).toHaveValue('');
  });
});
