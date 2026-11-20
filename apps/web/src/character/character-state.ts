import { createContext, useContext } from 'react';
import type {
  CharacterBoardResponse,
  CharacterRelation,
  CharacterRelationType,
  CharacterView,
  CharacterViewFilters
} from '@storyforge/contracts';
import { ApiError } from '../api/client';

export interface CharacterLayoutPosition {
  character_id: string;
  x: number | null;
  y: number | null;
  arranged: boolean;
  sort_index: number;
}

export interface CharacterPoint { x: number; y: number; }

export interface CharacterPositionUpdate { character_id: string; x: number; y: number; }

export interface CharacterFilters {
  keyword?: string;
  country_region?: string | null;
  faith?: string | null;
  faction?: string | null;
  race?: string | null;
  occupation?: string | null;
  age_band?: string | null;
}

export interface CharacterBoardData {
  view: CharacterBoardResponse['view'];
  characters: CharacterBoardResponse['characters'];
  relations: CharacterRelation[];
  relation_types: CharacterRelationType[];
  layout: CharacterLayoutPosition[];
}

const ERROR_LABEL: Record<string, string> = {
  CHARACTER_VERSION_CONFLICT: '角色资料已被更新，请刷新后重试',
  CHARACTER_DEFAULT_VIEW_LOCKED: '默认视图不可删除',
  CHARACTER_RELATION_SELF: '关系两端不能是同一角色',
  CHARACTER_RELATION_EXISTS: '该关系已存在',
  CHARACTER_RELATION_TYPE_IN_USE: '该关系类型已被使用，无法删除',
  CHARACTER_RELATION_TYPE_DIRECTION_LOCKED: '关系类型方向已锁定，无法修改',
  CHARACTER_ALREADY_ARCHIVED: '角色已是归档状态',
  CHARACTER_NOT_ARCHIVED: '角色未归档，无法恢复',
  CHARACTER_MERGE_SELF: '不能合并到自己',
  CHARACTER_ARCHIVE_SCAN_RUNNING: '该角色已有扫描在进行中，请稍后',
  CHARACTER_AI_DRAFT_PENDING: '该角色已有进行中的 AI 草稿',
  CHARACTER_VIEW_NAME_EXISTS: '视图名称已存在',
  CHARACTER_IMPORT_INVALID: '导入文件校验未通过',
  AI_TOOL_DISABLED: 'AI 工具已停用，请在 Agent 管理中开启'
};

export function characterErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return ERROR_LABEL[cause.code] ?? `${cause.message}（版本冲突）`;
    return ERROR_LABEL[cause.code] ?? cause.message ?? '角色操作失败';
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return '角色操作失败';
}

export interface CharacterStore {
  workId: string;
  viewId: string | null;
  board: CharacterBoardData | null;
  views: CharacterView[];
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  filters: CharacterFilters;
  selectedCharacterId: string | null;
  selectedRelationId: string | null;
  lastLayoutSnapshot: CharacterPositionUpdate[] | null;
  setError(message: string): void;
  setNotice(message: string): void;
  setFilters(filters: CharacterFilters): void;
  selectCharacter(characterId: string | null): void;
  selectRelation(relationId: string | null): void;
  setViewId(viewId: string | null): void;
  reload(): Promise<void>;
  filterBoardCharacters(): CharacterBoardResponse['characters'];
  /** 拖拽结束批量提交坐标；成功后合并到本地 layout，失败展示错误并返回 false */
  saveLayout(updates: CharacterPositionUpdate[]): Promise<boolean>;
}

export const CharacterStoreContext = createContext<CharacterStore | null>(null);

export function useCharacterStore(): CharacterStore {
  const store = useContext(CharacterStoreContext);
  if (!store) throw new Error('useCharacterStore 必须在 CharacterStoreProvider 内使用');
  return store;
}

export function filterCharacters(
  characters: CharacterBoardResponse['characters'],
  filters: CharacterFilters
): CharacterBoardResponse['characters'] {
  const keyword = (filters.keyword ?? '').trim().toLowerCase();
  return characters.filter((character) => {
    if (keyword) {
      const haystack = [character.name, character.six_dim.country_region, character.six_dim.faith, character.six_dim.faction, character.six_dim.race, character.six_dim.occupation, character.six_dim.age_band]
        .filter((v): v is string => v != null)
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.country_region !== undefined) {
      const v = character.six_dim.country_region;
      if (filters.country_region === null ? v !== null : v !== filters.country_region) return false;
    }
    if (filters.faith !== undefined) {
      const v = character.six_dim.faith;
      if (filters.faith === null ? v !== null : v !== filters.faith) return false;
    }
    if (filters.faction !== undefined) {
      const v = character.six_dim.faction;
      if (filters.faction === null ? v !== null : v !== filters.faction) return false;
    }
    if (filters.race !== undefined) {
      const v = character.six_dim.race;
      if (filters.race === null ? v !== null : v !== filters.race) return false;
    }
    if (filters.occupation !== undefined) {
      const v = character.six_dim.occupation;
      if (filters.occupation === null ? v !== null : v !== filters.occupation) return false;
    }
    if (filters.age_band !== undefined) {
      const v = character.six_dim.age_band;
      if (filters.age_band === null ? v !== null : v !== filters.age_band) return false;
    }
    return true;
  });
}

export function toViewFilters(filters: CharacterFilters): CharacterViewFilters {
  const result: CharacterViewFilters = {};
  if (filters.keyword) result.keyword = filters.keyword;
  if (filters.country_region !== undefined) result.country_region = filters.country_region;
  if (filters.faith !== undefined) result.faith = filters.faith;
  if (filters.faction !== undefined) result.faction = filters.faction;
  if (filters.race !== undefined) result.race = filters.race;
  if (filters.occupation !== undefined) result.occupation = filters.occupation;
  if (filters.age_band !== undefined) result.age_band = filters.age_band;
  return result;
}

export function toBoardData(response: CharacterBoardResponse): CharacterBoardData {
  return {
    view: response.view,
    characters: response.characters,
    relations: response.relations as CharacterRelation[],
    relation_types: response.relation_types as CharacterRelationType[],
    layout: response.layout as CharacterLayoutPosition[]
  };
}

export function findLayoutEntry(layout: CharacterLayoutPosition[], characterId: string): CharacterLayoutPosition | null {
  return layout.find((entry) => entry.character_id === characterId) ?? null;
}

export function hasArranged(layout: CharacterLayoutPosition[]): boolean {
  return layout.some((entry) => entry.arranged);
}
