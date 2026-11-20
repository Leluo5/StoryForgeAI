import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProseMirrorNode } from '@storyforge/contracts';
import { createEmptyDocument } from '@storyforge/editor-schema';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorPane } from './editor-pane';

beforeAll(() => {
  Range.prototype.getClientRects = (): DOMRectList => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator]
  }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

describe('EditorPane', () => {
  it('keeps invalid Markdown source and the last valid document', async () => {
    const onDocument = vi.fn();
    render(<EditorPane initialDocument={createEmptyDocument()} readOnly={false}
      onDocument={onDocument} onMarkdownDraft={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    const source = screen.getByLabelText('Markdown 正文');
    await userEvent.type(source, '<script>alert(1)</script>');
    await userEvent.click(screen.getByRole('button', { name: '富文本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Line 1, column 1');
    expect(source).toHaveValue('<script>alert(1)</script>');
    expect(onDocument).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Markdown 正文')).toBeVisible();
  });

  it('uses a non-editable ProseMirror view in read-only mode', async () => {
    const { container } = render(<EditorPane initialDocument={createEmptyDocument()} readOnly
      onDocument={vi.fn()} onMarkdownDraft={vi.fn().mockResolvedValue(undefined)} />);
    expect(container.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
  });
});

const PID_A = '11111111-1111-4111-8111-111111111111';
const PID_B = '22222222-2222-4222-8222-222222222222';

function roleDocument(): ProseMirrorNode {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { pid: PID_A }, content: [{ type: 'text', text: '林墨登场' }] },
      { type: 'paragraph', attrs: { pid: PID_B }, content: [{ type: 'text', text: '旁白' }] }
    ]
  };
}

function renderPane(options: {
  readOnly?: boolean;
  roleMarks?: Array<{ pid: string; label: string }>;
  chapterMarks?: Array<{ label: string }>;
  onDismissMark?: (mark: { pid: string; label: string }) => void;
  onDocument?: ReturnType<typeof vi.fn>;
}) {
  return render(<EditorPane initialDocument={roleDocument()} readOnly={options.readOnly ?? false}
    onDocument={options.onDocument ?? vi.fn()} onMarkdownDraft={vi.fn().mockResolvedValue(undefined)}
    roleMarks={options.roleMarks} chapterMarks={options.chapterMarks} onDismissMark={options.onDismissMark} />);
}

describe('EditorPane role marks', () => {
  it('draws paragraph decorations and labels without producing document changes', () => {
    const onDocument = vi.fn();
    const { container } = renderPane({ roleMarks: [{ pid: PID_A, label: '林墨（已归档）' }], onDocument });

    const marked = container.querySelectorAll('.ProseMirror .role-archived-mark');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent('林墨登场');
    const widget = container.querySelector(`[data-role-mark="${PID_A}"]`);
    expect(widget).not.toBeNull();
    expect(widget).toHaveAttribute('aria-label', '林墨（已归档）');
    expect(widget).toHaveTextContent('林墨（已归档）');
    expect(container.querySelector(`[data-role-mark="${PID_B}"]`)).toBeNull();
    // 装饰不产生 transaction，因此 onDocument 一次都不应被调用
    expect(onDocument).not.toHaveBeenCalled();
  });

  it('recomputes decorations on prop changes without recreating paragraph DOM', () => {
    const onDocument = vi.fn();
    const { container, rerender } = renderPane({ roleMarks: [{ pid: PID_A, label: '林墨（已归档）' }], onDocument });
    const firstParagraph = container.querySelector('.ProseMirror > p');
    const firstWidget = container.querySelector(`[data-role-mark="${PID_A}"]`);
    expect(firstParagraph).not.toBeNull();
    expect(firstWidget).not.toBeNull();

    rerender(<EditorPane initialDocument={roleDocument()} readOnly={false} onDocument={onDocument}
      onMarkdownDraft={vi.fn().mockResolvedValue(undefined)}
      roleMarks={[{ pid: PID_B, label: '苏晚（已归档）' }]} />);

    expect(container.querySelector('.ProseMirror > p')).toBe(firstParagraph);
    expect(container.querySelectorAll('.ProseMirror .role-archived-mark')).toHaveLength(1);
    expect(firstParagraph).not.toHaveClass('role-archived-mark');
    expect(container.querySelectorAll('.ProseMirror > p')[1]).toHaveClass('role-archived-mark');
    expect(firstWidget?.isConnected).toBe(false);
    expect(container.querySelector(`[data-role-mark="${PID_A}"]`)).toBeNull();
    expect(container.querySelector(`[data-role-mark="${PID_B}"]`)).toHaveTextContent('苏晚（已归档）');
    expect(onDocument).not.toHaveBeenCalled();
  });

  it('does not reset the editor when an external document only changes pids', () => {
    const { container, rerender } = renderPane({});
    const paragraph = container.querySelector('.ProseMirror > p');
    rerender(<EditorPane initialDocument={{
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { pid: '33333333-3333-4333-8333-333333333333' }, content: [{ type: 'text', text: '林墨登场' }] },
        { type: 'paragraph', attrs: { pid: PID_B }, content: [{ type: 'text', text: '旁白' }] }
      ]
    }} readOnly={false} onDocument={vi.fn()} onMarkdownDraft={vi.fn().mockResolvedValue(undefined)} />);

    expect(container.querySelector('.ProseMirror > p')).toBe(paragraph);
  });

  it('keeps decorations visible in read-only mode', () => {
    const { container } = renderPane({ readOnly: true, roleMarks: [{ pid: PID_A, label: '林墨（已归档）' }] });
    expect(container.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    expect(container.querySelector('.ProseMirror .role-archived-mark')).not.toBeNull();
    expect(container.querySelector(`[data-role-mark="${PID_A}"]`)).not.toBeNull();
  });

  it('renders the chapter notice as a dismissible status without touching the document', async () => {
    const onDocument = vi.fn();
    const { container } = renderPane({
      chapterMarks: [{ label: '关联角色已归档（原文已修改）' }],
      onDocument
    });
    const paragraph = container.querySelector('.ProseMirror > p');
    expect(screen.getByRole('status')).toHaveTextContent('关联角色已归档（原文已修改）');

    await userEvent.click(screen.getByRole('button', { name: '关闭提示：关联角色已归档（原文已修改）' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('.ProseMirror > p')).toBe(paragraph);
    expect(onDocument).not.toHaveBeenCalled();
  });

  it('lists marked paragraphs in Markdown mode and dismisses them through the callback', async () => {
    const onDismissMark = vi.fn();
    const onDocument = vi.fn();
    renderPane({ roleMarks: [{ pid: PID_A, label: '林墨（已归档）' }], onDismissMark, onDocument });

    await userEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    expect(screen.getByRole('heading', { name: '本章命中段落' })).toBeInTheDocument();
    expect(screen.getByText('林墨（已归档）')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '剔除' }));
    expect(onDismissMark).toHaveBeenCalledWith({ pid: PID_A, label: '林墨（已归档）' });
    expect(screen.queryByText('林墨（已归档）')).toBeNull();
    expect(onDocument).not.toHaveBeenCalled();
  });

  it('does not render the Markdown hit list when there are no role marks', async () => {
    renderPane({});
    await userEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    expect(screen.queryByText('本章命中段落')).toBeNull();
    expect(screen.getByLabelText('Markdown 正文')).toBeVisible();
  });
});
