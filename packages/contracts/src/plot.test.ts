import { describe, expect, it } from 'vitest';
import {
  plotNodeAttributesSchema,
  plotPositionSchema,
  plotNodeSchema,
  plotTreeResponseSchema,
  plotTreeQuerySchema,
  setPlotNodeOwnersRequestSchema,
  plotNodeOwnersResponseSchema,
  importPlotTreeRequestSchema,
  createPlotLinkRequestSchema,
  createDerivationSessionRequestSchema,
  derivationStepSchema,
  createDerivationCandidateRequestSchema,
  createPlotGenerationRequestSchema,
  commitPlotGenerationRequestSchema
} from './plot';

const uuid = () => crypto.randomUUID();
const now = new Date().toISOString();

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    tree_id: uuid(),
    parent_id: null,
    sibling_order: 0,
    title: '初遇',
    summary: null,
    content: '',
    attributes: {},
    position: { x: 0, y: 0 },
    group_id: null,
    origin: 'manual',
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

describe('plot contracts', () => {
  it('enforces strict node attributes and position bounds', () => {
    expect(plotNodeAttributesSchema.safeParse({ time_point: '第三夜', place: '旅馆' }).success).toBe(true);
    expect(plotNodeAttributesSchema.safeParse({ unknown: 'x' }).success).toBe(false);
    expect(plotPositionSchema.safeParse({ x: 1_000_001, y: 0 }).success).toBe(false);
    expect(plotPositionSchema.safeParse({ x: 10.5, y: 0 }).success).toBe(false);
  });

  it('accepts an empty tree response and rejects a non-nullable tree payload', () => {
    const empty = plotTreeResponseSchema.parse({ tree: null, nodes: [], links: [], groups: [] });
    expect(empty.tree).toBeNull();
    expect(plotTreeResponseSchema.safeParse({ tree: { title: 'x' }, nodes: [], links: [], groups: [] }).success).toBe(
      false
    );
  });

  it('rejects duplicate link source and target, and unknown link type', () => {
    const id = uuid();
    expect(
      createPlotLinkRequestSchema.safeParse({
        source_id: id,
        target_id: id,
        type: 'linear'
      }).success
    ).toBe(false);
    expect(
      createPlotLinkRequestSchema.safeParse({
        source_id: uuid(),
        target_id: uuid(),
        type: 'bogus'
      }).success
    ).toBe(false);
  });

  it('requires schema_version=1 on import and validates node count cap', () => {
    const payload = {
      schema_version: 1,
      exported_at: now,
      tree: { title: '主线' },
      nodes: [node()],
      links: [],
      groups: []
    };
    expect(importPlotTreeRequestSchema.safeParse(payload).success).toBe(true);
    expect(importPlotTreeRequestSchema.safeParse({ ...payload, schema_version: 2 }).success).toBe(false);
    expect(
      importPlotTreeRequestSchema.safeParse({
        ...payload,
        nodes: Array.from({ length: 2001 }, () => node())
      }).success
    ).toBe(false);
  });

  it('requires at least one character and at most 20 in a derivation session', () => {
    const base = {
      start_node_id: uuid(),
      place: '雾都旅馆',
      background: '侦探调查失踪案'
    };
    expect(createDerivationSessionRequestSchema.safeParse({ ...base, characters: [] }).success).toBe(false);
    expect(
      createDerivationSessionRequestSchema.safeParse({
        ...base,
        characters: [{ name: '林远', description: '侦探' }]
      }).success
    ).toBe(true);
    expect(
      createDerivationSessionRequestSchema.safeParse({
        ...base,
        characters: Array.from({ length: 21 }, () => ({ name: '角色', description: '' }))
      }).success
    ).toBe(false);
  });

  it('validates derivation step branches (2~4) and character payload', () => {
    const step = {
      id: uuid(),
      session_id: uuid(),
      step_no: 1,
      content: '停电了',
      event: null,
      new_characters: [],
      branches: [
        { id: 'a', label: '追问', description: '继续追问' },
        { id: 'b', label: '离开', description: '按兵不动' }
      ],
      chosen_branch_id: null,
      task_id: null,
      created_at: now,
      updated_at: now
    };
    expect(derivationStepSchema.safeParse(step).success).toBe(true);
    expect(derivationStepSchema.safeParse({ ...step, branches: [step.branches[0]] }).success).toBe(false);
  });

  it('caps candidate payload at 50 nodes', () => {
    const candidates = Array.from({ length: 51 }, () => ({ title: '节点', summary: null, content: '', parent_index: null }));
    expect(createDerivationCandidateRequestSchema.safeParse({ split_by_step: false, placement: 'child' }).success).toBe(
      true
    );
    expect(
      createDerivationCandidateRequestSchema.safeParse({
        split_by_step: false,
        placement: 'child',
        payload: { nodes: candidates }
      }).success
    ).toBe(false);
  });

  it('requires text for outline generation and chapter for novel_text generation', () => {
    expect(createPlotGenerationRequestSchema.safeParse({ source: 'outline', text: '短' }).success).toBe(false);
    expect(
      createPlotGenerationRequestSchema.safeParse({ source: 'outline', text: '第一幕：初遇，雨夜的旅馆大厅。' }).success
    ).toBe(true);
    expect(createPlotGenerationRequestSchema.safeParse({ source: 'novel_text' }).success).toBe(false);
    expect(
      createPlotGenerationRequestSchema.safeParse({ source: 'novel_text', chapter_id: uuid() }).success
    ).toBe(true);
  });

  it('requires explicit overwrite confirmation when committing a generation draft', () => {
    expect(commitPlotGenerationRequestSchema.safeParse({ mode: 'replace' }).success).toBe(false);
    expect(commitPlotGenerationRequestSchema.safeParse({ mode: 'replace', confirm_overwrite: true }).success).toBe(true);
    expect(commitPlotGenerationRequestSchema.safeParse({ mode: 'append' }).success).toBe(true);
  });

  it('keeps node schema strict on origin and required title', () => {
    expect(plotNodeSchema.safeParse(node()).success).toBe(true);
    expect(plotNodeSchema.safeParse(node({ origin: 'bogus' })).success).toBe(false);
    expect(plotNodeSchema.safeParse(node({ title: '' })).success).toBe(false);
  });

  it('validates node owner requests without duplicate characters', () => {
    const characterId = uuid();
    expect(setPlotNodeOwnersRequestSchema.safeParse({ owners: [] }).success).toBe(true);
    expect(
      setPlotNodeOwnersRequestSchema.safeParse({
        owners: [{ character_id: characterId, is_exclusive: true }]
      }).success
    ).toBe(true);
    expect(
      setPlotNodeOwnersRequestSchema.safeParse({
        owners: [
          { character_id: characterId, is_exclusive: true },
          { character_id: characterId, is_exclusive: false }
        ]
      }).success
    ).toBe(false);
    expect(
      setPlotNodeOwnersRequestSchema.safeParse({
        owners: Array.from({ length: 11 }, () => ({ character_id: uuid(), is_exclusive: false }))
      }).success
    ).toBe(false);
  });

  it('parses old tree responses and responses carrying owners', () => {
    expect(plotTreeResponseSchema.safeParse({ tree: null, nodes: [], links: [], groups: [] }).success).toBe(true);
    const characterId = uuid();
    const nodeId = uuid();
    const response = {
      tree: null,
      nodes: [],
      links: [],
      groups: [],
      owners: [{ node_id: nodeId, character_id: characterId, is_exclusive: true }],
      archived_owner_nodes: [{ node_id: nodeId, character_ids: [characterId], position: { x: 1, y: 2 } }]
    };
    expect(plotTreeResponseSchema.safeParse(response).success).toBe(true);
    expect(
      plotNodeOwnersResponseSchema.safeParse({
        node_id: nodeId,
        owners: [{ node_id: nodeId, character_id: characterId, is_exclusive: false }]
      }).success
    ).toBe(true);
  });

  it('defaults includeArchivedOwner to false and coerces query strings', () => {
    expect(plotTreeQuerySchema.parse({})).toEqual({ includeArchivedOwner: false });
    expect(plotTreeQuerySchema.parse({ includeArchivedOwner: 'true' })).toEqual({ includeArchivedOwner: true });
  });
});
