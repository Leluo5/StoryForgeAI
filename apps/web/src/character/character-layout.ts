import type { CharacterBoardResponse } from '@storyforge/contracts';
import type { CharacterLayoutPosition, CharacterPoint, CharacterPositionUpdate } from './character-state';

export const CHARACTER_CARD_WIDTH = 180;
export const CHARACTER_CARD_HEIGHT = 110;
export const CHARACTER_GAP = 40;
export const GRID_COL_WIDTH = CHARACTER_CARD_WIDTH + CHARACTER_GAP;
export const GRID_ROW_HEIGHT = CHARACTER_CARD_HEIGHT + CHARACTER_GAP;
export const GRID_ORIGIN_X = 40;
export const GRID_ORIGIN_Y = 40;
export const POSITION_LIMIT = 1_000_000;

export function clampCharacterPosition(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded > POSITION_LIMIT) return POSITION_LIMIT;
  if (rounded < -POSITION_LIMIT) return -POSITION_LIMIT;
  return rounded;
}

export interface CharacterBox { character_id: string; x: number; y: number; width: number; height: number; }

export function cardBox(characterId: string, point: CharacterPoint): CharacterBox {
  return { character_id: characterId, x: point.x, y: point.y, width: CHARACTER_CARD_WIDTH, height: CHARACTER_CARD_HEIGHT };
}

export function boxesOverlap(a: CharacterBox, b: CharacterBox): boolean {
  return !(a.x + a.width + CHARACTER_GAP <= b.x || b.x + b.width + CHARACTER_GAP <= a.x ||
           a.y + a.height + CHARACTER_GAP <= b.y || b.y + b.height + CHARACTER_GAP <= a.y);
}

export function autoCharacterLayout(
  characters: CharacterBoardResponse['characters'],
  layout: CharacterLayoutPosition[]
): Record<string, CharacterPoint> {
  const layoutMap = new Map(layout.map((entry) => [entry.character_id, entry]));
  const points: Record<string, CharacterPoint> = {};
  const arrangedBoxes: CharacterBox[] = [];
  const unarranged: string[] = [];

  for (const character of characters) {
    const entry = layoutMap.get(character.id);
    if (entry && entry.arranged && entry.x !== null && entry.y !== null) {
      const point: CharacterPoint = { x: clampCharacterPosition(entry.x), y: clampCharacterPosition(entry.y) };
      points[character.id] = point;
      arrangedBoxes.push(cardBox(character.id, point));
    } else {
      unarranged.push(character.id);
    }
  }

  unarranged.sort((a, b) => {
    const ea = layoutMap.get(a);
    const eb = layoutMap.get(b);
    const si = (ea?.sort_index ?? 0) - (eb?.sort_index ?? 0);
    if (si !== 0) return si;
    return a.localeCompare(b);
  });

  let col = 0;
  let row = 0;
  for (const characterId of unarranged) {
    let placed = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const attemptCol = col + attempt;
      const attemptRow = row + Math.floor(attempt / 100);
      const candidate: CharacterPoint = {
        x: clampCharacterPosition(GRID_ORIGIN_X + attemptCol * GRID_COL_WIDTH),
        y: clampCharacterPosition(GRID_ORIGIN_Y + attemptRow * GRID_ROW_HEIGHT)
      };
      const box = cardBox(characterId, candidate);
      const conflict = arrangedBoxes.some((existing) => boxesOverlap(existing, box));
      if (!conflict) {
        points[characterId] = candidate;
        arrangedBoxes.push(box);
        col = attemptCol + 1;
        row = attemptRow;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const fallback: CharacterPoint = {
        x: clampCharacterPosition(GRID_ORIGIN_X + col * GRID_COL_WIDTH),
        y: clampCharacterPosition(GRID_ORIGIN_Y + row * GRID_ROW_HEIGHT)
      };
      points[characterId] = fallback;
      col += 1;
    }
  }
  return points;
}

export function characterLayoutSnapshot(layout: CharacterLayoutPosition[]): CharacterPositionUpdate[] {
  return layout
    .filter((entry) => entry.arranged && entry.x !== null && entry.y !== null)
    .map((entry) => ({ character_id: entry.character_id, x: clampCharacterPosition(entry.x!), y: clampCharacterPosition(entry.y!) }));
}

export function diffCharacterLayout(
  layout: CharacterLayoutPosition[],
  next: Record<string, CharacterPoint>
): CharacterPositionUpdate[] {
  const updates: CharacterPositionUpdate[] = [];
  for (const entry of layout) {
    const point = next[entry.character_id];
    if (!point) continue;
    const x = clampCharacterPosition(point.x);
    const y = clampCharacterPosition(point.y);
    if (entry.x !== x || entry.y !== y) updates.push({ character_id: entry.character_id, x, y });
  }
  for (const [characterId, point] of Object.entries(next)) {
    if (layout.some((entry) => entry.character_id === characterId)) continue;
    updates.push({ character_id: characterId, x: clampCharacterPosition(point.x), y: clampCharacterPosition(point.y) });
  }
  return updates;
}

export function validateNoOverlap(points: Record<string, CharacterPoint>): string[] {
  const ids = Object.keys(points);
  const violations: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = cardBox(ids[i]!, points[ids[i]!]!);
      const b = cardBox(ids[j]!, points[ids[j]!]!);
      if (boxesOverlap(a, b)) {
        if (!violations.includes(ids[i]!)) violations.push(ids[i]!);
        if (!violations.includes(ids[j]!)) violations.push(ids[j]!);
      }
    }
  }
  return violations;
}

export function characterLayoutBounds(points: Record<string, CharacterPoint>): {
  minX: number; minY: number; maxX: number; maxY: number; width: number; height: number;
} | null {
  const entries = Object.values(points);
  if (entries.length === 0) return null;
  const xs = entries.map((p) => p.x);
  const ys = entries.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs) + CHARACTER_CARD_WIDTH;
  const maxY = Math.max(...ys) + CHARACTER_CARD_HEIGHT;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
