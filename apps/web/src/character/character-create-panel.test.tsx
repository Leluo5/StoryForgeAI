import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CharacterCreateTools } from './character-create-panel';
import type { CharacterClient } from './character-client';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const VIEW_ID = 'vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const TYPE_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_ID = '55555555-5555-4555-8555-555555555555';

const characters = [
  { id: SOURCE_ID, name: '林墨', status: 'active' as const, avatar_asset_id: null, six_dim: {} },
  { id: TARGET_ID, name: '沈星河', status: 'active' as const, avatar_asset_id: null, six_dim: {} }
];

const relationType = {
  id: TYPE_ID,
  work_id: WORK_ID,
  code: 'master_disciple',
  label: '师徒',
  group_key: 'social',
  group_label: '社会',
  directed: true,
  reverse_label: '弟子',
  is_builtin: true,
  sort_order: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z'
};

function makeClient(overrides: Partial<CharacterClient> = {}): CharacterClient {
  const base = {
    createCharacter: vi.fn(async () => ({ id: CREATED_ID, name: '林墨' })),
    addViewMembers: vi.fn(async () => ({ added: 1 })),
    randomDossier: vi.fn(async () => ({
      seed: 'seed-1',
      dossier: {
        name: '随机角色',
        identity: '游侠',
        age: 24,
        gender: '女',
        personality: '冷静',
        experience: '闯荡江湖',
        country_region: '中原',
        faith: '道家',
        faction: '正派',
        race: '汉人',
        occupation: '剑客',
        age_band: '青年',
        attributes: []
      }
    })),
    listRelationTypes: vi.fn(async () => [relationType]),
    createRelation: vi.fn(async () => ({ id: '66666666-6666-4666-8666-666666666666', created: true }))
  };
  return { ...base, ...overrides } as unknown as CharacterClient;
}

function renderTools(client: CharacterClient, onCreated = vi.fn()) {
  render(
    <CharacterCreateTools
      workId={WORK_ID}
      viewId={VIEW_ID}
      client={client}
      characters={characters}
      onCreated={onCreated}
    />
  );
  return onCreated;
}

describe('CharacterCreateTools · L5 遗留体验项', () => {
  it('新建角色：提交后调用 createCharacter 并补入当前视图', async () => {
    const client = makeClient();
    const onCreated = renderTools(client);

    await userEvent.click(screen.getByRole('button', { name: '新建角色' }));
    const dialog = await screen.findByRole('dialog', { name: '新建角色' });
    expect(dialog).toBeVisible();

    await userEvent.type(screen.getByLabelText('名称'), '林墨');
    await userEvent.type(screen.getByLabelText('身份'), '游侠');
    await userEvent.click(screen.getByRole('button', { name: '创建角色' }));

    expect(client.createCharacter).toHaveBeenCalledTimes(1);
    expect(client.createCharacter).toHaveBeenCalledWith(WORK_ID, expect.objectContaining({
      name: '林墨',
      identity: '游侠'
    }));
    expect(client.addViewMembers).toHaveBeenCalledWith(WORK_ID, VIEW_ID, [CREATED_ID]);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('名称为空时不提交并给出可读错误', async () => {
    const client = makeClient();
    renderTools(client);

    await userEvent.click(screen.getByRole('button', { name: '新建角色' }));
    await userEvent.click(screen.getByRole('button', { name: '创建角色' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请填写角色名称');
    expect(client.createCharacter).not.toHaveBeenCalled();
  });

  it('随机资料：生成后回填表单，可改后保存', async () => {
    const client = makeClient();
    const onCreated = renderTools(client);

    await userEvent.click(screen.getByRole('button', { name: '随机资料' }));
    expect(client.randomDossier).toHaveBeenCalledWith(WORK_ID);
    expect(await screen.findByLabelText('名称')).toHaveValue('随机角色');
    expect(screen.getByLabelText('性格')).toHaveValue('冷静');

    await userEvent.clear(screen.getByLabelText('名称'));
    await userEvent.type(screen.getByLabelText('名称'), '定制角色');
    await userEvent.click(screen.getByRole('button', { name: '创建角色' }));

    expect(client.createCharacter).toHaveBeenCalledWith(WORK_ID, expect.objectContaining({
      name: '定制角色',
      personality: '冷静',
      occupation: '剑客',
      age: 24
    }));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('建关系：加载关系类型后按类型方向创建', async () => {
    const client = makeClient();
    const onCreated = renderTools(client);

    await userEvent.click(screen.getByRole('button', { name: '建关系' }));
    expect(client.listRelationTypes).toHaveBeenCalledWith(WORK_ID);

    const dialog = await screen.findByRole('dialog', { name: '建关系' });
    expect(dialog).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('起点角色'), SOURCE_ID);
    await userEvent.selectOptions(screen.getByLabelText('终点角色'), TARGET_ID);
    expect(screen.getByText(/有向（单向箭头）/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: '创建关系' }));

    expect(client.createRelation).toHaveBeenCalledWith(WORK_ID, expect.objectContaining({
      source_id: SOURCE_ID,
      target_id: TARGET_ID,
      type_id: TYPE_ID,
      directed: true
    }));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('建关系拒绝同一角色两端', async () => {
    const client = makeClient();
    renderTools(client);

    await userEvent.click(screen.getByRole('button', { name: '建关系' }));
    await screen.findByRole('dialog', { name: '建关系' });
    await userEvent.selectOptions(screen.getByLabelText('起点角色'), SOURCE_ID);
    await userEvent.selectOptions(screen.getByLabelText('终点角色'), SOURCE_ID);
    await userEvent.click(screen.getByRole('button', { name: '创建关系' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('关系两端不能是同一角色');
    expect(client.createRelation).not.toHaveBeenCalled();
  });
});
