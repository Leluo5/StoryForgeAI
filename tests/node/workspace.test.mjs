import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync('package.json', 'utf8'));

test('workspace pins Node and pnpm', () => {
  assert.equal(root.engines.node, '22.16.0');
  assert.equal(root.packageManager, 'pnpm@10.12.4');
  assert.match(readFileSync('pnpm-workspace.yaml', 'utf8'), /apps\/\*/);
  assert.match(readFileSync('pnpm-workspace.yaml', 'utf8'), /packages\/\*/);
});
