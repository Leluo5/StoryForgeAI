// ============================================================================
// M3c-3 知识库 · 键盘与 axe 无障碍工具（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §6.6
//
// 职责：提供页签左右方向键循环切换、Esc 关闭弹层、列表 Enter 打开详情 /
//       Delete 触发删除确认的纯函数判定，供各面板与 E2E axe 校验复用。
// ============================================================================

/**
 * 页签左右方向键循环切换：返回下一个 tab 的索引。
 * ArrowRight → 前进并回绕到 0；ArrowLeft → 后退并回绕到末位；
 * 其他键 → 返回当前索引不变。
 */
export function moveTabIndex(current: number, count: number, key: string): number {
  if (count <= 0) return current;
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  return current;
}

/** Esc 关闭弹层判定。 */
export function isEscapeKey(key: string): boolean {
  return key === 'Escape';
}

/** 列表 Enter 打开详情判定。 */
export function isOpenDetailKey(key: string): boolean {
  return key === 'Enter';
}

/** 列表 Delete 触发删除确认判定（Backspace 不触发，避免误删）。 */
export function isDeleteKey(key: string): boolean {
  return key === 'Delete';
}
