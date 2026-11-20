import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  AiItemStatus,
  Character,
  CharacterAiCandidateItem,
  CharacterAiDraft
} from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { CharacterClient } from './character-client';
import { CharacterAiPreview } from './character-ai-preview';

// 硬约束：用 mock client，不连真实后端
const workId = '11111111-1111-4111-8111-111111111111';
const existingA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const existingB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function uid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function makeCharacterEntity(seed: number, name: string): Character {
  return {
    id: uid(seed),
    work_id: workId,
    name,
    aliases: [],
    identity: null,
    age: null,
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
    updated_at: '2026-01-01T00:00:00Z'
  };
}

function makeDraft(seed: number, overrides: Partial<CharacterAiDraft> = {}): CharacterAiDraft {
  return {
    id: uid(seed),
    work_id: workId,
    kind: 'characters_relations',
    input_scope: 'work',
    input_chapter_id: null,
    status: 'succeeded',
    summary: null,
    error: null,
    task_id: null,
    idempotency_key: `key-${seed}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function makeCharacterItem(
  seed: number,
  name: string,
  options: {
    status?: AiItemStatus;
    duplicates?: CharacterAiCandidateItem['suspected_duplicates'];
    draftId?: string;
  } = {}
): CharacterAiCandidateItem {
  return {
    id: uid(seed),
    draft_id: options.draftId ?? uid(100),
    item_index: seed,
    dependencies: [],
    suspected_duplicates: options.duplicates ?? [],
    status: options.status ?? 'pending',
    resolution: null,
    resolved_entity_id: null,
    resolved_at: null,
    kind: 'character',
    payload: {
      name,
      identity: null,
      age: null,
      gender: null,
      personality: '',
      experience: '',
      country_region: null,
      faith: null,
      faction: null,
      race: null,
      occupation: null,
      age_band: null,
      attributes: []
    }
  };
}

function makeRelationItem(
  seed: number,
  sourceId: string,
  targetId: string,
  label: string,
  draftId = uid(100)
): CharacterAiCandidateItem {
  return {
    id: uid(seed),
    draft_id: draftId,
    item_index: seed,
    dependencies: [],
    suspected_duplicates: [],
    status: 'pending',
    resolution: null,
    resolved_entity_id: null,
    resolved_at: null,
    kind: 'relation',
    payload: {
      source_ref: { kind: 'existing', id: sourceId },
      target_ref: { kind: 'existing', id: targetId },
      type_code: 'master',
      directed: true,
      label,
      reverse_label: null,
      line_style: 'solid'
    }
  };
}

function makeGrowthItem(seed: number, title: string, characterRefId: string, draftId = uid(100)): CharacterAiCandidateItem {
  return {
    id: uid(seed),
    draft_id: draftId,
    item_index: seed,
    dependencies: [],
    suspected_duplicates: [],
    status: 'pending',
    resolution: null,
    resolved_entity_id: null,
    resolved_at: null,
    kind: 'growth',
    payload: {
      character_ref: { kind: 'existing', id: characterRefId },
      title,
      content: '',
      event_time: null,
      plot_node_id: null,
      chapter_id: null
    }
  };
}

function makeClient(overrides: Partial<CharacterClient> = {}): CharacterClient {
  return {
    listAiDrafts: vi.fn(async () => []),
    getAiDraft: vi.fn(),
    listCharacters: vi.fn(async () => ({ items: [], next_cursor: null })),
    confirmAiItem: vi.fn(),
    rejectAiItem: vi.fn(),
    confirmAiBatch: vi.fn(),
    ...overrides
  } as unknown as CharacterClient;
}

describe('CharacterAiPreview T37', () => {
  it('取最近草稿并展示进度，候选按角色/关系/成长分组且引用显示为可读名称', async () => {
    const older = makeDraft(101, { created_at: '2026-01-01T00:00:00Z' });
    const newer = makeDraft(102, { created_at: '2026-03-01T00:00:00Z', status: 'succeeded' });
    const lin = makeCharacterEntity(1, '林墨');
    const shen = makeCharacterEntity(2, '沈星河');
    const items = [
      makeCharacterItem(11, '林牧', { draftId: newer.id }),
      makeRelationItem(12, lin.id, shen.id, '师徒', newer.id),
      makeGrowthItem(13, '拜入师门', lin.id, newer.id)
    ];
    const client = makeClient({
      listAiDrafts: vi.fn(async () => [older, newer]),
      getAiDraft: vi.fn(async () => ({ draft: newer, items })),
      listCharacters: vi.fn(async () => ({ items: [lin, shen], next_cursor: null }))
    });
    render(<CharacterAiPreview workId={workId} client={client} />);

    expect(await screen.findByText('草稿进度：已生成（共 3 条候选）')).toBeVisible();
    expect(client.getAiDraft).toHaveBeenCalledWith(workId, newer.id);
    expect(client.listCharacters).toHaveBeenCalledWith(workId, { limit: 100 });

    expect(await screen.findByRole('region', { name: '角色候选' })).toBeVisible();
    expect(screen.getByRole('region', { name: '关系候选' })).toBeVisible();
    expect(screen.getByRole('region', { name: '成长候选' })).toBeVisible();

    const relationGroup = screen.getByRole('region', { name: '关系候选' });
    expect(relationGroup.textContent).toContain('林墨');
    expect(relationGroup.textContent).toContain('沈星河');
    expect(relationGroup.textContent).toContain('师徒');
  });

  it('疑似重复必须选择处理方式；选 merge 后传 target_character_id，确认后不可重复提交', async () => {
    const draft = makeDraft(100);
    const item = makeCharacterItem(11, '林牧', {
      duplicates: [{ character_id: existingA, name: '林墨', matched_on: 'name' }],
      draftId: draft.id
    });
    const confirmAiItem = vi.fn(async () => ({
      item: { ...item, status: 'confirmed' as const, resolution: 'merge' as const, resolved_entity_id: existingA }
    }));
    const onCommitted = vi.fn();
    const client = makeClient({
      listAiDrafts: vi.fn(async () => [draft]),
      getAiDraft: vi.fn(async () => ({ draft, items: [item] })),
      confirmAiItem
    });
    render(<CharacterAiPreview workId={workId} client={client} onCommitted={onCommitted} />);

    const confirmButton = await screen.findByRole('button', { name: /确认「林牧」/ });
    expect(confirmButton).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: '合并到已有角色' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '林牧 的合并目标' }), existingA);
    await waitFor(() => expect(confirmButton).toBeEnabled());

    await userEvent.click(confirmButton);
    await waitFor(() =>
      expect(confirmAiItem).toHaveBeenCalledWith(workId, draft.id, item.id, {
        mode: 'merge',
        target_character_id: existingA
      })
    );
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: '已确认' })).toBeDisabled();
  });

  it('逐条拒绝后状态为已拒绝，且再次不可提交', async () => {
    const draft = makeDraft(100);
    const item = makeCharacterItem(11, '林牧', { draftId: draft.id });
    const rejectAiItem = vi.fn(async () => ({ item: { ...item, status: 'rejected' as const } }));
    const onCommitted = vi.fn();
    const client = makeClient({
      listAiDrafts: vi.fn(async () => [draft]),
      getAiDraft: vi.fn(async () => ({ draft, items: [item] })),
      rejectAiItem
    });
    render(<CharacterAiPreview workId={workId} client={client} onCommitted={onCommitted} />);

    await userEvent.click(await screen.findByRole('button', { name: /拒绝「林牧」/ }));
    await waitFor(() => expect(rejectAiItem).toHaveBeenCalledWith(workId, draft.id, item.id));
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: '已拒绝' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /拒绝「林牧」/ })).toBeNull();
  });

  it('批量确认只提交 pending 条目；疑似重复未决策时按钮禁用，决策后带 resolutions 提交', async () => {
    const draft = makeDraft(100);
    const plain = makeCharacterItem(11, '甲', { draftId: draft.id });
    const duplicate = makeCharacterItem(12, '乙', {
      duplicates: [{ character_id: existingA, name: '林墨', matched_on: 'alias' }],
      draftId: draft.id
    });
    const confirmed = makeCharacterItem(13, '丙', { draftId: draft.id, status: 'confirmed' });
    const confirmAiBatch = vi.fn(async () => ({ confirmed: 2, rejected: 0 }));
    const onCommitted = vi.fn();
    const client = makeClient({
      listAiDrafts: vi.fn(async () => [draft]),
      getAiDraft: vi.fn(async () => ({ draft, items: [plain, duplicate, confirmed] })),
      confirmAiBatch
    });
    render(<CharacterAiPreview workId={workId} client={client} onCommitted={onCommitted} />);

    const batchButton = await screen.findByRole('button', { name: '批量确认所选' });
    expect(batchButton).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: '选择 丙' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '全选待处理候选' }));
    expect(screen.getByText('已选 2 / 2 条')).toBeVisible();
    expect(batchButton).toBeDisabled();
    expect(screen.getByText(/选中的疑似重复候选需先选择处理方式/)).toBeVisible();

    await userEvent.click(screen.getByRole('radio', { name: '保持独立' }));
    await waitFor(() => expect(batchButton).toBeEnabled());
    await userEvent.click(batchButton);

    await waitFor(() =>
      expect(confirmAiBatch).toHaveBeenCalledWith(workId, draft.id, {
        item_ids: [plain.id, duplicate.id],
        resolutions: [{ item_id: duplicate.id, action: 'keep_independent' }]
      })
    );
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已批量确认 2 条候选')).toBeVisible();
    // 甲、乙转为已确认，加上原有的丙，共 3 条已确认（均不可再提交）
    expect(screen.getAllByRole('button', { name: '已确认' })).toHaveLength(3);
    expect(screen.queryByRole('checkbox', { name: /选择/ })).toBeNull();
  });

  it('空候选显示明确提示', async () => {
    const draft = makeDraft(100);
    const client = makeClient({
      listAiDrafts: vi.fn(async () => [draft]),
      getAiDraft: vi.fn(async () => ({ draft, items: [] }))
    });
    render(<CharacterAiPreview workId={workId} client={client} />);

    expect(await screen.findByText('本次没有可确认的候选。')).toBeVisible();
    expect(screen.queryByRole('button', { name: '批量确认所选' })).toBeNull();
  });

  it('加载失败展示可读错误', async () => {
    const client = makeClient({
      listAiDrafts: vi.fn(async () => [makeDraft(100)]),
      getAiDraft: vi.fn(async () => {
        throw new ApiError(500, 'INTERNAL', '草稿读取失败', {}, 'req-1');
      })
    });
    render(<CharacterAiPreview workId={workId} client={client} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('草稿读取失败');
    expect(screen.queryByRole('region', { name: '角色候选' })).toBeNull();
  });

  it('角色名映射失败时降级显示 id 前 8 位，不阻塞候选渲染', async () => {
    const draft = makeDraft(100);
    const items = [makeRelationItem(12, existingA, existingB, '宿敌', draft.id)];
    const client = makeClient({
      listAiDrafts: vi.fn(async () => [draft]),
      getAiDraft: vi.fn(async () => ({ draft, items })),
      listCharacters: vi.fn(async () => {
        throw new Error('名单读取失败');
      })
    });
    render(<CharacterAiPreview workId={workId} client={client} />);

    const relationGroup = await screen.findByRole('region', { name: '关系候选' });
    expect(relationGroup.textContent).toContain('aaaaaaaa');
    expect(relationGroup.textContent).toContain('bbbbbbbb');
    expect(relationGroup.textContent).toContain('宿敌');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
