import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CharacterToolbar } from './character-toolbar';
import type { CharacterClient } from './character-client';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

const emptyFilters = {
  country_region: 'all',
  faith: 'all',
  faction: 'all',
  race: 'all',
  occupation: 'all',
  age_band: 'all'
} as const;

const dimensionOptions = {
  country_region: [],
  faith: [],
  faction: [],
  race: [],
  occupation: [],
  age_band: []
};

const importPayload = {
  schema_version: 1,
  work: { id: WORK_ID, title: '测试作品' },
  characters: [],
  relation_types: [],
  relations: [],
  growth_events: [],
  views: []
};

function makeClient(overrides: Partial<CharacterClient> = {}): CharacterClient {
  return {
    exportFile: vi.fn(async () => importPayload),
    previewImport: vi.fn(async () => ({
      preview_job_id: JOB_ID,
      summary: { characters: 1, relations: 0, growth_events: 0, views: 0, conflicts: 1 },
      conflicts: [{ type: 'character_duplicate', local_id: 'c1', matches: [{ character_id: TARGET_ID, name: '林墨', matched_on: 'name' }] }]
    })),
    commitImport: vi.fn(async () => ({ job_id: JOB_ID, summary: {}, conflicts: [] })),
    ...overrides
  } as unknown as CharacterClient;
}

function renderToolbar(client: CharacterClient, onImported = vi.fn()) {
  render(
    <CharacterToolbar
      view="canvas"
      onView={() => {}}
      workId={WORK_ID}
      client={client}
      onImported={onImported}
      zoom={1}
      onZoomIn={() => {}}
      onZoomOut={() => {}}
      onFit={() => {}}
      onReset={() => {}}
      keyword=""
      onKeyword={() => {}}
      filters={emptyFilters}
      dimensionOptions={dimensionOptions}
      onDimensionChange={() => {}}
      resultCount={0}
      busy={false}
    />
  );
  return onImported;
}

function makeFile(text: string): File {
  const file = new File([text], 'characters.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  return file;
}

async function upload(client: CharacterClient, text = JSON.stringify(importPayload)): Promise<void> {
  await userEvent.upload(screen.getByLabelText('导入角色'), makeFile(text));
}

describe('CharacterToolbar · 导入导出（T41）', () => {
  it('导出调用 exportFile 并下载附件', async () => {
    const createObjectURL = vi.fn(() => 'blob:characters');
    (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const client = makeClient();
    renderToolbar(client);

    await userEvent.click(screen.getByRole('button', { name: '导出角色' }));

    expect(client.exportFile).toHaveBeenCalledWith(WORK_ID);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已导出/)).toBeVisible();
  });

  it('导入前本地校验：非法 JSON 与超限文件给出可读错误', async () => {
    const client = makeClient();
    renderToolbar(client);

    await upload(client, 'not-json');
    expect(await screen.findByRole('alert')).toHaveTextContent('不是合法 JSON');
    expect(client.previewImport).not.toHaveBeenCalled();

    const big = new File(['x'], 'big.json');
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    Object.defineProperty(big, 'text', { value: async () => '{}' });
    await userEvent.upload(screen.getByLabelText('导入角色'), big);
    expect(await screen.findByRole('alert')).toHaveTextContent('5 MB');
  });

  it('重复角色必须逐条选择处理方式后才提交，提交携带幂等键', async () => {
    const client = makeClient();
    const onImported = renderToolbar(client);

    await upload(client);
    expect(client.previewImport).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/重复角色：林墨/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: '提交导入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('未选择处理方式');

    await userEvent.selectOptions(screen.getByLabelText('重复角色 c1 的处理方式'), 'create');
    await userEvent.click(screen.getByRole('button', { name: '提交导入' }));

    const call = (client.commitImport as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0]![1];
    expect(typeof call.idempotency_key).toBe('string');
    expect(call.preview_job_id).toBe(JOB_ID);
    expect(call.resolutions).toEqual([{ local_id: 'c1', action: 'create' }]);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('覆盖导入必须二次确认，确认后带 confirm_overwrite 提交', async () => {
    const client = makeClient();
    renderToolbar(client);

    await upload(client);
    await userEvent.selectOptions(await screen.findByLabelText('重复角色 c1 的处理方式'), 'keep_independent');
    await userEvent.selectOptions(screen.getByLabelText('导入模式'), 'replace');
    await userEvent.click(screen.getByRole('button', { name: '提交导入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('覆盖导入需要先勾选确认');

    await userEvent.click(screen.getByRole('checkbox', { name: /确认覆盖当前角色数据/ }));
    await userEvent.click(screen.getByRole('button', { name: '提交导入' }));

    const call = (client.commitImport as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0]![1];
    expect(call.mode).toBe('replace');
    expect(call.confirm_overwrite).toBe(true);
  });
});
