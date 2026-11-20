import { describe, expect, it } from 'vitest';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import {
  applyOperations,
  canonicalizeContent,
  canonicalizeDocument,
  createEmptyDocument,
  parseDocument,
  replaceDocumentOperations,
  schema,
  stripPidAttributes
} from './index';

const insert = new ReplaceStep(1, 1, new Slice(Fragment.from(schema.text('你')), 0, 0)).toJSON();

describe('editor schema', () => {
  it('applies serializable steps and canonicalizes key order', () => {
    const next = applyOperations(createEmptyDocument(), [insert]);
    expect(next.textContent).toBe('你');
    expect(canonicalizeDocument(next)).toBe(canonicalizeDocument(JSON.parse(JSON.stringify(next))));
  });

  it('rejects unsafe links and invalid positions', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('bad', [schema.mark('link', { href: 'javascript:alert(1)' })])
      ])
    ]);
    expect(() => parseDocument(doc.toJSON())).toThrow('Unsafe link');
    expect(() => applyOperations(createEmptyDocument(), [{ stepType: 'replace', from: 999, to: 1000 }])).toThrow();
  });

  it('creates a valid whole-document replacement', () => {
    const target = markdownLikeDocument('新正文');
    const operations = replaceDocumentOperations(createEmptyDocument(), target);
    expect(stripPidAttributes(applyOperations(createEmptyDocument(), operations).toJSON())).toEqual(target);
  });

  it('ignores paragraph pids when canonicalizing content', () => {
    const withoutPid = markdownLikeDocument('正文');
    const withNullPid = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { pid: null }, content: [{ type: 'text', text: '正文' }] }]
    };
    const withPid = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { pid: '64b314d2-c61f-4782-8640-9f6c020a5c59' },
          content: [{ type: 'text', text: '正文' }]
        }
      ]
    };
    expect(canonicalizeContent(withoutPid)).toBe(canonicalizeContent(withNullPid));
    expect(canonicalizeContent(withoutPid)).toBe(canonicalizeContent(withPid));
    expect(canonicalizeContent(markdownLikeDocument('正文改'))).not.toBe(canonicalizeContent(withoutPid));
  });

  it('rejects documents with malformed pids', () => {
    const malformed = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { pid: 'not-a-uuid' }, content: [{ type: 'text', text: '正文' }] }]
    };
    expect(() => parseDocument(malformed)).toThrow('Invalid document pid');
  });

  it('preserves pids for unchanged paragraphs during whole-document replacement', () => {
    const pid = '64b314d2-c61f-4782-8640-9f6c020a5c59';
    const base = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { pid }, content: [{ type: 'text', text: '正文' }] }]
    };
    const target = markdownLikeDocument('正文');
    const applied = applyOperations(base, replaceDocumentOperations(base, target));
    expect(applied.firstChild?.attrs.pid).toBe(pid);
    expect(canonicalizeContent(applied)).toBe(canonicalizeContent(target));
  });
});

function markdownLikeDocument(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}
