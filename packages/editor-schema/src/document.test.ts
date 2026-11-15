import { describe, expect, it } from 'vitest';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import {
  applyOperations,
  canonicalizeDocument,
  createEmptyDocument,
  parseDocument,
  replaceDocumentOperations,
  schema
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
    expect(applyOperations(createEmptyDocument(), operations).toJSON()).toEqual(target);
  });
});

function markdownLikeDocument(text: string) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}
