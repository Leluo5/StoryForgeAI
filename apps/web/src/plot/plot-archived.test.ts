import { describe, expect, it } from 'vitest';
import type { ArchivedOwnerNode, PlotNodeOwner } from '@storyforge/contracts';
import {
  ARCHIVED_EDGE_LABEL,
  ARCHIVED_OWNER_STORAGE_PREFIX,
  ARCHIVED_PARENT_HINT,
  ARCHIVED_STUB_OFFSET,
  archivedNodeIds,
  archivedOwnerStorageKey,
  archivedStubPosition,
  isArchivedParent,
  MAX_NODE_OWNERS,
  ownerDraftKey,
  ownersFromServer,
  resolveIncludeArchivedOwner,
  setOwnerExclusive,
  toggleOwnerDraft,
  type PreferenceStorage
} from './plot-archived';

function memoryStorage(seed: Record<string, string> = {}): PreferenceStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map)
  };
}

const workId = '11111111-1111-4111-8111-111111111111';

describe('plot-archived 本地偏好', () => {
  it('按作品生成 localStorage 键', () => {
    expect(archivedOwnerStorageKey(workId)).toBe(`${ARCHIVED_OWNER_STORAGE_PREFIX}${workId}`);
  });

  it('优先级为 URL > localStorage > 默认 false', () => {
    const storage = memoryStorage({ [archivedOwnerStorageKey(workId)]: '1' });
    expect(resolveIncludeArchivedOwner(workId, '', storage)).toEqual({ value: true, fromUrl: false });

    const empty = memoryStorage();
    expect(resolveIncludeArchivedOwner(workId, '', empty)).toEqual({ value: false, fromUrl: false });
  });

  it('深链 includeArchivedOwner=1 覆盖本地偏好并回写', () => {
    const storage = memoryStorage({ [archivedOwnerStorageKey(workId)]: '0' });
    const result = resolveIncludeArchivedOwner(workId, '?includeArchivedOwner=1', storage);
    expect(result).toEqual({ value: true, fromUrl: true });
    expect(storage.getItem(archivedOwnerStorageKey(workId))).toBe('1');

    const off = resolveIncludeArchivedOwner(workId, '?includeArchivedOwner=0', storage);
    expect(off).toEqual({ value: false, fromUrl: true });
    expect(storage.getItem(archivedOwnerStorageKey(workId))).toBe('0');
  });
});

describe('plot-archived 隐藏父节点与 stub', () => {
  const archived: ArchivedOwnerNode[] = [
    { node_id: 'p', character_ids: ['c1'], position: { x: 300, y: 120 } }
  ];

  it('识别归档节点与归档父级', () => {
    expect([...archivedNodeIds(archived)]).toEqual(['p']);
    expect(isArchivedParent({ parent_id: 'p' }, archivedNodeIds(archived))).toBe(true);
    expect(isArchivedParent({ parent_id: null }, archivedNodeIds(archived))).toBe(false);
    expect(isArchivedParent({ parent_id: 'other' }, archivedNodeIds(archived))).toBe(false);
  });

  it('stub 优先使用后端坐标，缺失时按固定偏移', () => {
    expect(archivedStubPosition(archived[0], { x: 0, y: 0 })).toEqual({ x: 300, y: 120 });
    expect(archivedStubPosition(undefined, { x: 20, y: 30 })).toEqual({
      x: 20 + ARCHIVED_STUB_OFFSET,
      y: 30
    });
    expect(ARCHIVED_EDGE_LABEL).toBe('归档角色剧情');
    expect(ARCHIVED_PARENT_HINT).toBe('父节点属于归档角色剧情');
  });
});

describe('plot-archived 归属选择', () => {
  const owners: PlotNodeOwner[] = [
    { node_id: 'n1', character_id: 'b', is_exclusive: true },
    { node_id: 'n1', character_id: 'a', is_exclusive: false }
  ];

  it('服务端归属转草稿并按角色 id 稳定排序', () => {
    expect(ownersFromServer(owners)).toEqual([
      { character_id: 'a', is_exclusive: false },
      { character_id: 'b', is_exclusive: true }
    ]);
  });

  it('勾选/取消与 ≤10 上限', () => {
    let draft = toggleOwnerDraft([], 'a');
    expect(draft).toEqual([{ character_id: 'a', is_exclusive: false }]);
    expect(toggleOwnerDraft(draft, 'a')).toEqual([]);

    for (let index = 0; index < MAX_NODE_OWNERS; index += 1) {
      draft = toggleOwnerDraft(draft, `c${index}`);
    }
    expect(draft).toHaveLength(MAX_NODE_OWNERS);
    // 超过上限不再新增
    expect(toggleOwnerDraft(draft, 'overflow')).toHaveLength(MAX_NODE_OWNERS);
  });

  it('专属标记切换与稳定比较键', () => {
    const draft = setOwnerExclusive([{ character_id: 'a', is_exclusive: false }], 'a', true);
    expect(draft).toEqual([{ character_id: 'a', is_exclusive: true }]);
    expect(ownerDraftKey(draft)).toBe('a:1');
    expect(ownerDraftKey([
      { character_id: 'b', is_exclusive: true },
      { character_id: 'a', is_exclusive: false }
    ])).toBe('a:0|b:1');
  });
});
