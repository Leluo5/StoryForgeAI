import { describe, expect, it } from 'vitest';
import type { CharacterBoardResponse } from '@storyforge/contracts';
import {
  CHARACTER_CARD_HEIGHT,
  CHARACTER_CARD_WIDTH,
  GRID_COL_WIDTH,
  GRID_ORIGIN_X,
  GRID_ORIGIN_Y,
  GRID_ROW_HEIGHT,
  POSITION_LIMIT,
  autoCharacterLayout,
  boxesOverlap,
  cardBox,
  characterLayoutBounds,
  characterLayoutSnapshot,
  clampCharacterPosition,
  diffCharacterLayout,
  validateNoOverlap
} from './character-layout';
import type { CharacterLayoutPosition, CharacterPoint } from './character-state';

const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeChars(): CharacterBoardResponse['characters'] {
  return [
    { id: idA, name: 'A', status: 'active', avatar_asset_id: null, six_dim: {} as never },
    { id: idB, name: 'B', status: 'active', avatar_asset_id: null, six_dim: {} as never },
    { id: idC, name: 'C', status: 'active', avatar_asset_id: null, six_dim: {} as never }
  ];
}

describe('clampCharacterPosition', () => {
  it('clamps into contract limits and rounds', () => {
    expect(clampCharacterPosition(2_000_000)).toBe(POSITION_LIMIT);
    expect(clampCharacterPosition(-2_000_000)).toBe(-POSITION_LIMIT);
    expect(clampCharacterPosition(123.7)).toBe(124);
    expect(clampCharacterPosition(NaN)).toBe(0);
    expect(clampCharacterPosition(Infinity)).toBe(0);
  });
});

describe('boxesOverlap', () => {
  it('detects overlap and honours the gap', () => {
    const a = cardBox(idA, { x: 0, y: 0 });
    const b = cardBox(idB, { x: CHARACTER_CARD_WIDTH + 1, y: 0 });
    const c = cardBox(idC, { x: CHARACTER_CARD_WIDTH + 100, y: 0 });
    expect(boxesOverlap(a, b)).toBe(true);
    expect(boxesOverlap(a, c)).toBe(false);
    expect(boxesOverlap(a, a)).toBe(true);
  });
});

describe('autoCharacterLayout', () => {
  const characters = makeChars();

  it('uses grid origin and fills sequentially for empty layout', () => {
    const points = autoCharacterLayout(characters, []);
    expect(points[idA]).toEqual({ x: GRID_ORIGIN_X, y: GRID_ORIGIN_Y });
    expect(points[idB]).toEqual({ x: GRID_ORIGIN_X + GRID_COL_WIDTH, y: GRID_ORIGIN_Y });
    expect(points[idC]).toEqual({ x: GRID_ORIGIN_X + GRID_COL_WIDTH * 2, y: GRID_ORIGIN_Y });
  });

  it('preserves manually arranged coordinates and avoids collisions', () => {
    const layout: CharacterLayoutPosition[] = [
      { character_id: idA, x: 9999, y: 8888, arranged: true, sort_index: 0 },
      { character_id: idB, x: null, y: null, arranged: false, sort_index: 1 },
      { character_id: idC, x: null, y: null, arranged: false, sort_index: 2 }
    ];
    const points = autoCharacterLayout(characters, layout);
    expect(points[idA]).toEqual({ x: 9999, y: 8888 });
    for (const p of [points[idB]!, points[idC]!]) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
      expect(clampCharacterPosition(p.x)).toBe(p.x);
      expect(clampCharacterPosition(p.y)).toBe(p.y);
    }
    expect(boxesOverlap(cardBox(idB, points[idB]!), cardBox(idC, points[idC]!))).toBe(false);
  });

  it('is deterministic regardless of character input order', () => {
    const rev = [...characters].reverse();
    expect(autoCharacterLayout(characters, [])).toEqual(autoCharacterLayout(rev, []));
  });

  it('produces integer coordinates within bounds', () => {
    const points = autoCharacterLayout(characters, []);
    for (const p of Object.values(points)) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
      expect(clampCharacterPosition(p.x)).toBe(p.x);
      expect(clampCharacterPosition(p.y)).toBe(p.y);
    }
  });

  it('handles empty input gracefully', () => {
    expect(autoCharacterLayout([], [])).toEqual({});
  });

  it('avoids overlap when existing arranged card occupies a cell', () => {
    const layout: CharacterLayoutPosition[] = [
      { character_id: idA, x: GRID_ORIGIN_X, y: GRID_ORIGIN_Y, arranged: true, sort_index: 0 }
    ];
    const points = autoCharacterLayout(characters, layout);
    const entries = Object.entries(points);
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [id1, p1] = entries[i]!;
        const [id2, p2] = entries[j]!;
        if (id1 !== id2) expect(boxesOverlap(cardBox(id1, p1!), cardBox(id2, p2!))).toBe(false);
      }
    }
  });
});

describe('snapshot + diff', () => {
  const layout: CharacterLayoutPosition[] = [
    { character_id: idA, x: 100, y: 200, arranged: true, sort_index: 0 },
    { character_id: idB, x: 300, y: 400, arranged: true, sort_index: 1 },
    { character_id: idC, x: null, y: null, arranged: false, sort_index: 2 }
  ];
  it('snapshots only arranged-with-coords entries', () => {
    expect(characterLayoutSnapshot(layout)).toEqual([
      { character_id: idA, x: 100, y: 200 },
      { character_id: idB, x: 300, y: 400 }
    ]);
  });
  it('diffs only actually changed coordinates', () => {
    const next: Record<string, CharacterPoint> = {
      [idA]: { x: 100, y: 200 }, [idB]: { x: 350, y: 400 }, [idC]: { x: 500, y: 600 }
    };
    const diff = diffCharacterLayout(layout, next);
    expect(diff).toHaveLength(2);
    expect(diff.map((d) => d.character_id).sort()).toEqual([idB, idC].sort());
  });
});

describe('validateNoOverlap', () => {
  it('reports conflicting ids', () => {
    const points: Record<string, CharacterPoint> = {
      [idA]: { x: 0, y: 0 }, [idB]: { x: 1, y: 1 }, [idC]: { x: 10_000, y: 10_000 }
    };
    const violations = validateNoOverlap(points);
    expect(violations.sort()).toEqual([idA, idB].sort());
    expect(violations).not.toContain(idC);
  });
  it('returns empty array when all cards are safe', () => {
    const points: Record<string, CharacterPoint> = {
      [idA]: { x: 0, y: 0 }, [idB]: { x: GRID_COL_WIDTH, y: 0 }, [idC]: { x: GRID_COL_WIDTH, y: GRID_ROW_HEIGHT }
    };
    expect(validateNoOverlap(points)).toEqual([]);
  });
});

describe('characterLayoutBounds', () => {
  it('returns null on empty input', () => { expect(characterLayoutBounds({})).toBeNull(); });
  it('returns AABB including card size', () => {
    const result = characterLayoutBounds({ [idA]: { x: 10, y: 20 }, [idB]: { x: 100, y: 200 } });
    expect(result).toMatchObject({ minX: 10, minY: 20 });
    expect(result!.width).toBeGreaterThan(CHARACTER_CARD_WIDTH);
    expect(result!.height).toBeGreaterThan(CHARACTER_CARD_HEIGHT);
  });
});
