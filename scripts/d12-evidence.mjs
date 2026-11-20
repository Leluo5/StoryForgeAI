/**
 * 临时 D12 证据采集脚本（人工复核辅助）：
 * 用 Playwright 原生驱动登录 → 创建作品 → 深链 AI 面板 →
 * 四档视口截图（375/768/1024/1440）+ 键盘 Tab 焦点流遍历 + 读屏语义（role/aria）检查。
 * 产物存 scripts/out/d12-*。
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'out');
mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const API = process.env.API_URL ?? 'http://127.0.0.1:3001';
const EMAIL = process.env.AUTHOR_EMAIL ?? 'author@example.com';
const PASSWORD = process.env.AUTHOR_PASSWORD ?? 'StoryforgeTest2026!';

const viewports = [
  { name: '375', width: 375, height: 812 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 }
];

const report = { steps: [], viewports: {}, keyboard: {}, semantics: {} };

function log(step, ok, detail = '') {
  report.steps.push({ step, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  // ---- 1. 登录 ----
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  const loginButton = page.getByRole('button', { name: '登录', exact: true });
  const worksHeading = page.getByRole('heading', { name: '作品库', exact: true });
  await loginButton.or(worksHeading).first().waitFor({ timeout: 30000 });
  if (await loginButton.isVisible().catch(() => false)) {
    await page.getByLabel('邮箱').fill(EMAIL);
    await page.getByLabel('密码').fill(PASSWORD);
    await loginButton.click();
    await worksHeading.waitFor({ timeout: 30000 });
  }
  log('登录', true, `email=${EMAIL}`);

  // ---- 2. 创建作品（API 直连，避免 ProseMirror 创建流）----
  const csrf = (await context.cookies()).find((c) => c.name === 'storyforge_csrf')?.value;
  if (!csrf) throw new Error('csrf cookie missing after login');
  const workTitle = `D12 人工复核 ${Date.now()}`;
  const workResp = await page.request.post(`${API}/api/v1/works`, {
    headers: { 'x-csrf-token': csrf },
    data: { title: workTitle, description: 'D12 视口/键盘复核作品' }
  });
  const workBody = await workResp.json();
  const workId = workBody?.data?.work?.id ?? workBody?.data?.id;
  if (!workId) throw new Error(`create work failed: ${JSON.stringify(workBody)}`);
  log('创建作品', true, `workId=${workId}`);

  // 建卷 + 建章
  const volResp = await page.request.post(`${API}/api/v1/works/${workId}/volumes`, {
    headers: { 'x-csrf-token': csrf }, data: { title: '卷一' }
  });
  const volBody = await volResp.json();
  const volumeId = volBody?.data?.volume?.id ?? volBody?.data?.id;
  const chResp = await page.request.post(`${API}/api/v1/works/${workId}/volumes/${volumeId}/chapters`, {
    headers: { 'x-csrf-token': csrf }, data: { title: '第一章' }
  });
  const chBody = await chResp.json();
  const chapterId = chBody?.data?.chapter?.id ?? chBody?.data?.id;
  log('创建章节', true, `volumeId=${volumeId} chapterId=${chapterId}`);

  // ---- 3. 深链 AI 面板 ----
  const aiUrl = `${BASE}/works/${workId}/write/${chapterId}?panel=ai`;
  await page.goto(aiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  // 解决版本冲突弹窗（若有）
  const useServer = page.getByRole('button', { name: '使用服务端' });
  if (await useServer.isVisible().catch(() => false)) {
    await useServer.click();
    await page.getByRole('dialog', { name: '版本冲突' }).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  }
  await page.getByRole('tab', { name: 'AI 创作' }).waitFor({ timeout: 30000 });
  await page.getByRole('tab', { name: 'AI 创作' }).click();
  await page.getByRole('heading', { name: 'AI 创作' }).waitFor({ timeout: 30000 });
  log('深链 AI 面板', true, `url=${aiUrl}`);

  // ---- 4. 四档视口截图 ----
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(300);
    const file = join(OUT, `d12-ai-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    report.viewports[vp.name] = { file, width: vp.width, height: vp.height };
    log(`视口截图 ${vp.name}`, true, `file=${file}`);
  }

  // 恢复 1440 做键盘/读屏
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  // ---- 5. 键盘 Tab 焦点流遍历 ----
  const focusLog = [];
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.tagName;
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      return { role, label, tag: el.tagName.toLowerCase(), id: el.id || null };
    });
    focusLog.push(info);
    if (info && (info.role === 'button' || info.role === 'tab' || info.tag === 'textarea' || info.tag === 'select')) {
      // 记录进入面板可交互区即可，不强点
    }
  }
  report.keyboard.focusSequence = focusLog;
  const aiInteractive = focusLog.some((f) => f && (f.label?.includes('AI 创作') || f.id === 'ai-tool' || f.id === 'ai-input'));
  log('键盘 Tab 焦点流', aiInteractive, JSON.stringify(focusLog));

  // ---- 6. 读屏语义检查（role/aria）----
  const semantics = await page.evaluate(() => {
    const out = {};
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    out.activeTab = tab ? { name: tab.textContent?.trim(), selected: tab.getAttribute('aria-selected') } : null;
    const panel = document.querySelector('[role="tabpanel"]');
    out.panel = panel ? { labelledby: panel.getAttribute('aria-labelledby') } : null;
    const prog = document.querySelector('[role="progressbar"]');
    out.progressbar = prog ? {
      label: prog.getAttribute('aria-label'), min: prog.getAttribute('aria-valuemin'),
      max: prog.getAttribute('aria-valuemax'), now: prog.getAttribute('aria-valuenow')
    } : null;
    const select = document.querySelector('#ai-tool');
    out.select = select ? { label: select.getAttribute('aria-label') ?? document.querySelector('label[for="ai-tool"]')?.textContent?.trim() } : null;
    const textarea = document.querySelector('#ai-input');
    out.textarea = textarea ? { label: document.querySelector('label[for="ai-input"]')?.textContent?.trim(), placeholder: textarea.getAttribute('placeholder') } : null;
    const submit = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('发起'));
    out.submit = submit ? { text: submit.textContent?.trim() } : null;
    return out;
  });
  report.semantics = semantics;
  log('读屏语义', !!(semantics.panel && semantics.select && semantics.textarea), JSON.stringify(semantics));
} catch (err) {
  log('采集异常', false, err?.message ?? String(err));
} finally {
  writeFileSync(join(OUT, 'd12-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log('DONE report=', join(OUT, 'd12-report.json'));
