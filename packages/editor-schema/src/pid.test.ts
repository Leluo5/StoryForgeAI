import { describe, expect, it } from 'vitest';
import { parseDocument } from './document';
import { ensurePids, isValidPid, newPid, preservePids, schema, validateDocumentPids } from './index';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function text(value: string) {
  return value ? schema.text(value) : undefined;
}

function paragraph(value = '', pid: string | null = null) {
  return schema.node('paragraph', { pid }, text(value));
}

function heading(value: string, pid: string | null = null) {
  return schema.node('heading', { level: 2, pid }, text(value));
}

function doc(...children: ReturnType<typeof paragraph>[]) {
  return schema.node('doc', null, children);
}

describe('paragraph pid', () => {
  it('generates lowercase uuid v4', () => {
    const pid = newPid();
    expect(UUID_V4.test(pid)).toBe(true);
    expect(pid).toBe(pid.toLowerCase());
    expect(isValidPid(pid)).toBe(true);
  });

  it('declares pid on paragraph and heading while keeping heading level', () => {
    expect(paragraph().attrs.pid).toBeNull();
    expect(heading('标题').attrs).toEqual({ level: 2, pid: null });
  });

  it('fills missing pids and keeps existing pids idempotently', () => {
    const first = newPid();
    const ensured = ensurePids(doc(paragraph('第一段', first), paragraph('第二段'), heading('标题')));
    const collected: string[] = [];
    ensured.descendants((node) => {
      if (node.type.name === 'paragraph' || node.type.name === 'heading') collected.push(String(node.attrs.pid));
      return true;
    });
    expect(collected).toHaveLength(3);
    expect(collected[0]).toBe(first);
    expect(new Set(collected).size).toBe(3);
    collected.forEach((pid) => expect(isValidPid(pid)).toBe(true));
    expect(ensurePids(ensured).toJSON()).toEqual(ensured.toJSON());
  });

  it('keeps the first half pid and assigns a new pid on split', () => {
    const first = newPid();
    const ensured = ensurePids(doc(paragraph('前半', first), paragraph('后半')));
    const pids: string[] = [];
    ensured.descendants((node) => {
      if (node.type.name === 'paragraph') pids.push(String(node.attrs.pid));
      return true;
    });
    expect(pids[0]).toBe(first);
    expect(isValidPid(pids[1])).toBe(true);
    expect(pids[1]).not.toBe(first);
  });

  it('reuses the surviving paragraph pid on merge', () => {
    const first = newPid();
    const second = newPid();
    const base = doc(paragraph('前半', first), paragraph('后半', second));
    const merged = preservePids(base, doc(paragraph('前半')));
    expect(merged.toJSON()).toEqual(doc(paragraph('前半', first)).toJSON());
  });

  it('assigns pids only to pasted paragraphs without pid', () => {
    const existing = newPid();
    const ensured = ensurePids(doc(paragraph('原文', existing), paragraph('粘贴内容')));
    const pids: string[] = [];
    ensured.descendants((node) => {
      if (node.type.name === 'paragraph') pids.push(String(node.attrs.pid));
      return true;
    });
    expect(pids[0]).toBe(existing);
    expect(isValidPid(pids[1])).toBe(true);
  });

  it('keeps pids restored by undo and redo instead of regenerating', () => {
    const restored = newPid();
    const afterUndo = doc(paragraph('原文', restored));
    expect(ensurePids(afterUndo).toJSON()).toEqual(afterUndo.toJSON());
  });

  it('reports invalid and duplicated pids', () => {
    const duplicate = newPid();
    const result = validateDocumentPids(
      doc(paragraph('甲', duplicate), paragraph('乙', duplicate), paragraph('丙', 'not-a-uuid'))
    );
    expect(result.duplicates).toEqual([{ pid: duplicate, count: 2 }]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.pid).toBe('not-a-uuid');
  });

  it('parses legacy documents without pids', () => {
    const legacy = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧正文' }] }] };
    expect(() => parseDocument(legacy)).not.toThrow();
    expect(parseDocument(legacy).attrs).toEqual({});
  });

  it('preserves unchanged paragraph pids across whole-document replacement', () => {
    const first = newPid();
    const second = newPid();
    const base = doc(paragraph('第一段', first), paragraph('第二段', second));
    const candidate = doc(paragraph('第一段'), paragraph('新增段'), paragraph('第二段'));
    const preserved = preservePids(base, candidate);
    const pids: string[] = [];
    preserved.descendants((node) => {
      if (node.type.name === 'paragraph') pids.push(String(node.attrs.pid));
      return true;
    });
    expect(pids[0]).toBe(first);
    expect(pids[2]).toBe(second);
    expect(isValidPid(pids[1])).toBe(true);
    expect(pids[1]).not.toBe(first);
  });
});

describe('ensurePids on empty document', () => {
  it('assigns a pid to the initial paragraph', () => {
    const ensured = ensurePids(doc(paragraph()));
    expect(isValidPid(ensured.firstChild?.attrs.pid)).toBe(true);
  });
});
