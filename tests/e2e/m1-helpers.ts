import { expect, type Browser, type Page } from '@playwright/test';
import {
  chapterSchema,
  saveChangeResponseSchema,
  type Chapter,
  type ProseMirrorNode,
  type SaveChangeResponse
} from '@storyforge/contracts';
import { createEmptyDocument, replaceDocumentOperations } from '@storyforge/editor-schema';
import { e2eEnvironment } from './e2e-env';

export interface ChapterLocation {
  workId: string;
  chapterId: string;
}

interface SnapshotState {
  work_id: string;
  chapter_id: string;
  document: ProseMirrorNode;
  server_version: number;
  content_hash: string;
}
interface ChangeState {
  change_id: string;
  work_id: string;
  chapter_id: string;
  base_version: number;
}
interface LeaseState {
  chapter_id: string;
  owner_id: string;
  fencing_token: number;
  expires_at: number;
}
interface ConflictState {
  id: string;
  work_id: string;
  chapter_id: string;
  base_version: number;
  server_version: number;
  local_document: ProseMirrorNode;
}
interface MarkdownState { chapter_id: string; source: string; updated_at: string }

export interface LocalWritingState {
  snapshot?: SnapshotState;
  changes: ChangeState[];
  leases: LeaseState[];
  conflicts: ConflictState[];
  markdown?: MarkdownState;
}

export function chapterUrl(workId: string, chapterId: string): string {
  return `/works/${encodeURIComponent(workId)}/write/${encodeURIComponent(chapterId)}?tab=manuscript&panel=chapter`;
}

function locationFromUrl(value: string): ChapterLocation {
  const match = new URL(value).pathname.match(/^\/works\/([^/]+)\/write\/([^/]+)$/);
  if (!match) throw new Error(`Not a chapter URL: ${value}`);
  return { workId: decodeURIComponent(match[1]!), chapterId: decodeURIComponent(match[2]!) };
}

export async function login(page: Page): Promise<void> {
  const { authorEmail, authorPassword } = e2eEnvironment();
  await page.goto('/');
  const loginButton = page.getByRole('button', { name: '登录', exact: true });
  const worksHeading = page.getByRole('heading', { name: '作品库', exact: true });
  await expect(loginButton.or(worksHeading)).toBeVisible();
  if (await loginButton.isVisible()) {
    await page.getByLabel('邮箱').fill(authorEmail);
    await page.getByLabel('密码').fill(authorPassword);
    await loginButton.click();
  }
  await expect(worksHeading).toBeVisible();
}

export async function loginAndOpenChapter(page: Page, title: string): Promise<ChapterLocation> {
  await login(page);
  await page.getByRole('button', { name: '新建作品', exact: true }).click();
  await page.getByLabel('作品名称').fill(title);
  await page.getByLabel('作品简介').fill('M1 Playwright 真实验收作品');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.waitForURL(/\/works\/[^/]+\/write\/[^/]+/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expectSaveStatus(page, '已同步');
  return locationFromUrl(page.url());
}

export async function expectSaveStatus(page: Page, label: string): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: label })).toBeVisible({ timeout: 20_000 });
}

export async function getServerChapter(page: Page, location: ChapterLocation): Promise<Chapter> {
  const response = await page.request.get(
    `/api/v1/works/${encodeURIComponent(location.workId)}/chapters/${encodeURIComponent(location.chapterId)}`
  );
  expect(response.ok()).toBe(true);
  const body = await response.json() as { data: unknown };
  return chapterSchema.parse(body.data);
}

export async function postServerText(
  page: Page,
  location: ChapterLocation,
  text: string
): Promise<SaveChangeResponse> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'storyforge_csrf')?.value;
  expect(csrf).toBeTruthy();
  const document = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  };
  const response = await page.request.post(
    `/api/v1/works/${encodeURIComponent(location.workId)}/chapters/${encodeURIComponent(location.chapterId)}/changes`,
    {
      headers: { 'x-csrf-token': csrf! },
      data: {
        change_id: crypto.randomUUID(),
        client_id: crypto.randomUUID(),
        sequence: 1,
        base_version: 0,
        operations: replaceDocumentOperations(createEmptyDocument(), document)
      }
    }
  );
  expect(response.status()).toBe(200);
  const body = await response.json() as { data: unknown };
  return saveChangeResponseSchema.parse(body.data);
}

export async function readLocalState(page: Page, location: ChapterLocation): Promise<LocalWritingState> {
  const raw = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('storyforge-writing');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const storeNames = ['snapshots', 'changes', 'markdown', 'conflicts', 'leases'] as const;
    const transaction = db.transaction(storeNames, 'readonly');
    async function all(storeName: typeof storeNames[number]): Promise<Array<Record<string, unknown>>> {
      return await new Promise((resolve, reject) => {
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        request.onerror = () => reject(request.error);
      });
    }
    const [snapshots, changes, markdown, conflicts, leases] = await Promise.all(
      storeNames.map((name) => all(name))
    );
    db.close();
    return { snapshots, changes, markdown, conflicts, leases };
  });
  return {
    snapshot: raw.snapshots.find((item) => item.work_id === location.workId && item.chapter_id === location.chapterId) as SnapshotState | undefined,
    changes: raw.changes.filter((item) => item.work_id === location.workId && item.chapter_id === location.chapterId) as unknown as ChangeState[],
    markdown: raw.markdown.find((item) => item.chapter_id === location.chapterId) as MarkdownState | undefined,
    conflicts: raw.conflicts.filter((item) => item.work_id === location.workId && item.chapter_id === location.chapterId) as unknown as ConflictState[],
    leases: raw.leases.filter((item) => item.chapter_id === location.chapterId) as unknown as LeaseState[]
  };
}

export async function corruptSnapshot(page: Page, location: ChapterLocation): Promise<void> {
  await page.evaluate(async ({ workId, chapterId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('storyforge-writing');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('snapshots', 'readwrite');
    const store = transaction.objectStore('snapshots');
    const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get([workId, chapterId]);
      request.onsuccess = () => resolve(request.result as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    });
    if (!snapshot) throw new Error('Snapshot not found');
    snapshot.document = { type: 'paragraph' };
    await new Promise<void>((resolve, reject) => {
      const request = store.put(snapshot);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, location);
}

export async function crashBrowser(browser: Browser): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  const information = await session.send('SystemInfo.getProcessInfo') as {
    processInfo: Array<{ id: number; type: string }>;
  };
  const browserProcess = information.processInfo.find((item) => item.type === 'browser');
  if (!browserProcess) throw new Error('Chromium browser process id not found');
  process.kill(browserProcess.id, 'SIGKILL');
  await expect.poll(() => browser.isConnected(), { timeout: 10_000 }).toBe(false);
}
