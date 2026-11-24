import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { CreateModelInput } from '@storyforge/contracts';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { ModelService } from './model.service';

let fixture: WritingFixture;
let service: ModelService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new ModelService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

function createInput(overrides: Partial<CreateModelInput> = {}): CreateModelInput {
  return {
    name: 'GPT-4o Mini',
    provider: 'openai',
    model_id: 'gpt-4o-mini',
    context_window: 128000,
    supports_tools: true,
    supports_vision: true,
    input_price: 0.15,
    output_price: 0.6,
    currency: 'USD',
    status: 'active',
    sort_order: 10,
    ...overrides
  };
}

describe('ModelService', () => {
  // ── createModel ──

  it('creates a model with defaults and numeric price mapping', async () => {
    const model = await service.createModel(fixture.authorId, {
      name: '默认模型',
      model_id: 'default-model'
    });
    expect(model.name).toBe('默认模型');
    expect(model.provider).toBe('other');
    expect(model.status).toBe('active');
    expect(model.context_window).toBe(0);
    expect(model.supports_tools).toBe(false);
    expect(model.supports_vision).toBe(false);
    expect(model.input_price).toBe(0);
    expect(model.output_price).toBe(0);
    expect(model.currency).toBe('USD');
    expect(model.sort_order).toBe(0);
    expect(model.author_id).toBe(fixture.authorId);
  });

  it('persists full fields with price as number (numeric string → number)', async () => {
    const model = await service.createModel(fixture.authorId, createInput());
    expect(model.input_price).toBe(0.15);
    expect(model.output_price).toBe(0.6);
    expect(model.provider).toBe('openai');
    expect(model.context_window).toBe(128000);
  });

  it('rejects duplicate model_id for the same author with 409', async () => {
    await service.createModel(fixture.authorId, createInput());
    await expect(service.createModel(fixture.authorId, createInput({ name: '另一个' })))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('allows the same model_id for a different author', async () => {
    await service.createModel(fixture.authorId, createInput());
    const model = await service.createModel(fixture.otherAuthorId, createInput());
    expect(model.author_id).toBe(fixture.otherAuthorId);
  });

  // ── listModels ──

  it('lists models for the author only, with keyword and status filtering', async () => {
    const a = await service.createModel(fixture.authorId, createInput({ name: '主线模型', model_id: 'main-1' }));
    const b = await service.createModel(fixture.authorId, createInput({ name: '支线模型', model_id: 'sub-1', status: 'disabled' }));
    await service.createModel(fixture.otherAuthorId, createInput({ model_id: 'other-1' }));

    const all = await service.listModels(fixture.authorId, {});
    expect(all.total).toBe(2);
    expect(all.models.every((i) => i.author_id === fixture.authorId)).toBe(true);

    const byKeyword = await service.listModels(fixture.authorId, { keyword: '主线' });
    expect(byKeyword.total).toBe(1);
    expect(byKeyword.models[0]?.id).toBe(a.id);

    const byStatus = await service.listModels(fixture.authorId, { status: 'disabled' });
    expect(byStatus.total).toBe(1);
    expect(byStatus.models[0]?.id).toBe(b.id);
  });

  it('sorts by sort_order ASC then created_at DESC', async () => {
    const low = await service.createModel(fixture.authorId, createInput({ name: '低权重', model_id: 'low', sort_order: 0 }));
    const high = await service.createModel(fixture.authorId, createInput({ name: '高权重', model_id: 'high', sort_order: 100 }));
    const zero = await service.createModel(fixture.authorId, createInput({ name: '零权重', model_id: 'zero', sort_order: 0 }));

    const list = await service.listModels(fixture.authorId, {});
    const ids = list.models.map((m) => m.id);
    // sort_order 0（低权重在前），零权重因 created_at DESC 在低权重之前
    expect(ids).toEqual([zero.id, low.id, high.id]);
  });

  it('paginates model list with skip/take', async () => {
    for (let i = 0; i < 5; i++) {
      await service.createModel(fixture.authorId, createInput({ name: `m-${i}`, model_id: `m-${i}` }));
    }
    const page2 = await service.listModels(fixture.authorId, { page: 2, page_size: 2 });
    expect(page2.models).toHaveLength(2);
    expect(page2.page).toBe(2);
    expect(page2.page_size).toBe(2);
  });

  // ── getModel ──

  it('gets model detail for the owner and rejects cross-author read', async () => {
    const model = await service.createModel(fixture.authorId, createInput());
    const detail = await service.getModel(fixture.authorId, model.id);
    expect(detail.id).toBe(model.id);

    await expect(service.getModel(fixture.otherAuthorId, model.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getModel(fixture.authorId, randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── updateModel ──

  it('updates whitelisted fields', async () => {
    const model = await service.createModel(fixture.authorId, createInput());
    const updated = await service.updateModel(fixture.authorId, model.id, {
      name: '新名字',
      input_price: 0.25,
      status: 'disabled',
      sort_order: 5
    });
    expect(updated.name).toBe('新名字');
    expect(updated.input_price).toBe(0.25);
    expect(updated.status).toBe('disabled');
    expect(updated.sort_order).toBe(5);
    // 未触及字段保留
    expect(updated.provider).toBe('openai');
    expect(updated.context_window).toBe(128000);
  });

  it('allows toggling active/disabled via update (no archived)', async () => {
    const model = await service.createModel(fixture.authorId, createInput());
    const disabled = await service.updateModel(fixture.authorId, model.id, { status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    const active = await service.updateModel(fixture.authorId, model.id, { status: 'active' });
    expect(active.status).toBe('active');
  });

  it('rejects updating model_id to a duplicate for the same author (excluding self)', async () => {
    await service.createModel(fixture.authorId, createInput({ model_id: 'gpt-4o' }));
    const b = await service.createModel(fixture.authorId, createInput({ name: 'B', model_id: 'claude-3' }));
    await expect(service.updateModel(fixture.authorId, b.id, { model_id: 'gpt-4o' }))
      .rejects.toBeInstanceOf(ConflictException);
    // 自身 model_id 不变允许
    const ok = await service.updateModel(fixture.authorId, b.id, { model_id: 'claude-3' });
    expect(ok.model_id).toBe('claude-3');
  });

  it('rejects updating a non-owned or missing model with 404', async () => {
    const model = await service.createModel(fixture.authorId, createInput());
    await expect(service.updateModel(fixture.otherAuthorId, model.id, { name: 'x' }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateModel(fixture.authorId, randomUUID(), { name: 'x' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── deleteModel ──

  it('hard-deletes a model directly (no force required)', async () => {
    const model = await service.createModel(fixture.authorId, createInput());
    const res = await service.deleteModel(fixture.authorId, model.id);
    expect(res.deleted).toBe(true);
    expect(res.id).toBe(model.id);

    await expect(service.getModel(fixture.authorId, model.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects deleting a non-owned or missing model with 404', async () => {
    const model = await service.createModel(fixture.authorId, createInput());
    await expect(service.deleteModel(fixture.otherAuthorId, model.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.deleteModel(fixture.authorId, randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
