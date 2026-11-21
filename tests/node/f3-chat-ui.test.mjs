import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const template = readFileSync(new URL('../../templates/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../static/js/app.js', import.meta.url), 'utf8');
const encoder = new TextEncoder();

async function waitFor(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待页面状态超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function streamResponse(events) {
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function createHarness(t, chatHandler) {
  const requests = [];
  const dom = new JSDOM(template, {
    url: 'http://127.0.0.1:5000/#work/w1',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  window.AbortController = AbortController;
  window.DOMException = DOMException;
  window.fetch = async (url, options = {}) => {
    if (url === '/api/works/w1') {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            id: 'w1',
            name: '测试作品',
            description: '',
            interaction_type: 'chat',
            parameters: [],
            suggested_questions: [],
            prologue: '',
            coze_meta: {},
          },
        }),
      };
    }
    if (url === '/api/works/w1/chat') {
      requests.push({ body: JSON.parse(options.body), signal: options.signal });
      return chatHandler(options, requests.length);
    }
    throw new Error(`未预期的请求: ${url}`);
  };

  window.eval(appSource);
  await waitFor(() => window.document.getElementById('work-name')?.textContent === '测试作品');
  t.after(() => window.close());
  return {
    window,
    requests,
    input: window.document.getElementById('chat-input'),
    button: window.document.getElementById('btn-send'),
  };
}

test('下一轮聊天携带相同 user_id 和已完成会话的 conversation_id', async (t) => {
  const { window, requests, input, button } = await createHarness(t, () =>
    streamResponse([{ delta: '你好' }, { done: true, conversation_id: 'c1' }]),
  );

  input.value = '第一条';
  button.click();
  await waitFor(() => requests.length === 1 && !input.disabled);
  input.value = '第二条';
  button.click();
  await waitFor(() => requests.length === 2 && !input.disabled);

  assert.ok(requests[0].body.user_id);
  assert.equal(requests[1].body.user_id, requests[0].body.user_id);
  assert.equal(requests[1].body.conversation_id, 'c1');
  assert.equal(window.document.querySelectorAll('#chat-messages .chat-message.user').length, 2);
});

test('流式生成中点击停止会中断请求并保留已生成内容', async (t) => {
  let upstream;
  const { window, requests, input, button } = await createHarness(t, (options) => {
    const stream = new ReadableStream({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode('data: {"delta":"部分内容"}\n\n'));
      },
    });
    options.signal.addEventListener('abort', () => {
      upstream.error(new DOMException('Aborted', 'AbortError'));
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  input.value = '写长文';
  button.click();
  await waitFor(() =>
    window.document.querySelector('#chat-messages .chat-message.ai')?.textContent.includes('部分内容'),
  );
  assert.equal(button.getAttribute('aria-label'), '停止生成');
  assert.equal(button.disabled, false);

  button.click();
  await waitFor(() => !input.disabled);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(button.getAttribute('aria-label'), '发送');
  assert.equal(button.disabled, false);
  const messages = window.document.getElementById('chat-messages').textContent;
  assert.ok(messages.includes('部分内容'));
  assert.ok(!messages.includes('请求失败'));
});

test('响应到达前停止不会显示网络错误', async (t) => {
  const { window, requests, input, button } = await createHarness(t, (options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  );

  input.value = '立即停止';
  button.click();
  await waitFor(() => requests.length === 1);
  assert.equal(button.getAttribute('aria-label'), '停止生成');
  assert.equal(button.disabled, false);

  button.click();
  await waitFor(() => !input.disabled);
  assert.equal(requests[0].signal.aborted, true);
  assert.ok(!window.document.getElementById('chat-messages').textContent.includes('请求失败'));
});
