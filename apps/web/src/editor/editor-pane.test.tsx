import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
