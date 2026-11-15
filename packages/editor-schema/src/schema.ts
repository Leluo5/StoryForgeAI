import { Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';

export const schema = new Schema({
  nodes: basicSchema.spec.nodes.remove('image'),
  marks: basicSchema.spec.marks
});
