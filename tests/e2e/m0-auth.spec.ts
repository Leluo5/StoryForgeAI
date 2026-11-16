import { expect, test } from '@playwright/test';
import { e2eEnvironment } from './e2e-env';

test('author can log in, restore a session and log out', async ({ page }, testInfo) => {
  const { authorDisplayName, authorEmail, authorPassword } = e2eEnvironment();

  await page.goto('/');
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  await page.getByLabel('邮箱').fill(authorEmail);
  await page.getByLabel('密码').fill(authorPassword);
  await page.getByRole('button', { name: '登录' }).click();

  await expect(page.getByRole('heading', { name: '作品库' })).toBeVisible();
  await expect(page.getByText(authorDisplayName)).toBeVisible();
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'storyforge_session');
  expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  const visibleCookies = await page.evaluate(() => document.cookie);
  expect(visibleCookies).not.toContain('storyforge_session=');
  expect(visibleCookies).toContain('storyforge_csrf=');

  await page.reload();
  await expect(page.getByRole('heading', { name: '作品库' })).toBeVisible();
  const screenshot = testInfo.outputPath('m0-authenticated.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('m0-authenticated', { path: screenshot, contentType: 'image/png' });

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  // 登出后 session cookie 的清除是服务端 Set-Cookie 响应异步传播到浏览器
  // context，UI 渲染「登录」按钮与 cookie 实际清除存在微小时序差。用
  // expect.poll 等待 cookie 真正被清除，避免偶发断言失败（M1 e2e 脆弱点）。
  await expect
    .poll(async () =>
      (await page.context().cookies()).some((cookie) => cookie.name === 'storyforge_session'),
      { timeout: 10_000 },
    )
    .toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
});
