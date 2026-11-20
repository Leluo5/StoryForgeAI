import type { ProseMirrorNode } from '@storyforge/contracts';
import { describe, expect, it } from 'vitest';
import { applyOperations, canonicalizeContent, replaceDocumentOperations } from './document';
import { isValidPid } from './pid';
import { markdownToDocument, documentToMarkdown, MarkdownSyntaxError } from './markdown';

describe('markdown conversion', () => {
  it('round-trips supported marks and blocks using JSON at the boundary', () => {
    const source = '# 标题\n\n第一段 **加粗** 与 *强调*。\n\n- 项目一\n- 项目二';
    const document: ProseMirrorNode = markdownToDocument(source);
    expect(document.type).toBe('doc');
    expect(documentToMarkdown(document)).toBe(source);
  });

  it('rejects tables, images and raw HTML with stable source locations', () => {
    expect(() => markdownToDocument('| A | B |\n| - | - |\n| 1 | 2 |')).toThrow(MarkdownSyntaxError);
    expect(() => markdownToDocument('![替代](https://example.com/a.png)')).toThrow(/Line 1, column 1/);
    expect(() => markdownToDocument('ok\n\n<script>alert(1)</script>')).toThrow(/Line 3, column 1/);
  });

  it('creates a ProseMirror replacement from converted JSON', () => {
    const previous = markdownToDocument('旧正文');
    const next = markdownToDocument('新正文');
    expect(canonicalizeContent(applyOperations(previous, replaceDocumentOperations(previous, next)))).toBe(
      canonicalizeContent(next)
    );
  });

  it('assigns pids on import and never writes them back to Markdown', () => {
    const source = '# 标题\n\n第一段';
    const document = markdownToDocument(source);
    const paragraph = document.content?.[1];
    expect(isValidPid(document.content?.[0]?.attrs?.pid)).toBe(true);
    expect(isValidPid(paragraph?.attrs?.pid)).toBe(true);
    expect(documentToMarkdown(document)).toBe(source);
  });
});
