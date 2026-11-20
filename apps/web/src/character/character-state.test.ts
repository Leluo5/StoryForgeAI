import { describe, expect, it } from 'vitest';
import type { CharacterBoardResponse } from '@storyforge/contracts';
import {
  characterErrorMessage,
  filterCharacters,
  findLayoutEntry,
  hasArranged,
  toBoardData,
  toViewFilters
} from './character-state';
import type { CharacterFilters, CharacterLayoutPosition } from './character-state';
import { ApiError } from '../api/client';

const characterIdA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const characterIdB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const characterIdC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const baseCharacters: CharacterBoardResponse['characters'] = [
  { id: characterIdA, name: '林墨', status: 'active', avatar_asset_id: null, six_dim: { country_region: '中原', faith: '道家', faction: '正派', race: '汉人', occupation: '侠客', age_band: '青年' } },
  { id: characterIdB, name: '沈星河', status: 'active', avatar_asset_id: null, six_dim: { country_region: '江南', faith: null, faction: '邪派', race: '汉人', occupation: null, age_band: '青年' } },
  { id: characterIdC, name: '老鬼', status: 'archived', avatar_asset_id: null, six_dim: { country_region: null, faith: '佛家', faction: null, race: null, occupation: '和尚', age_band: '老年' } }
];

describe('filterCharacters', () => {
  it('returns all when filters are empty', () => {
    expect(filterCharacters(baseCharacters, {})).toHaveLength(3);
  });
  it('matches keyword against name and six_dim fields', () => {
    expect(filterCharacters(baseCharacters, { keyword: '墨' }).map((c) => c.id)).toEqual([characterIdA]);
    expect(filterCharacters(baseCharacters, { keyword: '老' }).map((c) => c.id)).toEqual([characterIdC]);
    expect(filterCharacters(baseCharacters, { keyword: '   ' })).toHaveLength(3);
    expect(filterCharacters(baseCharacters, { keyword: '不存在' })).toHaveLength(0);
  });
  it('filters by six dims', () => {
    expect(filterCharacters(baseCharacters, { faction: '正派' }).map((c) => c.id)).toEqual([characterIdA]);
    expect(filterCharacters(baseCharacters, { age_band: '青年' })).toHaveLength(2);
    expect(filterCharacters(baseCharacters, { country_region: '中原', occupation: '侠客' }).map((c) => c.id)).toEqual([characterIdA]);
  });
  it('treats null as match-empty-value vs undefined as no-filter', () => {
    expect(filterCharacters(baseCharacters, {} as CharacterFilters)).toHaveLength(3);
    expect(filterCharacters(baseCharacters, { country_region: null })).toHaveLength(1);
  });
});

describe('toViewFilters / toBoardData', () => {
  it('serializes only non-undefined filter keys', () => {
    const result = toViewFilters({ keyword: '墨', faction: '正派', faith: null });
    expect(result).toEqual({ keyword: '墨', faction: '正派', faith: null });
    expect(Object.keys(result)).not.toContain('age_band');
  });
  it('wraps board response into local data shape', () => {
    const board = (chars: CharacterBoardResponse['characters']): CharacterBoardResponse => ({
      view: { id: 'view-1', name: '默认视图', filters: {}, version: 1, is_default: true },
      characters: chars, relations: [], relation_types: [], layout: []
    });
    const data = toBoardData(board(baseCharacters));
    expect(data.characters).toHaveLength(3);
    expect(data.view.name).toBe('默认视图');
  });
});

describe('layout helpers', () => {
  const layout: CharacterLayoutPosition[] = [
    { character_id: characterIdA, x: 100, y: 200, arranged: true, sort_index: 0 },
    { character_id: characterIdB, x: null, y: null, arranged: false, sort_index: 1 },
    { character_id: characterIdC, x: 300, y: 400, arranged: true, sort_index: 2 }
  ];
  it('finds entry by character id', () => {
    const found = findLayoutEntry(layout, characterIdB);
    expect(found).toMatchObject({ arranged: false, x: null });
    expect(findLayoutEntry(layout, 'missing')).toBeNull();
  });
  it('detects whether any entry has been arranged', () => {
    expect(hasArranged(layout)).toBe(true);
    expect(hasArranged([{ character_id: characterIdB, x: null, y: null, arranged: false, sort_index: 0 }])).toBe(false);
    expect(hasArranged([])).toBe(false);
  });
});

describe('characterErrorMessage', () => {
  it('translates 409 VERSION_CONFLICT to actionable Chinese', () => {
    expect(characterErrorMessage(new ApiError(409, 'CHARACTER_VERSION_CONFLICT', 'c', {}, 'r1'))).toContain('刷新');
  });
  it('falls back to server message or generic wording', () => {
    expect(characterErrorMessage(new ApiError(500, 'UNKNOWN', 'boom', {}, 'r1'))).toBe('boom');
    expect(characterErrorMessage(new Error('网络'))).toBe('网络');
    expect(characterErrorMessage(null)).toBe('角色操作失败');
  });
  it('maps documented character error codes', () => {
    const codes = [
      'CHARACTER_DEFAULT_VIEW_LOCKED',
      'CHARACTER_RELATION_SELF',
      'CHARACTER_RELATION_EXISTS',
      'CHARACTER_RELATION_TYPE_IN_USE',
      'CHARACTER_ARCHIVE_SCAN_RUNNING',
      'AI_TOOL_DISABLED'
    ];
    for (const code of codes) {
      const msg = characterErrorMessage(new ApiError(409, code, '', {}, 'r1'));
      expect(msg).not.toBe('角色操作失败');
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
