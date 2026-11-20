import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Character, CharacterAvatarAsset } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { CharacterClient } from './character-client';
import { CharacterInspector } from './character-inspector';

// 硬约束：全部用 mock client，禁止连真实后端
const workId = '11111111-1111-4111-8111-111111111111';
const characterId = '22222222-2222-4222-8222-222222222222';

function uid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: characterId,
    work_id: workId,
    name: '林墨',
    aliases: ['阿墨'],
    identity: '剑客',
    age: 20,
    gender: '男',
    personality: '冷静',
    experience: '行走江湖',
    country_region: '中原',
    faith: '道家',
    faction: '正派',
    race: '汉人',
    occupation: '侠客',
    age_band: '青年',
    attributes: [{ key: '武器', value: '长剑' }],
    avatar_asset_id: null,
    status: 'active',
    merged_into_id: null,
    archived_at: null,
    origin: 'manual',
    version: 3,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function makeAvatarAsset(seed: number, status: CharacterAvatarAsset['status']): CharacterAvatarAsset {
  return {
    id: uid(seed),
    work_id: workId,
    character_id: characterId,
    status,
    mime: 'image/png',
    byte_size: 1024,
    width: 256,
    height: 256,
    content_hash: 'a'.repeat(64),
    content_url: `/avatar/${uid(seed)}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z'
  };
}

function makeClient(overrides: Partial<Record<keyof CharacterClient, unknown>> = {}): CharacterClient {
  const base = {
    getCharacter: vi.fn(async () => ({ character: makeCharacter(), relation_summary: { total: 0 }, growth_event_count: 0 })),
    getAvatar: vi.fn(async () => ({ active: null, pending: [] })),
    getAvatarContentUrl: vi.fn(
      (w: string, c: string, assetId?: string) =>
        `/api/v1/works/${w}/characters/${c}/avatar/content${assetId ? `?asset_id=${assetId}` : ''}`
    ),
    updateCharacter: vi.fn(async () => makeCharacter({ version: 4 })),
    generateAvatar: vi.fn(async () => ({ task: { id: uid(700), status: 'queued' }, character_version: 3 })),
    adoptAvatar: vi.fn(async (_w: string, _c: string, assetId: string) => ({
      asset: makeAvatarAsset(903, 'active'),
      character_version: 4
    }))
  };
  return { ...base, ...overrides } as unknown as CharacterClient;
}

function renderInspector(client: CharacterClient) {
  return render(<CharacterInspector workId={workId} characterId={characterId} client={client} />);
}

describe('CharacterInspector T35', () => {
  it('并发加载角色详情与头像，13 项资料齐全且每项有 label', async () => {
    const client = makeClient();
    renderInspector(client);

    expect(await screen.findByLabelText('姓名')).toHaveValue('林墨');
    expect(client.getCharacter).toHaveBeenCalledWith(workId, characterId);
    expect(client.getAvatar).toHaveBeenCalledWith(workId, characterId);

    for (const label of ['身份', '年龄', '性别', '性格', '经历', '国家/地域', '信仰', '阵营', '种族', '职业', '年龄段']) {
      expect(screen.getByLabelText(label)).toBeVisible();
    }
    const attributes = screen.getByRole('group', { name: '属性' });
    expect(attributes).toBeVisible();
    expect(screen.getByLabelText('属性键 1')).toHaveValue('武器');
    expect(screen.getByLabelText('属性值 1')).toHaveValue('长剑');
    expect(screen.getByRole('region', { name: '别名' })).toBeVisible();
    expect(screen.getByRole('region', { name: '头像' })).toBeVisible();
  });

  it('保存时提交 13 项与 aliases，并携带 expected_version', async () => {
    const onSaved = vi.fn();
    const updateCharacter = vi.fn(async () => makeCharacter({ version: 4 }));
    const client = makeClient({ updateCharacter });
    render(
      <CharacterInspector workId={workId} characterId={characterId} client={client} onSaved={onSaved} />
    );

    const name = await screen.findByLabelText('姓名');
    await userEvent.clear(name);
    await userEvent.type(name, '沈星河');
    fireEvent.change(screen.getByLabelText('年龄'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateCharacter).toHaveBeenCalledTimes(1));
    const call = updateCharacter.mock.calls[0] as unknown as [string, string, Record<string, unknown>, number | undefined];
    expect(call[0]).toBe(workId);
    expect(call[1]).toBe(characterId);
    expect(call[2]).toMatchObject({
      name: '沈星河',
      age: null,
      aliases: ['阿墨'],
      attributes: [{ key: '武器', value: '长剑' }]
    });
    expect(call[3]).toBe(3);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 4 })));
  });

  it('别名最多 10 条：达到上限后禁止新增并给出可读提示', async () => {
    const aliases = Array.from({ length: 10 }, (_, i) => `别名${i + 1}`);
    const client = makeClient({ getCharacter: vi.fn(async () => ({ character: makeCharacter({ aliases }), relation_summary: { total: 0 }, growth_event_count: 0 })) });
    renderInspector(client);

    await screen.findByLabelText('姓名');
    expect(screen.getByText(/别名最多 10 条/)).toBeVisible();
    const add = screen.getByRole('button', { name: '添加别名' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('新别名'), { target: { value: '第十一' } });
    fireEvent.click(add);
    expect(screen.getAllByRole('button', { name: /^移除别名/ })).toHaveLength(10);
  });

  it('保存遇 409 展示「资料已被更新」与刷新按钮，刷新后重取详情', async () => {
    const getCharacter = vi.fn(async () => ({
      character: makeCharacter(),
      relation_summary: { total: 0 },
      growth_event_count: 0
    }));
    const updateCharacter = vi.fn(async () => {
      throw new ApiError(409, 'CHARACTER_VERSION_CONFLICT', 'conflict', {}, 'req-1');
    });
    const client = makeClient({ getCharacter, updateCharacter });
    renderInspector(client);

    await screen.findByLabelText('姓名');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('资料已被更新');
    expect(getCharacter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(getCharacter).toHaveBeenCalledTimes(2));
  });

  it('头像 active 时用 getAvatarContentUrl 渲染图片', async () => {
    const asset = makeAvatarAsset(901, 'active');
    const client = makeClient({ getAvatar: vi.fn(async () => ({ active: asset, pending: [] })) });
    renderInspector(client);

    const img = await screen.findByAltText('林墨 的头像');
    expect(img.getAttribute('src')).toContain(asset.id);
    expect(screen.queryByText('暂无头像')).toBeNull();
  });

  it('头像无 active 时显示占位；pending 时显示 role=status 的生成中', async () => {
    const pending = makeAvatarAsset(902, 'pending');
    const client = makeClient({ getAvatar: vi.fn(async () => ({ active: null, pending: [pending] })) });
    renderInspector(client);

    expect(await screen.findByText('暂无头像')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('生成中');
  });

  it('采用 pending 头像后调用 adoptAvatar，并把新 asset_id 用于图片', async () => {
    const pending = makeAvatarAsset(902, 'pending');
    const adoptedAsset = makeAvatarAsset(903, 'active');
    const adoptAvatar = vi.fn(async () => ({ asset: adoptedAsset, character_version: 4 }));
    const client = makeClient({
      getAvatar: vi.fn(async () => ({ active: null, pending: [pending] })),
      adoptAvatar
    });
    renderInspector(client);

    await screen.findByText('暂无头像');
    fireEvent.click(screen.getByRole('button', { name: '采用' }));

    await waitFor(() => expect(adoptAvatar).toHaveBeenCalledWith(workId, characterId, pending.id, 3));
    const img = await screen.findByAltText('林墨 的头像');
    expect(img.getAttribute('src')).toContain(adoptedAsset.id);
  });

  it('只读角色（已归档）禁用编辑并显示已归档提示', async () => {
    const client = makeClient({
      getCharacter: vi.fn(async () => ({
        character: makeCharacter({ status: 'archived', archived_at: '2026-01-02T00:00:00Z' }),
        relation_summary: { total: 0 },
        growth_event_count: 0
      }))
    });
    renderInspector(client);

    const name = await screen.findByLabelText('姓名');
    expect(name).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getByText('已归档')).toBeVisible();
  });
});
