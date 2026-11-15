import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = join(root, 'test-results', 'm1-evidence');
const evidencePath = join(evidenceDirectory, 'db-failure.json');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://storyforge:storyforge@127.0.0.1:5432/storyforge_test';
const authorEmail = process.env.AUTHOR_EMAIL;
const authorPassword = process.env.AUTHOR_PASSWORD;
const apiRequire = createRequire(join(root, 'apps/api', 'package.json'));
const { Client } = apiRequire('pg');
const baseUrl = 'http://127.0.0.1:3102';
let apiProcess;
let blocker;
let observer;

function safeError(error) {
  return String(error instanceof Error ? error.stack ?? error.message : error)
    .replaceAll(databaseUrl, '[redacted-database-url]')
    .replaceAll(authorPassword ?? '__no_password__', '[redacted-password]');
}

function execute(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'unknown'}`);
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out${lastError ? `: ${safeError(lastError)}` : ''}`);
}

async function startApi() {
  apiProcess = spawn(pnpm, ['--filter', '@storyforge/api', 'start'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      PORT: '3102',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
      SESSION_TTL_SECONDS: '604800'
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    // Node 22 禁止直接 spawn Windows 的 .cmd 文件；交给 shell 解析 pnpm
    shell: process.platform === 'win32'
  });
  await waitFor(async () => {
    if (apiProcess.exitCode !== null) throw new Error(`API exited with ${apiProcess.exitCode}`);
    const response = await fetch(`${baseUrl}/api/v1/health`);
    return response.ok;
  }, 'API health');
}

