import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Character } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { CharacterClient } from './character-client';
import { CharacterArchiveView } from './character-archive-view';

const workId = '11111111-1111-4111-8111-111111111111';

function uid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function makeArchived(seed: number, overrides: Partial<Character> = {}): Character {
  return {
    id: uid(seed),
    work_id: workId,
    name: `归档角色${seed}`,
    aliases: [],
    identity: '剑客',
    age: 24,
    gender: '男',
    personality: '',
    experience: '',
    country_region: '中原',
    faith: null,
    faction: '正派',
    race: null,
    occupation: '游侠',
    age_band: null,
    attributes: [],
    avatar_asset_id: null,
    status: 'archived',
    merged_into_id: null,
    archived_at: '2026-01-02T03:04:00.000Z',
    origin: 'manual',
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T03:04:00.000Z',
    ...overrides
  };
}

function makeClient(overrides: Partial<CharacterClient> = {}): CharacterClient {
  const base = {
    listCharacters: vi.fn(async () => ({ items: [] as Character[], next_cursor: null })),
    getCharacter: vi.fn(async () => ({
      character: makeArchived(1, { status: 'active' }),
      relation_summary: { total: 0 },
      growth_event_count: 0
    })),
    restoreCharacter: vi.fn(async () => ({
      character: makeArchived(1, { status: 'active' }),
      duplicate_candidates: []
    }))
  };
  return { ...base, ...overrides } as unknown as CharacterClient;
}

describe('CharacterArchiveView T38', () => {
  it('按 archived 状态加载并在空列表展示「暂无归档角色」', async () => {
    const client = makeClient();
    render(<CharacterArchiveView workId={workId} client={client} />);

    expect(await screen.findByText('暂无归档角色')).toBeVisible();
    expect(client.listCharacters).toHaveBeenCalledWith(workId, { status: 'archived', limit: 100 });
  });

  it('列表展示姓名与归档时间，点击行加载只读详情（关系数 / 成长事件数）', async () => {
    const character = makeArchived(1, { name: '林墨' });
    const client = makeClient({
      listCharacters: vi.fn(async () => ({ items: [character], next_cursor: null })),
      getCharacter: vi.fn(async () => ({
        character,
        relation_summary: { total: 3 },
        growth_event_count: 5
      }))
    });
    const onSelect = vi.fn();
    render(<CharacterArchiveView workId={workId} client={client} onSelect={onSelect} />);

    const row = await screen.findByRole('button', { name: /林墨/ });
    expect(row.textContent).toContain('归档于 2026-01-02 03:04');

    fireEvent.click(row);

    expect(await screen.findByText('3 条关系')).toBeVisible();
    expect(screen.getByText('5 个成长事件')).toBeVisible();
    expect(screen.getByText('资料只读，恢复后可继续编辑。')).toBeVisible();
    expect(client.getCharacter).toHaveBeenCalledWith(workId, character.id);
    expect(onSelect).toHaveBeenCalledWith(character.id);
  });

  it('恢复需二次确认，成功后移除并提示疑似重复', async () => {
    const character = makeArchived(1, { name: '林墨' });
    const client = makeClient({
      listCharacters: vi.fn(async () => ({ items: [character], next_cursor: null })),
      restoreCharacter: vi.fn(async () => ({
        character: makeArchived(1, { name: '林墨', status: 'active' }),
        duplicate_candidates: [
          { character_id: uid(9), name: '李慕白', matched_on: 'name' as const },
          { character_id: uid(10), name: '林墨白', matched_on: 'alias' as const }
        ]
      }))
    });
    const onRestored = vi.fn();
    render(<CharacterArchiveView workId={workId} client={client} onRestored={onRestored} />);

    fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
    expect(screen.getByRole('alertdialog', { name: '确认恢复角色' })).toBeVisible();
    expect(client.restoreCharacter).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));

    expect(await screen.findByText('疑似重复：李慕白、林墨白')).toBeVisible();
    expect(client.restoreCharacter).toHaveBeenCalledWith(workId, character.id);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /林墨/ })).toBeNull();
    expect(screen.getByText('暂无归档角色')).toBeVisible();
  });

  it('取消二次确认不会发起恢复请求', async () => {
    const character = makeArchived(1, { name: '林墨' });
    const client = makeClient({
      listCharacters: vi.fn(async () => ({ items: [character], next_cursor: null }))
    });
    render(<CharacterArchiveView workId={workId} client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.restoreCharacter).not.toHaveBeenCalled();
  });

  it('不提供永久删除入口（无永久清理）', async () => {
    const client = makeClient({
      listCharacters: vi.fn(async () => ({ items: [makeArchived(1, { name: '林墨' })], next_cursor: null }))
    });
    const view = render(<CharacterArchiveView workId={workId} client={client} />);

    await screen.findByRole('button', { name: /林墨/ });
    expect(screen.queryByRole('button', { name: /删除|永久清理/ })).toBeNull();
    expect(view.container.textContent).toContain('不会永久删除');
  });

  it('加载失败展示 alert 并可重试', async () => {
    const character = makeArchived(1, { name: '林墨' });
    let attempt = 0;
    const client = makeClient({
      listCharacters: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new ApiError(500, 'INTERNAL', '归档列表读取失败', {}, 'req-1');
        return { items: [character], next_cursor: null };
      })
    });
    render(<CharacterArchiveView workId={workId} client={client} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('归档列表读取失败');

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('button', { name: /林墨/ })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(client.listCharacters).toHaveBeenCalledTimes(2);
  });
});
