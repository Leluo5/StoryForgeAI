/**
 * D12 补充：375 移动端抽屉路径验证。
 * 深链 ?panel=ai → 点击「打开 AI 创作」→ 抽屉展开 → 断言面板可交互 + 键盘 Tab 流。
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'out');
mkdirSync(OUT, { recursive: true });

const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:3001';
const EMAIL = 'author@example.com';
const PASSWORD = 'StoryforgeTest2026!';

const report = { steps: [] };
const log = (s, ok, d = '') => { report.steps.push({ s, ok, d }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${s}${d ? ' :: ' + d : ''}`); };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await context.newPage();
try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.getByLabel('邮箱').fill(EMAIL);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '作品库' }).waitFor({ timeout: 30000 });
  log('登录', true);

  const csrf = (await context.cookies()).find((c) => c.name === 'storyforge_csrf')?.value;
  const workResp = await page.request.post(`${API}/api/v1/works`, {
    headers: { 'x-csrf-token': csrf }, data: { title: `D12 mobile ${Date.now()}`, description: 'mobile drawer' }
  });
  const workId = (await workResp.json()).data?.work?.id;
  const volResp = await page.request.post(`${API}/api/v1/works/${workId}/volumes`, {
    headers: { 'x-csrf-token': csrf }, data: { title: '卷一' }
  });
  const volumeId = (await volResp.json()).data?.id ?? (await volResp.json()).data?.volume?.id;
  const chResp = await page.request.post(`${API}/api/v1/works/${workId}/volumes/${volumeId}/chapters`, {
    headers: { 'x-csrf-token': csrf }, data: { title: '第一章' }
  });
  const chapterId = (await chResp.json()).data?.id ?? (await chResp.json()).data?.chapter?.id;
  log('创建作品/章节', true, `${workId}/${chapterId}`);

  await page.goto(`${BASE}/works/${workId}/write/${chapterId}?panel=ai`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const trigger = page.locator('.right-trigger');
  await trigger.waitFor({ timeout: 30000 });
  const triggerText = (await trigger.textContent())?.trim();
  log('移动端入口按钮', triggerText === '打开AI 创作' || triggerText === '打开 AI 创作', `text=${triggerText}`);
  await trigger.click();
  await page.waitForTimeout(500);
  // 抽屉展开后断言面板内容
  const panelHeading = page.getByRole('heading', { name: 'AI 创作' });
  const aiVisible = await panelHeading.isVisible().catch(() => false);
  log('抽屉展开显示 AI 创作', aiVisible);
  await page.screenshot({ path: join(OUT, 'd12-ai-375-open.png'), fullPage: false });

  // 抽屉内键盘 Tab 流
  const focusSeq = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return { role: el.getAttribute('role') || el.tagName.toLowerCase(), label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName, id: el.id || null };
    });
    focusSeq.push(info);
  }
  const hasAi = focusSeq.some((f) => f && (f.id === 'ai-tool' || f.id === 'ai-input' || (f.label ?? '').includes('发起创作')));
  log('抽屉内键盘焦点流可达 AI 表单', hasAi, JSON.stringify(focusSeq));

  // 读屏语义（抽屉内）
  const semantics = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.right-dialog');
    const select = document.querySelector('#ai-tool');
    const ta = document.querySelector('#ai-input');
    return {
      dialogOpen: dialog?.open ?? false,
      dialogLabelledby: dialog?.getAttribute('aria-labelledby') ?? null,
      selectLabel: document.querySelector('label[for="ai-tool"]')?.textContent?.trim() ?? null,
      taLabel: document.querySelector('label[for="ai-input"]')?.textContent?.trim() ?? null,
      submit: Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('发起创作'))?.textContent?.trim() ?? null
    };
  });
  log('抽屉读屏语义', !!(semantics.dialogOpen && semantics.selectLabel === '创作工具' && semantics.taLabel && semantics.submit), JSON.stringify(semantics));
} catch (err) {
  log('采集异常', false, err?.message ?? String(err));
} finally {
  await browser.close();
}
console.log('DONE');
