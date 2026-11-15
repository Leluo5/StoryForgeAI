import { cpus, platform, release, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { chapterUrl, expectSaveStatus, loginAndOpenChapter } from './m1-helpers';

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

test.setTimeout(120_000);

test('collect an environment-labelled M1 performance baseline without claiming the M5 gate', async ({ page, browser }, testInfo) => {
  const location = await loginAndOpenChapter(page, `M1 性能基线 ${Date.now()}`);
  const editor = page.locator('.ProseMirror');
  await editor.fill('字'.repeat(10_000));
  await expectSaveStatus(page, '已同步');

  const inputSamples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await editor.pressSequentially('测');
    inputSamples.push(performance.now() - started);
  }
  await expectSaveStatus(page, '已同步');

  const openSamples: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    await page.goto(chapterUrl(location.workId, location.chapterId));
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await expectSaveStatus(page, '已同步');
    openSamples.push(performance.now() - started);
  }

  const processor = cpus();
  const evidence = {
    schema_version: 1,
    scope: 'M1 baseline only; not an M5 performance-gate result',
    captured_at: new Date().toISOString(),
    hardware: {
      platform: platform(),
      release: release(),
      cpu_model: processor[0]?.model ?? 'unknown',
      logical_cpus: processor.length,
      memory_bytes: totalmem()
    },
    browser: { name: 'chromium', version: browser.version() },
    dataset: {
      works: 1,
      volumes: 1,
      chapters: 1,
      initial_characters: 10_000,
      appended_characters: 20,
      thousand_chapter_virtualization: false
    },
    network: {
      included: true,
      kind: 'loopback HTTP plus browser IndexedDB and Playwright protocol',
      base_url: 'http://127.0.0.1:5173'
    },
    metrics: {
      input_wall_ms: { samples: inputSamples, p95: percentile95(inputSamples) },
      chapter_open_wall_ms: { samples: openSamples, p95: percentile95(openSamples) }
    },
    m5_gate_claimed: false
  };
  const directory = join(process.cwd(), 'test-results', 'm1-evidence');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'performance.json');
  await writeFile(path, JSON.stringify(evidence, null, 2), 'utf8');
  await testInfo.attach('m1-performance-baseline', { path, contentType: 'application/json' });
  expect(evidence.metrics.input_wall_ms.samples).toHaveLength(20);
  expect(evidence.metrics.chapter_open_wall_ms.samples).toHaveLength(5);
});
