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
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'storyforge_session')).toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
});
