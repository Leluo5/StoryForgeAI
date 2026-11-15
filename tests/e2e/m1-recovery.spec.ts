import { expect, test, chromium } from '@playwright/test';
import {
  chapterUrl,
  crashBrowser,
  expectSaveStatus,
  getServerChapter,
  login,
  loginAndOpenChapter,
  readLocalState
} from './m1-helpers';

test.setTimeout(90_000);

test('pending IndexedDB change survives a real browser crash and synchronizes after restart', async ({}, testInfo) => {
  const baseURL = 'http://127.0.0.1:5173';
  const profile = testInfo.outputPath('chromium-profile');
  let context = await chromium.launchPersistentContext(profile, { baseURL, headless: true });
  let page = context.pages()[0] ?? await context.newPage();
  const location = await loginAndOpenChapter(page, `M1 崩溃恢复 ${Date.now()}`);

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => { markFirstRequest = resolve; });
  await page.route('**/changes', async (route) => {
    markFirstRequest();
    await firstGate;
    await route.continue();
  });
  await page.locator('.ProseMirror').fill('浏览器崩溃前已落盘');
  await firstRequest;
  expect((await readLocalState(page, location)).changes).toHaveLength(1);
  expect((await getServerChapter(page, location)).version).toBe(0);

  const browser = context.browser();
  expect(browser).not.toBeNull();
  await crashBrowser(browser!);
  expect(browser!.isConnected()).toBe(false);
  releaseFirst();

  context = await chromium.launchPersistentContext(profile, { baseURL, headless: true });
  page = context.pages()[0] ?? await context.newPage();
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let markSecondRequest!: () => void;
  const secondRequest = new Promise<void>((resolve) => { markSecondRequest = resolve; });
  await page.route('**/changes', async (route) => {
    markSecondRequest();
    await secondGate;
    await route.continue();
  });
  await login(page);
  await page.goto(chapterUrl(location.workId, location.chapterId));
  await expect(page.locator('.ProseMirror')).toContainText('浏览器崩溃前已落盘');
  await secondRequest;
  await expectSaveStatus(page, '云端同步中');
  expect((await readLocalState(page, location)).changes).toHaveLength(1);
  releaseSecond();
  await expectSaveStatus(page, '已同步');
  expect((await readLocalState(page, location)).changes).toHaveLength(0);
  expect((await getServerChapter(page, location)).document).toMatchObject({
    content: [{ content: [{ text: '浏览器崩溃前已落盘' }] }]
  });
  await context.close();
});
