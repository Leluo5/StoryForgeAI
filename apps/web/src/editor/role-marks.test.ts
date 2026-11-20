import { parseDocument } from '@storyforge/editor-schema';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { RoleDecorationSource, buildRoleDecorations, marksSignature } from './role-marks';

const PID_A = '11111111-1111-4111-8111-111111111111';
const PID_B = '22222222-2222-4222-8222-222222222222';

function blockDocument() {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { pid: PID_A }, content: [{ type: 'text', text: '林墨登场' }] },
      { type: 'heading', attrs: { level: 2, pid: PID_B }, content: [{ type: 'text', text: '旁白' }] }
    ]
  };
}

describe('role marks decorations', () => {
  it('resolves paragraph pids into one node decoration and one widget decoration', () => {
    const doc = parseDocument(blockDocument());
    const before = doc.toJSON();

    const set = buildRoleDecorations(doc, [{ pid: PID_A, label: '林墨（已归档）' }]);
    const found = set.find();

    expect(found).toHaveLength(2);
    // 节点装饰覆盖整段；widget 装饰落在段落起始（第一段从 0 开始，故 widget 在 1）
    const nodeDecoration = found.find((decoration) => decoration.from === 0);
    expect(nodeDecoration).toBeDefined();
    expect(nodeDecoration?.to).toBe(doc.child(0).nodeSize);

    const widget = found.find((decoration) => String(decoration.spec?.key ?? '').startsWith('role-mark:'));
    expect(widget).toBeDefined();
    expect(widget?.from).toBe(1);
    expect(String(widget?.spec.key)).toContain('林墨（已归档）');
    // 纯函数不得改动文档：装饰不进入 state.doc
    expect(doc.toJSON()).toEqual(before);
  });

  it('ignores pids that are not present in the document', () => {
    const doc = parseDocument(blockDocument());
    expect(buildRoleDecorations(doc, [{ pid: PID_B + '0', label: '不存在' }]).find()).toHaveLength(0);
    expect(buildRoleDecorations(doc, []).find()).toHaveLength(0);
    expect(buildRoleDecorations(doc, undefined).find()).toHaveLength(0);
  });

  it('rebuilds decorations when marks or the document change and caches otherwise', () => {
    const doc = parseDocument(blockDocument());
    const source = new RoleDecorationSource();

    expect(source.setMarks(undefined)).toBe(false);
    expect(source.setMarks([{ pid: PID_A, label: '林墨（已归档）' }])).toBe(true);
    expect(source.setMarks([{ pid: PID_A, label: '林墨（已归档）' }])).toBe(false);

    const state = EditorState.create({ doc });
    const first = source.decorations(state);
    expect(source.decorations(state)).toBe(first);
    expect(first.find()).toHaveLength(2);

    source.setMarks([{ pid: PID_A, label: '林墨（已恢复）' }]);
    const second = source.decorations(state);
    expect(second).not.toBe(first);
    expect(second.find().some((decoration) => String(decoration.spec?.key ?? '').includes('林墨（已恢复）'))).toBe(true);

    const nextState = EditorState.create({ doc: parseDocument(blockDocument()) });
    expect(source.decorations(nextState)).not.toBe(second);
  });

  it('builds a stable signature regardless of array identity', () => {
    expect(marksSignature([{ pid: PID_A, label: 'A' }])).toBe(marksSignature([{ pid: PID_A, label: 'A' }]));
    expect(marksSignature([{ pid: PID_A, label: 'A' }])).not.toBe(marksSignature([{ pid: PID_A, label: 'B' }]));
  });
});
