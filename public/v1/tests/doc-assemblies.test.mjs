import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const M = require('../../libraries/doc-model/firstmate-doc-model.js');
globalThis.FMDocModel = M;
const FMDocEditor = require('../../libraries/doc-editor/firstmate-doc-editor.js');

/** A two-option selection: a group per option holding its title, price and an optional image. */
function selectionDocument() {
  const doc = M.createDocument({ kind: 'document' });
  const part = (role, key) => ({ part: { assembly: 'asm', role, ...(key === undefined ? {} : { key }) } });
  const option = (key) => M.createNode('frame', {
    id: `opt${key}`, props: { fmde_group: true, ...part('option', key) },
    children: [
      M.createNode('text', { id: `title${key}`, props: part('option.title', key) }),
      M.createNode('text', { id: `price${key}`, props: part('option.price', key) }),
      M.createNode('image', { id: `image${key}`, props: part('option.image', key) })
    ]
  });
  doc.assemblies = { asm: { type: 'choice_selection', name: 'Shingle selection', required: [{ role: 'option', min: 1 }, { role: 'option.title', per: 'option' }, { role: 'option.price', per: 'option' }] } };
  doc.pages = [M.createPage('custom', { id: 'p1', children: [
    M.createNode('frame', { id: 'widget', props: { fmde_group: true }, children: [M.createNode('text', { id: 'heading', props: part('title') }), option('0'), option('1')] }),
    M.createNode('text', { id: 'other' })
  ] })];
  return doc;
}
const engineFor = (doc) => FMDocEditor._createCommandEngine({ M, getDoc: () => doc, getFlags: () => FMDocEditor.PROFILE_FLAGS.designer, getProfile: () => 'designer' });

test('a required piece cannot be deleted alone; optional pieces, whole options and the whole widget can', () => {
  const doc = selectionDocument();
  const engine = engineFor(doc);
  assert.equal(M.validateDocument(doc).ok, true);
  assert.equal(engine.apply({ type: 'node.remove', node_id: 'price0' }).reason, 'required_part:asm');
  assert.equal(engine.apply({ type: 'node.remove', node_id: 'image0' }).ok, true, 'the image is optional');
  assert.equal(engine.apply({ type: 'node.remove', node_id: 'heading' }).ok, true, 'so is the heading');
  assert.equal(engine.apply({ type: 'node.remove', node_id: 'opt1' }).ok, true, 'an option goes with all of its pieces');
  assert.equal(engine.apply({ type: 'node.remove', node_id: 'opt0' }).ok, true, 'taking the last pieces deletes the widget');
});

test('pieces keep working when moved out of their group, and the document will not save without them', () => {
  const doc = selectionDocument();
  const engine = engineFor(doc);
  // Pull a price out of its option onto the page: still that option's price.
  assert.equal(engine.apply({ type: 'node.move', node_id: 'price1', page_id: 'p1' }).ok, true);
  assert.equal(M.findNode(doc, 'price1').parent, null);
  assert.equal(M.validateDocument(doc).ok, true);
  assert.equal(M.partRemovalBlock(doc, ['price1']).assembly, 'asm');
  // The option's group no longer holds its price, so deleting the group alone would strand it.
  assert.equal(engine.apply({ type: 'node.remove', node_id: 'opt1' }).ok, true, 'the option and its title go; the stray price is no longer required');
  assert.equal(M.assemblyParts(doc, 'asm').some((entry) => entry.node.id === 'price1'), true);
  // Deleting everything is how the widget is deleted.
  assert.equal(M.partRemovalBlock(doc, ['widget', 'price1']), null);
  // A document that lost a required piece some other way is rejected.
  const broken = selectionDocument();
  M.removeNode(broken, 'title0');
  const result = M.validateDocument(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Missing required part: option\.title \(0\)/);
  // One with no pieces left has simply lost the widget.
  const emptied = selectionDocument();
  M.removeNode(emptied, 'widget');
  assert.equal(M.validateDocument(emptied).ok, true);
  assert.deepEqual(Object.keys(M.pruneAssemblies(emptied).assemblies), []);
});
