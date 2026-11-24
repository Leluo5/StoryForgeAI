// ============================================================================
// M3c-3 知识库 · 键盘与 axe 无障碍工具（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/03-任务规划.md T35 完成标准
//
// 覆盖：
//   - 页签左右方向键循环切换（ArrowRight / ArrowLeft）
//   - Esc 关闭弹层判定
//   - 列表 Enter 打开详情、Delete 触发删除确认
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  isEscapeKey,
  moveTabIndex,
  isOpenDetailKey,
  isDeleteKey
} from './knowledge-a11y';

describe('knowledge-a11y', () => {
  describe('moveTabIndex', () => {
    it('moves right and wraps to 0', () => {
      expect(moveTabIndex(2, 3, 'ArrowRight')).toBe(0);
      expect(moveTabIndex(0, 3, 'ArrowRight')).toBe(1);
    });

    it('moves left and wraps to last', () => {
      expect(moveTabIndex(0, 3, 'ArrowLeft')).toBe(2);
      expect(moveTabIndex(2, 3, 'ArrowLeft')).toBe(1);
    });

    it('returns current for non-arrow keys', () => {
      expect(moveTabIndex(1, 3, 'Home')).toBe(1);
    });
  });

  describe('isEscapeKey', () => {
    it('detects Escape', () => {
      expect(isEscapeKey('Escape')).toBe(true);
      expect(isEscapeKey('Enter')).toBe(false);
    });
  });

  describe('isOpenDetailKey', () => {
    it('detects Enter', () => {
      expect(isOpenDetailKey('Enter')).toBe(true);
      expect(isOpenDetailKey('a')).toBe(false);
    });
  });

  describe('isDeleteKey', () => {
    it('detects Delete', () => {
      expect(isDeleteKey('Delete')).toBe(true);
      expect(isDeleteKey('Backspace')).toBe(false);
    });
  });
});
