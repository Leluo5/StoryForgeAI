import { expect, type Page } from '@playwright/test';
import { loginAndOpenChapter, type ChapterLocation } from './m1-helpers';

export type M2Location = ChapterLocation;

export { loginAndOpenChapter };

/** 切换到右侧指定面板 Tab（桌面视图右侧栏常驻 Tab）。 */
export async function openPanel(page: Page, name: '章节信息' | '修订' | '版本' | '评论' | '待办'): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click();
}

/** 等待面板内某文本可见（仅匹配当前可见面板，过滤掉 hidden 子树中同名文本，如 AI 创作标题）。 */
export async function expectPanelText(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 });
}