async function stopApi() {
  if (!apiProcess?.pid || apiProcess.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(apiProcess.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-apiProcess.pid, 'SIGTERM'); } catch { /* 进程已退出。 */ }
  }
  await Promise.race([
    new Promise((resolve) => apiProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
}

async function main() {
  if (process.env.M1_ALLOW_DATABASE_RESTART !== '1') {
    throw new Error('Set M1_ALLOW_DATABASE_RESTART=1 only for the disposable PostgreSQL test service');
  }
  if (!authorEmail || !authorPassword) throw new Error('AUTHOR_EMAIL and AUTHOR_PASSWORD are required');
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) throw new Error('TEST_DATABASE_URL must end in _test');

  execute('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', 'postgres', '--wait']);
  execute(pnpm, ['--filter', '@storyforge/api', 'test:prepare']);
  await startApi();

  const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: authorEmail, password: authorPassword })
  });
  if (!loginResponse.ok) throw new Error(`Login failed with HTTP ${loginResponse.status}`);
  await loginResponse.json();
  const cookies = new Map();
  for (const item of loginResponse.headers.getSetCookie()) {
    const [pair] = item.split(';');
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const session = cookies.get('storyforge_session');
  const csrf = cookies.get('storyforge_csrf');
  if (!session || !csrf) throw new Error('Login did not return both session and CSRF cookies');
  const cookieHeader = `storyforge_session=${session}; storyforge_csrf=${csrf}`;

  async function api(path, method = 'GET', body) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Cookie: cookieHeader,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': csrf })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  async function data(response) {
    const body = await response.json();
    if (!response.ok) throw new Error(`API returned HTTP ${response.status}: ${JSON.stringify(body.error ?? {})}`);
    return body.data;
  }

  const created = await data(await api('/api/v1/works', 'POST', {
    title: `M1 数据库故障 ${Date.now()}`,
    description: '真实行锁与 PostgreSQL 重启验收'
  }));
  const workId = created.work.id;
  const chapterId = created.first_chapter_id;
  const change = {
    change_id: randomUUID(),
    client_id: randomUUID(),
    sequence: 1,
    base_version: 0,
    operations: [{
      stepType: 'replace',
      from: 1,
      to: 1,
      slice: { content: [{ type: 'text', text: '数据库故障后正文' }] }
    }]
  };

  blocker = new Client({ connectionString: databaseUrl });
  observer = new Client({ connectionString: databaseUrl });
  await blocker.connect();
  await observer.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM chapters WHERE id = $1 FOR UPDATE', [chapterId]);

  let settled = false;
  const interrupted = api(
    `/api/v1/works/${workId}/chapters/${chapterId}/changes`,
    'POST',
    change
  ).then(async (response) => ({
    status: response.status,
    body: await response.text()
  })).catch((error) => ({
    status: 0,
    body: error instanceof Error ? error.name : 'NetworkError'
  })).finally(() => { settled = true; });

  await waitFor(async () => {
    const waiting = await observer.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'"
    );
    return waiting.rows[0].count > 0;
  }, 'save transaction row-lock wait');
  if (settled) throw new Error('Save completed before the injected database restart');

  execute('docker', ['compose', '-f', 'infra/docker-compose.yml', 'restart', 'postgres']);
  execute('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d', 'postgres', '--wait']);
  const interruptedResult = await Promise.race([
    interrupted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Interrupted save did not settle')), 15_000))
  ]);
  if (interruptedResult.status >= 200 && interruptedResult.status < 300) {
    throw new Error('Interrupted save unexpectedly returned success');
  }

  await waitFor(async () => (await fetch(`${baseUrl}/api/v1/health`)).ok, 'API health after database restart');
  const verification = new Client({ connectionString: databaseUrl });
  await verification.connect();
  try {
    const afterFailure = await verification.query(
      'SELECT version, document FROM chapters WHERE id = $1',
      [chapterId]
    );
    const failureChanges = await verification.query(
      'SELECT count(*)::int AS count FROM chapter_changes WHERE chapter_id = $1',
      [chapterId]
    );
    if (afterFailure.rows[0]?.version !== 0 || failureChanges.rows[0]?.count !== 0) {
      throw new Error('Database contains a partial chapter save after restart');
    }
    if (afterFailure.rows[0]?.document?.content?.[0]?.content !== undefined) {
      throw new Error('Chapter document changed despite the interrupted transaction');
    }

    const retryResponse = await api(
      `/api/v1/works/${workId}/chapters/${chapterId}/changes`,
      'POST',
      change
    );
    const retry = await data(retryResponse);
    if (retry.server_version !== 1) throw new Error('Retry did not commit version 1');
    const replay = await data(await api(
      `/api/v1/works/${workId}/chapters/${chapterId}/changes`,
      'POST',
      change
    ));
    if (replay.change_id !== retry.change_id || replay.server_version !== 1) {
      throw new Error('Idempotent replay returned a different result');
    }
    const finalChapter = await verification.query(
      'SELECT version, document FROM chapters WHERE id = $1',
      [chapterId]
    );
    const finalChanges = await verification.query(
      'SELECT count(*)::int AS count FROM chapter_changes WHERE chapter_id = $1',
      [chapterId]
    );
    if (finalChapter.rows[0]?.version !== 1 || finalChanges.rows[0]?.count !== 1) {
      throw new Error('Retry or idempotent replay produced duplicate state');
    }
    if (finalChapter.rows[0]?.document?.content?.[0]?.content?.[0]?.text !== '数据库故障后正文') {
      throw new Error('Retry did not preserve the requested document');
    }

    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(evidencePath, JSON.stringify({
      schema_version: 1,
      passed: true,
      captured_at: new Date().toISOString(),
      row_lock_observed: true,
      database_restarted_while_save_waiting: true,
      interrupted_response: { status: interruptedResult.status },
      after_failure: { version: 0, chapter_changes: 0 },
      retry: { server_version: retry.server_version, chapter_changes: 1 },
      idempotent_replay: { server_version: replay.server_version, chapter_changes: 1 }
    }, null, 2), 'utf8');
    console.info(`M1 database failure evidence: ${evidencePath}`);
  } finally {
    await verification.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(evidencePath, JSON.stringify({
    schema_version: 1,
    passed: false,
    captured_at: new Date().toISOString(),
    error: safeError(error)
  }, null, 2), 'utf8');
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  if (observer) await observer.end().catch(() => undefined);
  if (blocker) {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end().catch(() => undefined);
  }
  await stopApi();
}
