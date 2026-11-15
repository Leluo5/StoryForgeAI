import { proseMirrorDocumentSchema, type ProseMirrorNode } from '@storyforge/contracts';
import { Fragment, Node, Slice } from 'prosemirror-model';
import { ReplaceStep, Step } from 'prosemirror-transform';
import { schema } from './schema';

export function createEmptyDocument(): ProseMirrorNode {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

export function assertSafeDocument(doc: Node): void {
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'link') {
        const href = String(mark.attrs.href ?? '');
        if (!/^(https?:|mailto:)/i.test(href)) throw new Error('Unsafe link protocol');
      }
    }
    return true;
  });
}

export function parseDocument(value: unknown): Node {
  const json = proseMirrorDocumentSchema.parse(value);
  const doc = Node.fromJSON(schema, json);
  assertSafeDocument(doc);
  doc.check();
  return doc;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)])
    );
  }
  return value;
}

export function canonicalizeDocument(value: unknown): string {
  const json = value instanceof Node ? value.toJSON() : value;
  return JSON.stringify(stable(parseDocument(json).toJSON()));
}

export function applyOperations(document: unknown, operations: Array<Record<string, unknown>>): Node {
  let doc = parseDocument(document);
  for (const operation of operations) {
    const result = Step.fromJSON(schema, operation).apply(doc);
    if (!result.doc || result.failed) {
      throw new Error(`Invalid ProseMirror step: ${result.failed ?? 'unknown failure'}`);
    }
    doc = result.doc;
    assertSafeDocument(doc);
  }
  doc.check();
  return doc;
}

export function replaceDocumentOperations(document: unknown, replacement: unknown): Array<Record<string, unknown>> {
  const current = parseDocument(document);
  const next = parseDocument(replacement);
  const operation = new ReplaceStep(0, current.content.size, new Slice(Fragment.from(next.content), 0, 0)).toJSON();
  const applied = applyOperations(current.toJSON(), [operation]);
  if (canonicalizeDocument(applied) !== canonicalizeDocument(next)) {
    throw new Error('Whole-document replacement did not produce the requested document');
  }
  return [operation];
}
