import type { Node } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

// 角色归档标记：只做 DOM 装饰，不写入 editor.state.doc，因此不产生事务、不参与保存。
export interface RoleMark {
  pid: string;
  label: string;
  /** 对应段落锚点 id：Markdown 等价路径「剔除」时回传（装饰层不使用） */
  anchorId?: string;
}

export interface ChapterRoleMarkNotice {
  label: string;
}

export const ROLE_MARK_CLASS = 'role-archived-mark';
export const ROLE_MARK_LABEL_CLASS = 'role-archived-label';

// 与 packages/editor-schema 的 pid.ts 保持一致：只有段落与标题承载块级 pid。
const PID_BLOCK_TYPES = new Set(['paragraph', 'heading']);

export function marksSignature(marks: readonly RoleMark[] | undefined): string {
  return JSON.stringify((marks ?? []).map((mark) => [mark.pid, mark.label]));
}

function createRoleMarkLabel(mark: RoleMark): HTMLElement {
  const label = document.createElement('span');
  label.className = ROLE_MARK_LABEL_CLASS;
  label.dataset.roleMark = mark.pid;
  label.setAttribute('aria-label', mark.label);
  label.textContent = mark.label;
  return label;
}

// 纯函数：按 pid 从当前文档解析位置，产出节点装饰（class）与起始位置标签（widget）。
// 不修改 doc，也不创建 transaction。
export function buildRoleDecorations(doc: Node, marks: readonly RoleMark[] | undefined): DecorationSet {
  if (!marks || marks.length === 0) return DecorationSet.empty;

  const byPid = new Map<string, RoleMark>();
  for (const mark of marks) if (!byPid.has(mark.pid)) byPid.set(mark.pid, mark);
  if (byPid.size === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!PID_BLOCK_TYPES.has(node.type.name)) return true;
    const pid = node.attrs.pid as unknown;
    if (typeof pid !== 'string') return true;
    const mark = byPid.get(pid);
    if (!mark) return true;
    decorations.push(Decoration.node(position, position + node.nodeSize, { class: ROLE_MARK_CLASS }));
    decorations.push(
      Decoration.widget(position + 1, () => createRoleMarkLabel(mark), {
        side: -1,
        // key 含 label：文案变化时重建 widget，避免复用旧 DOM；pid 相同且 label 不变时保持稳定。
        key: `role-mark:${mark.pid}:${mark.label}`
      })
    );
    return true;
  });

  return DecorationSet.create(doc, decorations);
}

// 装饰源：缓存的 DecorationSet 只在 roleMarks 内容变化或文档变化时重算。
// 通过 view.setProps({ decorations }) 触发展示，不 dispatch 任何 transaction。
export class RoleDecorationSource {
  private marks: readonly RoleMark[] = [];
  private signature = marksSignature(undefined);
  private doc: Node | null = null;
  private cached: DecorationSet = DecorationSet.empty;

  // 返回是否真的发生变化；未变化时调用方无需 setProps。
  setMarks(marks: readonly RoleMark[] | undefined): boolean {
    const signature = marksSignature(marks);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.marks = marks ?? [];
    this.doc = null;
    return true;
  }

  readonly decorations = (state: EditorState): DecorationSet => {
    if (this.doc === state.doc) return this.cached;
    this.doc = state.doc;
    this.cached = buildRoleDecorations(state.doc, this.marks);
    return this.cached;
  };
}
