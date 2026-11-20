import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { PlotTreeService } from './plot-tree.service';

let fixture: WritingFixture;
let service: PlotTreeService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new PlotTreeService(fixture.dataSource, { record: vi.fn() } as never);
});

afterEach(() => destroyWritingFixture(fixture));

async function createTree(title = '主线') {
  return service.createTree(fixture.authorId, fixture.workId, { title });
}

describe('PlotTreeService · 剧情树', () => {
  it('creates a tree and returns an empty structure', async () => {
    const result = await createTree();
    expect(result.tree?.title).toBe('主线');
    expect(result.tree?.version).toBe(1);
    expect(result.tree?.source).toBe('manual');
    expect(result.nodes).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.groups).toEqual([]);
  });

  it('rejects a second tree for the same work with 409', async () => {
    await createTree();
    await expect(createTree('第二棵')).rejects.toBeInstanceOf(ConflictException);
  });

  it('hides trees from other authors with 404', async () => {
    await createTree();
    await expect(service.getTree(fixture.otherAuthorId, fixture.workId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an empty tree response when the work has no tree', async () => {
    const result = await service.getTree(fixture.authorId, fixture.workId);
    expect(result).toEqual({ tree: null, nodes: [], links: [], groups: [] });
  });
});

describe('PlotTreeService · 节点', () => {
  it('creates a root node and increments the tree version', async () => {
    await createTree();
    const created = await service.createNode(fixture.authorId, fixture.workId, {
      title: '初遇', content: '雨夜旅馆', position: { x: 10, y: 20 }
    });
    expect(created.node.title).toBe('初遇');
    expect(created.node.parent_id).toBeNull();
    expect(created.node.position).toEqual({ x: 10, y: 20 });
    expect(created.version).toBe(2);
  });

  it('rejects a missing parent with 404', async () => {
    await createTree();
    await expect(
      service.createNode(fixture.authorId, fixture.workId, {
        title: '子节点', parent_id: crypto.randomUUID(), position: { x: 0, y: 0 }
      })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates node fields and rejects stale expected_version with 409', async () => {
    await createTree();
    const { node } = await service.createNode(fixture.authorId, fixture.workId, {
      title: '初遇', position: { x: 0, y: 0 }
    });
    const updated = await service.updateNode(fixture.authorId, fixture.workId, node.id, {
      title: '初遇（改）', summary: '一句话', expected_version: 2
    });
    expect(updated.node.title).toBe('初遇（改）');
    expect(updated.node.summary).toBe('一句话');
    expect(updated.version).toBe(3);

    await expect(
      service.updateNode(fixture.authorId, fixture.workId, node.id, { title: '过期写', expected_version: 2 })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects making a node its own parent or moving it under a descendant', async () => {
    await createTree();
    const root = await service.createNode(fixture.authorId, fixture.workId, {
      title: '根', position: { x: 0, y: 0 }
    });
    const child = await service.createNode(fixture.authorId, fixture.workId, {
      title: '子', parent_id: root.node.id, position: { x: 0, y: 0 }
    });
    await expect(
      service.moveNode(fixture.authorId, fixture.workId, root.node.id, { parent_id: root.node.id })
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.moveNode(fixture.authorId, fixture.workId, root.node.id, { parent_id: child.node.id })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('moves a node to root and appends sibling order', async () => {
    await createTree();
    const root = await service.createNode(fixture.authorId, fixture.workId, {
      title: '根', position: { x: 0, y: 0 }
    });
    const child = await service.createNode(fixture.authorId, fixture.workId, {
      title: '子', parent_id: root.node.id, position: { x: 0, y: 0 }
    });
    const moved = await service.moveNode(fixture.authorId, fixture.workId, child.node.id, { parent_id: null });
    expect(moved.node.parent_id).toBeNull();
    expect(moved.node.sibling_order).toBe(1);
  });

  it('deletes a node together with its subtree and reports the count', async () => {
    await createTree();
    const a = await service.createNode(fixture.authorId, fixture.workId, {
      title: 'A', position: { x: 0, y: 0 }
    });
    const b = await service.createNode(fixture.authorId, fixture.workId, {
      title: 'B', parent_id: a.node.id, position: { x: 0, y: 0 }
    });
    await service.createNode(fixture.authorId, fixture.workId, {
      title: 'C', parent_id: b.node.id, position: { x: 0, y: 0 }
    });

    const deleted = await service.deleteNode(fixture.authorId, fixture.workId, b.node.id);
    expect(deleted.deleted).toBe(2);
    const remaining = await service.getTree(fixture.authorId, fixture.workId);
    expect(remaining.nodes.map((n) => n.title)).toEqual(['A']);
  });

  it('updates positions without bumping the structure version and ignores unknown nodes', async () => {
    await createTree();
    const { node } = await service.createNode(fixture.authorId, fixture.workId, {
      title: '节点', position: { x: 0, y: 0 }
    });
    const before = await service.getTree(fixture.authorId, fixture.workId);
    const result = await service.updatePositions(fixture.authorId, fixture.workId, {
      positions: [
        { node_id: node.id, x: 120, y: 80 },
        { node_id: crypto.randomUUID(), x: 1, y: 1 }
      ]
    });
    expect(result.updated).toBe(1);
    const after = await service.getTree(fixture.authorId, fixture.workId);
    expect(after.tree?.version).toBe(before.tree?.version);
    expect(after.nodes[0]!.position).toEqual({ x: 120, y: 80 });
  });
});

describe('PlotTreeService · 分组', () => {
  it('creates groups, assigns nodes, and deletes the group without deleting nodes', async () => {
    await createTree();
    const { node } = await service.createNode(fixture.authorId, fixture.workId, {
      title: '节点', position: { x: 0, y: 0 }
    });
    const { group } = await service.createGroup(fixture.authorId, fixture.workId, {
      name: '侦探线', kind: 'swimlane'
    });
    const assigned = await service.assignGroup(fixture.authorId, fixture.workId, node.id, { group_id: group.id });
    expect(assigned.node.group_id).toBe(group.id);

    await service.deleteGroup(fixture.authorId, fixture.workId, group.id);
    const after = await service.getTree(fixture.authorId, fixture.workId);
    expect(after.groups).toEqual([]);
    expect(after.nodes).toHaveLength(1);
    expect(after.nodes[0]!.group_id).toBeNull();
  });

  it('rejects duplicate group names with 409', async () => {
    await createTree();
    await service.createGroup(fixture.authorId, fixture.workId, { name: '同组', kind: 'group' });
    await expect(
      service.createGroup(fixture.authorId, fixture.workId, { name: '同组', kind: 'group' })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects assigning a node to a group from another tree with 404', async () => {
    await createTree();
    const { node } = await service.createNode(fixture.authorId, fixture.workId, {
      title: '节点', position: { x: 0, y: 0 }
    });
    await expect(
      service.assignGroup(fixture.authorId, fixture.workId, node.id, { group_id: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
