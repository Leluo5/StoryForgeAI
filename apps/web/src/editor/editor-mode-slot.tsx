import { createContext, useContext } from 'react';

/**
 * 编辑模式切换控件（富文本 / Markdown）的外部挂载点。
 * 工作台页头提供容器 DOM，正文编辑器把切换按钮 portal 到该容器（需求三：移到返回作品库下方、右对齐），
 * 模式状态仍由 EditorPane 持有，不跨组件搬运。未提供挂载点时按原位置内联渲染。
 */
export const EditorModeSlotContext = createContext<HTMLDivElement | null>(null);

/** 读取当前生效的外部挂载容器；未提供时返回 null，调用方按内联渲染处理 */
export function useEditorModeSlot(): HTMLDivElement | null {
  return useContext(EditorModeSlotContext);
}