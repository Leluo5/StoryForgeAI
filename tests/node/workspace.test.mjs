import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));

test('workspace pins Node and pnpm', () => {
  assert.equal(root.engines.node, '22.16.0');
  assert.equal(root.packageManager, 'pnpm@10.12.4');
  assert.match(readFileSync('pnpm-workspace.yaml', 'utf8'), /apps\/\*/);
  assert.match(readFileSync('pnpm-workspace.yaml', 'utf8'), /packages\/\*/);
});

test('api migration script does not depend on the node_modules layout', () => {
  const api = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));
  const script = api.scripts['migration:run'];
  assert.ok(script, 'apps/api must expose a migration:run script');
  assert.doesNotMatch(script, /node_modules/, 'migration:run must not hardcode a node_modules path');
  const entry = /tsx\s+(\S+\.ts)/.exec(script)?.[1];
  assert.ok(entry, 'migration:run must run a TypeScript entry point');
  assert.ok(existsSync(resolve('apps/api', entry)), `migration entry ${entry} must exist`);
});

test('M1 database failure verification supports pnpm.cmd on Windows', () => {
  const script = readFileSync('scripts/verify-m1-db-failure.mjs', 'utf8');
  const executeBody = /function execute\(command, args\) \{([\s\S]*?)\n\}/.exec(script)?.[1];
  assert.ok(executeBody, 'execute helper must exist');
  assert.match(executeBody, /shell:\s*process\.platform === 'win32'/);
});

test('M1 database failure verification handles expected PostgreSQL disconnects', () => {
  const script = readFileSync('scripts/verify-m1-db-failure.mjs', 'utf8');
  assert.match(script, /blocker\.on\('error'/);
  assert.match(script, /observer\.on\('error'/);
});
