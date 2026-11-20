import type { ProseMirrorNode } from '@storyforge/contracts';
import { canonicalizeContent, parseDocument } from '@storyforge/editor-schema';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useEffect, useRef, useState } from 'react';
import 'prosemirror-view/style/prosemirror.css';
import { RoleDecorationSource, marksSignature, type ChapterRoleMarkNotice, type RoleMark } from './role-marks';

export interface ProseMirrorEditorProps {
  initialDocument: ProseMirrorNode;
  readOnly: boolean;
  onDocument(operations: Array<Record<string, unknown>>, document: ProseMirrorNode): void;
  roleMarks?: RoleMark[] | undefined;
  chapterMarks?: ChapterRoleMarkNotice[] | undefined;
  onDismissMark?: ((mark: RoleMark) => void) | undefined;
}

export function ProseMirrorEditor({ initialDocument, readOnly, onDocument, roleMarks, chapterMarks }: ProseMirrorEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const callback = useRef(onDocument);
  callback.current = onDocument;

  // 装饰源常驻；React 重渲染不会重建 EditorState，也不会产生 transaction。
  const decorationSource = useRef<RoleDecorationSource | undefined>(undefined);
  if (!decorationSource.current) decorationSource.current = new RoleDecorationSource();
  const marksRef = useRef(roleMarks);
  marksRef.current = roleMarks;
  const signature = marksSignature(roleMarks);

  const [dismissedNotices, setDismissedNotices] = useState<string[]>([]);
  const notices = (chapterMarks ?? [])
    .map((notice, index) => ({ key: `${index}:${notice.label}`, label: notice.label }))
    .filter((notice) => !dismissedNotices.includes(notice.key));

  useEffect(() => {
    if (!host.current) return;
    const source = decorationSource.current;
    if (!source) return;
    source.setMarks(marksRef.current);
    const state = EditorState.create({
      doc: parseDocument(initialDocument),
      plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }), keymap(baseKeymap)]
    });
    const editor = new EditorView(host.current, {
      state,
      editable: () => !readOnly,
      decorations: source.decorations,
      dispatchTransaction(transaction) {
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        if (transaction.docChanged) {
          callback.current(transaction.steps.map((step) => step.toJSON()), next.doc.toJSON() as ProseMirrorNode);
        }
      }
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
  }, []);

  // roleMarks 变化时只刷新装饰（setProps），不触发 dispatch、不重建文档。
  useEffect(() => {
    const source = decorationSource.current;
    if (!source) return;
    if (!source.setMarks(roleMarks)) return;
    view.current?.setProps({ decorations: source.decorations });
  }, [signature]);

  useEffect(() => { view.current?.setProps({ editable: () => !readOnly }); }, [readOnly]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const next = parseDocument(initialDocument);
    // 仅 pid 变化不重置 EditorState，避免丢光标；正文变化仍正常同步
    if (canonicalizeContent(editor.state.doc.toJSON()) === canonicalizeContent(next.toJSON())) return;
    editor.updateState(EditorState.create({ doc: next, plugins: editor.state.plugins }));
  }, [initialDocument]);

  return (
    <div className="role-mark-editor">
      {notices.length > 0 ? (
        <div role="status" className="role-mark-notice" aria-label="归档角色提示">
          {notices.map((notice) => (
            <p key={notice.key} className="role-mark-notice-item">
              <span>{notice.label}</span>
              <button
                type="button"
                aria-label={`关闭提示：${notice.label}`}
                onClick={() => setDismissedNotices((dismissed) => [...dismissed, notice.key])}
              >
                关闭
              </button>
            </p>
          ))}
        </div>
      ) : null}
      {/* contenteditable 的通用容器必须带 textbox 角色，aria-label 才合法 */}
      <div ref={host} role="textbox" aria-multiline="true" aria-label="富文本正文" />
    </div>
  );
}
