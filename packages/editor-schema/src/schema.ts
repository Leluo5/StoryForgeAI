import { Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

// 基础 schema 不含列表节点，追加有序/无序列表以支持 Markdown 白名单；
// 显式声明 tight 属性，保证 Markdown 往返时紧凑/宽松列表不被丢失
const listNodes = addListNodes(basicSchema.spec.nodes.remove('image'), 'paragraph block*', 'block');
const nodes = listNodes
  .update('bullet_list', { ...listNodes.get('bullet_list'), attrs: { tight: { default: true } } })
  .update('ordered_list', {
    ...listNodes.get('ordered_list'),
    attrs: { order: { default: 1 }, tight: { default: true } }
  });

export const schema = new Schema({
  nodes,
  marks: basicSchema.spec.marks
});
