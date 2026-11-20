import { Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

// 基础 schema 不含列表节点，追加有序/无序列表以支持 Markdown 白名单；
// 显式声明 tight 属性，保证 Markdown 往返时紧凑/宽松列表不被丢失
const listNodes = addListNodes(basicSchema.spec.nodes.remove('image'), 'paragraph block*', 'block');
const nodes = listNodes
  // 块级 pid：契约层可选（默认 null），保存/扫描前由 ensurePids 补齐；heading 保留 level
  .update('paragraph', { ...listNodes.get('paragraph'), attrs: { pid: { default: null } } })
  .update('heading', {
    ...listNodes.get('heading'),
    attrs: { level: { default: 1 }, pid: { default: null } }
  })
  .update('bullet_list', { ...listNodes.get('bullet_list'), attrs: { tight: { default: true } } })
  .update('ordered_list', {
    ...listNodes.get('ordered_list'),
    attrs: { order: { default: 1 }, tight: { default: true } }
  });

export const schema = new Schema({
  nodes,
  marks: basicSchema.spec.marks
});
