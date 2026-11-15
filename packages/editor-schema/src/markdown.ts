import type { ProseMirrorNode } from '@storyforge/contracts';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { defaultMarkdownParser, defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown';
import { parseDocument } from './document';

export class MarkdownSyntaxError extends Error {
  constructor(message: string, public readonly line: number, public readonly column: number) {
    super(`Line ${line}, column ${column}: ${message}`);
    this.name = 'MarkdownSyntaxError';
  }
}

const validator = new MarkdownIt({ html: true, linkify: false });
const allowed = new Set([
  'paragraph_open', 'paragraph_close', 'inline', 'text', 'softbreak', 'hardbreak',
  'heading_open', 'heading_close', 'bullet_list_open', 'bullet_list_close',
  'ordered_list_open', 'ordered_list_close', 'list_item_open', 'list_item_close',
  'blockquote_open', 'blockquote_close', 'code_block', 'fence', 'hr',
  'em_open', 'em_close', 'strong_open', 'strong_close', 'code_inline', 'link_open', 'link_close'
]);

function scan(tokens: Token[], sourceLines: string[]): void {
  for (const token of tokens) {
    if (!allowed.has(token.type)) {
      const line = (token.map?.[0] ?? 0) + 1;
      const column = (sourceLines[line - 1]?.search(/\S|$/) ?? 0) + 1;
      throw new MarkdownSyntaxError(`Unsupported Markdown token ${token.type}`, line, column);
    }
    if (token.children) scan(token.children, sourceLines);
  }
}

export function markdownToDocument(source: string): ProseMirrorNode {
  scan(validator.parse(source, {}), source.split('\n'));
  const parsed = defaultMarkdownParser.parse(source);
  if (!parsed) throw new MarkdownSyntaxError('Markdown parser returned no document', 1, 1);
  return parseDocument(parsed.toJSON()).toJSON() as ProseMirrorNode;
}

// 统一输出 "- " 无序列表，保证双模式往返一致
const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node) {
      state.renderList(node, '  ', () => '- ');
    }
  },
  defaultMarkdownSerializer.marks
);

export function documentToMarkdown(document: unknown): string {
  return serializer.serialize(parseDocument(document)).trimEnd();
}
