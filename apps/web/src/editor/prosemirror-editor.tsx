import type { ProseMirrorNode } from '@storyforge/contracts';
import { canonicalizeDocument, parseDocument, schema } from '@storyforge/editor-schema';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useEffect, useRef } from 'react';
import 'prosemirror-view/style/prosemirror.css';

interface Props {
  initialDocument: ProseMirrorNode;
  readOnly: boolean;
  onDocument(operations: Array<Record<string, unknown>>, document: ProseMirrorNode): void;
}

export function ProseMirrorEditor({ initialDocument, readOnly, onDocument }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const callback = useRef(onDocument);
  callback.current = onDocument;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: parseDocument(initialDocument),
      plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }), keymap(baseKeymap)]
    });
    const editor = new EditorView(host.current, {
      state,
      editable: () => !readOnly,
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

  useEffect(() => { view.current?.setProps({ editable: () => !readOnly }); }, [readOnly]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const next = parseDocument(initialDocument);
    if (canonicalizeDocument(editor.state.doc.toJSON()) === canonicalizeDocument(next.toJSON())) return;
    editor.updateState(EditorState.create({ doc: next, plugins: editor.state.plugins }));
  }, [initialDocument]);
  return <div ref={host} aria-label="富文本正文" />;
}
