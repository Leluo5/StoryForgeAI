import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import {
  type ExportPlotTree,
  PlotTreeService
} from './plot-tree.service';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';

let fixture: WritingFixture;
let service: PlotTreeService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new PlotTreeService(fixture.dataSource, { record: vi.fn() } as never);
  await service.createTree(fixture.authorId, fixture.workId, { title: '主线' });
});

afterEach(() => destroyWritingFixture(fixture));

async function node(title: string, parentId: string | null = null) {
  const result = await service.createNode(fixture.authorId, fixture.workId, {
    title,
    parent_id: parentId,
    position: { x: 0, y: 0 }
  });
  return result.node;
}

describe('PlotTreeService · 关联', () => {
  it('creates a linear link and rejects duplicates', async () => {
    const a = await node('A');
    const b = await node('B');
    const created = await service.createLink(fixture.authorId, fixture.workId, {
      source_id: a.id,
      target_id: b.id,
      type: 'linear'
    });
    expect(created.link.type).toBe('linear');
    await expect(
      service.createLink(fixture.authorId, fixture.workId, {
        source_id: a.id,
        target_id: b.id,
        type: 'linear'
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a linear link that closes a cycle', async () => {
    const a = await node('A');
    const b = await node('B');
    const c = await node('C');
    await service.createLink(fixture.authorId, fixture.workId, { source_id: a.id, target_id: b.id, type: 'linear' });
    await service.createLink(fixture.authorId, fixture.workId, { source_id: b.id, target_id: c.id, type: 'linear' });
    await expect(
      service.createLink(fixture.authorId, fixture.workId, { source_id: c.id, target_id: a.id, type: 'linear' })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows non-linear links in both directions', async () => {
    const a = await node('A');
    const b = await node('B');
    await service.createLink(fixture.authorId, fixture.workId, { source_id: a.id, target_id: b.id, type: 'non_linear' });
    const reverse = await service.createLink(fixture.authorId, fixture.workId, {
      source_id: b.id,
      target_id: a.id,
      type: 'non_linear'
    });
    expect(reverse.link.target_id).toBe(a.id);
  });

  it('rejects self links', async () => {
    const a = await node('A');
    await expect(
      service.createLink(fixture.authorId, fixture.workId, { source_id: a.id, target_id: a.id, type: 'non_linear' })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes a link and bumps the version', async () => {
    const a = await node('A');
    const b = await node('B');
    const created = await service.createLink(fixture.authorId, fixture.workId, {
      source_id: a.id,
      target_id: b.id,
      type: 'linear'
    });
    const deleted = await service.deleteLink(fixture.authorId, fixture.workId, created.link.id);
    expect(deleted.version).toBe(created.version + 1);
    const after = await service.getTree(fixture.authorId, fixture.workId);
    expect(after.links).toEqual([]);
  });
});

describe('PlotTreeService · 导入导出', () => {
  it('exports the tree and reimports it with rebuilt identifiers', async () => {
    const a = await node('A');
    const b = await node('B', a.id);
    const group = await service.createGroup(fixture.authorId, fixture.workId, { name: '主线组', kind: 'group' });
    await service.assignGroup(fixture.authorId, fixture.workId, b.id, { group_id: group.group.id });
    await service.createLink(fixture.authorId, fixture.workId, { source_id: a.id, target_id: b.id, type: 'linear' });

    const exported: ExportPlotTree = await service.exportTree(fixture.authorId, fixture.workId);
    expect(exported.schema_version).toBe(1);
    expect(exported.nodes).toHaveLength(2);
    expect(exported.links).toHaveLength(1);
    expect(exported.groups).toHaveLength(1);

    const imported = await service.importTree(fixture.authorId, fixture.workId, exported);
    expect(imported.tree?.source).toBe('import');
    expect(imported.nodes).toHaveLength(2);
    expect(imported.groups).toHaveLength(1);
    const importedIds = new Set(imported.nodes.map((n) => n.id));
    for (const original of exported.nodes) expect(importedIds.has(original.id!)).toBe(false);
    const root = imported.nodes.find((n) => n.parent_id === null)!;
    const child = imported.nodes.find((n) => n.parent_id !== null)!;
    expect(child.parent_id).toBe(root.id);
    expect(child.group_id).toBe(imported.groups[0]!.id);
    expect(imported.links[0]!.source_id).toBe(root.id);
  });

  it('creates a tree on import when none exists', async () => {
    const exported = {
      schema_version: 1 as const,
      exported_at: new Date().toISOString(),
      tree: { title: '导入树' },
      nodes: [
        {
          id: crypto.randomUUID(),
          parent_id: null,
          sibling_order: 0,
          title: '根',
          summary: null,
          content: '',
          attributes: {},
          position: { x: 0, y: 0 },
          group_id: null,
          origin: 'import' as const
        }
      ],
      links: [],
      groups: []
    };
    const other = await createWritingFixture();
    try {
      const local = new PlotTreeService(other.dataSource, { record: vi.fn() } as never);
      const imported = await local.importTree(other.authorId, other.workId, exported);
      expect(imported.tree?.title).toBe('导入树');
      expect(imported.nodes).toHaveLength(1);
    } finally {
      await destroyWritingFixture(other);
    }
  });

  it('rejects duplicate node ids without touching the current tree', async () => {
    const before = await service.getTree(fixture.authorId, fixture.workId);
    const id = crypto.randomUUID();
    const baseNode = {
      id,
      parent_id: null,
      sibling_order: 0,
      title: '重复',
      summary: null,
      content: '',
      attributes: {},
      position: { x: 0, y: 0 },
      group_id: null,
      origin: 'import' as const
    };
    await expect(
      service.importTree(fixture.authorId, fixture.workId, {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        tree: { title: '坏树' },
        nodes: [baseNode, { ...baseNode, title: '重复2' }],
        links: [],
        groups: []
      })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    const after = await service.getTree(fixture.authorId, fixture.workId);
    expect(after.tree?.version).toBe(before.tree?.version);
    expect(after.nodes).toEqual(before.nodes);
  });

  it('rejects missing parent references', async () => {
    await expect(
      service.importTree(fixture.authorId, fixture.workId, {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        tree: { title: '坏树' },
        nodes: [
          {
            id: crypto.randomUUID(),
            parent_id: crypto.randomUUID(),
            sibling_order: 0,
            title: '孤儿',
            summary: null,
            content: '',
            attributes: {},
            position: { x: 0, y: 0 },
            group_id: null,
            origin: 'import' as const
          }
        ],
        links: [],
        groups: []
      })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects linear cycles in imported links', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const importedNode = (id: string, title: string) => ({
      id,
      parent_id: null,
      sibling_order: 0,
      title,
      summary: null,
      content: '',
      attributes: {},
      position: { x: 0, y: 0 },
      group_id: null,
      origin: 'import' as const
    });
    await expect(
      service.importTree(fixture.authorId, fixture.workId, {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        tree: { title: '环' },
        nodes: [importedNode(a, 'A'), importedNode(b, 'B')],
        links: [
          { source_id: a, target_id: b, type: 'linear' as const },
          { source_id: b, target_id: a, type: 'linear' as const }
        ],
        groups: []
      })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
