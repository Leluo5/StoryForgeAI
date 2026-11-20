import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const template = readFileSync(new URL('../../templates/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../static/js/app.js', import.meta.url), 'utf8');

async function waitFor(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待页面状态超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('未登录进入 #admin 时显示登录表单且不请求管理数据', async (t) => {
  const requests = [];
  const dom = new JSDOM(template, {
    url: 'http://127.0.0.1:5000/#admin',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  t.after(() => window.close());
  window.fetch = async (url) => {
    requests.push(url);
    throw new Error(`未预期的请求: ${url}`);
  };

  window.eval(appSource);
  await waitFor(() => window.document.getElementById('page-admin')?.classList.contains('active'));

  assert.notEqual(window.document.getElementById('admin-login').style.display, 'none');
  assert.equal(window.document.getElementById('admin-panel').style.display, 'none');
  assert.deepEqual(requests, []);
});
