import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Character, CharacterRelation, CharacterRelationType } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { CharacterClient } from './character-client';
import { CharacterRelationPanel } from './character-relation-panel';

const workId = '11111111-1111-4111-8111-111111111111';
const selfId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const relationId = '44444444-4444-4444-8444-444444444444';

function uid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: selfId,
    work_id: workId,
    name: '林墨',
    aliases: [],
    identity: null,
    age: 20,
    gender: null,
    personality: '',
    experience: '',
    country_region: null,
    faith: null,
    faction: null,
    race: null,
    occupation: null,
    age_band: null,
    attributes: [],
    avatar_asset_id: null,
    status: 'active',
    merged_into_id: null,
    archived_at: null,
    origin: 'manual',
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function makeType(overrides: Partial<CharacterRelationType> = {}): CharacterRelationType {
  return {
    id: uid(30),
    work_id: workId,
    code: 'master',
    label: '师徒',
    group_key: 'bond',
    group_label: '羁绊',
    directed: true,
    reverse_label: '弟子',
    is_builtin: false,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function makeRelation(overrides: Partial<CharacterRelation> = {}): CharacterRelation {
  return {
    id: relationId,
    work_id: workId,
    source_id: selfId,
    target_id: otherId,
    type_id: uid(30),
    directed: true,
    label: '师徒',
    reverse_label: '弟子',
    color: '#3b82f6',
    line_style: 'solid',
    tag: '主线',
    origin: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function makeClient(overrides: Partial<Record<keyof CharacterClient, unknown>> = {}): CharacterClient {
  const base = {
    listRelations: vi.fn(async () => [makeRelation()]),
    listRelationTypes: vi.fn(async () => [makeType()]),
    listCharacters: vi.fn(async () => ({
      items: [makeCharacter(), makeCharacter({ id: otherId, name: '沈星河' })],
      next_cursor: null
    })),
    createRelation: vi.fn(async () => ({ id: uid(500), created: true })),
    updateRelation: vi.fn(async () => makeRelation()),
    deleteRelation: vi.fn(async () => ({ deleted: true }))
  };
  return { ...base, ...overrides } as unknown as CharacterClient;
}

function renderPanel(client: CharacterClient, id: string | null = null) {
  return render(
    <CharacterRelationPanel workId={workId} characterId={selfId} client={client} relationId={id} />
  );
}

describe('CharacterRelationPanel T35', () => {
  it('加载本角色相关关系与关系类型，列表展示对方角色 / 标签 / 方向 / 颜色 / 线型', async () => {
    const client = makeClient();
    renderPanel(client);

    await waitFor(() => expect(client.listRelations).toHaveBeenCalledWith(workId, { character_id: selfId, include_archived: true }));
    expect(client.listRelationTypes).toHaveBeenCalledWith(workId);

    const row = await screen.findByRole('button', { name: /编辑与沈星河的关系/ });
    expect(row).toHaveTextContent('师徒');
    expect(row).toHaveTextContent('本角色 → 对方');
    expect(row).toHaveTextContent('#3b82f6');
    expect(row).toHaveTextContent('实线');
    expect(row).toHaveTextContent('主线');
  });

  it('无向关系类型不渲染反向称谓，提交时 reverse_label 为 null', async () => {
    const undirected = makeType({ id: uid(31), code: 'friend', label: '挚友', directed: false, reverse_label: null });
    const createRelation = vi.fn(async () => ({ id: uid(500), created: true }));
    const client = makeClient({
      listRelations: vi.fn(async () => []),
      listRelationTypes: vi.fn(async () => [undirected]),
      createRelation
    });
    renderPanel(client);

    await screen.findByText('暂无关系');
    fireEvent.click(screen.getByRole('button', { name: '新建关系' }));
    expect(screen.queryByLabelText('反向称谓')).toBeNull();
    expect(screen.getByText(/方向：无向/)).toBeVisible();

    fireEvent.change(screen.getByLabelText('对方角色'), { target: { value: otherId } });
    fireEvent.click(screen.getByRole('button', { name: '创建关系' }));

    await waitFor(() => expect(createRelation).toHaveBeenCalledTimes(1));
    expect((createRelation.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({
      source_id: selfId,
      target_id: otherId,
      type_id: undirected.id,
      directed: false,
      reverse_label: null
    });
  });

  it('有向关系类型渲染反向称谓并随创建提交', async () => {
    const directed = makeType();
    const createRelation = vi.fn(async () => ({ id: uid(500), created: true }));
    const client = makeClient({ listRelations: vi.fn(async () => []), createRelation });
    renderPanel(client);

    await screen.findByText('暂无关系');
    fireEvent.click(screen.getByRole('button', { name: '新建关系' }));
    const reverse = screen.getByLabelText('反向称谓');
    expect(reverse).toBeVisible();
    expect(screen.getByText(/方向：有向/)).toBeVisible();

    fireEvent.change(screen.getByLabelText('对方角色'), { target: { value: otherId } });
    fireEvent.change(reverse, { target: { value: '徒弟' } });
    fireEvent.click(screen.getByRole('button', { name: '创建关系' }));

    await waitFor(() => expect(createRelation).toHaveBeenCalledTimes(1));
    expect((createRelation.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({
      source_id: selfId,
      target_id: otherId,
      type_id: directed.id,
      directed: true,
      reverse_label: '徒弟'
    });
  });

  it('传入 relationId 进入编辑态，保存调用 updateRelation', async () => {
    const updateRelation = vi.fn(async () => makeRelation({ tag: '核心盟友' }));
    const client = makeClient({ updateRelation });
    renderPanel(client, relationId);

    const label = await screen.findByLabelText('关系称谓');
    expect(label).toHaveValue('师徒');
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '核心盟友' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(updateRelation).toHaveBeenCalledTimes(1));
    const call = updateRelation.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(call[0]).toBe(workId);
    expect(call[1]).toBe(relationId);
    expect(call[2]).toMatchObject({ label: '师徒', tag: '核心盟友', reverse_label: '弟子', line_style: 'solid' });
  });

  it('删除需要二次确认，确认后调用 deleteRelation', async () => {
    const deleteRelation = vi.fn(async () => ({ deleted: true as const }));
    const client = makeClient({ deleteRelation });
    renderPanel(client);

    fireEvent.click(await screen.findByRole('button', { name: '删除与沈星河的关系' }));
    const dialog = screen.getByRole('alertdialog', { name: '确认删除关系' });
    expect(dialog).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(deleteRelation).toHaveBeenCalledWith(workId, relationId));
  });

  it('提交失败用 characterErrorMessage 展示可读提示', async () => {
    const undirected = makeType({ id: uid(31), label: '挚友', directed: false, reverse_label: null });
    const createRelation = vi.fn(async () => {
      throw new ApiError(409, 'CHARACTER_RELATION_EXISTS', 'exists', {}, 'req-1');
    });
    const client = makeClient({
      listRelations: vi.fn(async () => []),
      listRelationTypes: vi.fn(async () => [undirected]),
      createRelation
    });
    renderPanel(client);

    await screen.findByText('暂无关系');
    fireEvent.click(screen.getByRole('button', { name: '新建关系' }));
    fireEvent.change(screen.getByLabelText('对方角色'), { target: { value: otherId } });
    fireEvent.click(screen.getByRole('button', { name: '创建关系' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('该关系已存在');
  });
});
