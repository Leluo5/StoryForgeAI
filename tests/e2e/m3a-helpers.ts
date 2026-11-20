/**
 * M3a E2E 辅助：CSRF 提取与 AI 面板交互封装。
 */
import { expect, type Page } from '@playwright/test';

/** 从页面 Cookie 中提取 CSRF token（服务端在登录时设置 storyforge_csrf） */
export async function csrfTokenFromPage(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'storyforge_csrf');
  expect(csrf, 'storyforge_csrf cookie 应存在（已登录会话）').toBeTruthy();
  return csrf!.value;
}

/** 打开 AI 创作面板（深链或点击 tab） */
export async function openAiPanel(page: Page, workId: string, chapterId: string): Promise<void> {
  await page.goto(`/works/${workId}/write/${chapterId}?panel=ai`);
  await expect(page.getByRole('tab', { name: 'AI 创作' })).toBeVisible();
}

/**
 * 处理版本冲突弹窗（初始化/加载时本地基准 vs 服务端版本不一致）。
 * postServerText 已把服务端版本推到 N+1，前端重载时基准落后 → 弹「版本冲突」。
 * 采用服务端版本（最新），避免模态拦截后续 tab 点击。弹窗出现时机不定，短窗口探测，未出现则继续。
 */
export async function resolveVersionConflictIfPresent(page: Page): Promise<void> {
  const useServer = page.getByRole('button', { name: '使用服务端' });
  try {
    // 弹窗异步出现：给 4s 窗口，出现则点「使用服务端」；未出现视为无冲突
    await useServer.waitFor({ state: 'visible', timeout: 4_000 });
    await useServer.click();
    await page.getByRole('dialog', { name: '版本冲突' }).waitFor({ state: 'hidden', timeout: 15_000 });
  } catch {
    // 未出现版本冲突弹窗：正常继续
  }
}

/** 断言任务列表出现指定状态徽章 */
export async function expectTaskStatus(page: Page, status: string): Promise<void> {
  await expect(page.getByText(status, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
}