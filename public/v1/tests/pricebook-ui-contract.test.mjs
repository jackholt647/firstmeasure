import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pricebook = await readFile(new URL('../../libraries/pricebook/firstmate-pricebook.js', import.meta.url), 'utf8');

test('variant images use upload previews and fixed-frame crop controls', () => {
  assert.match(pricebook, /type="file" accept="image\/\*" data-pb-image-input/);
  assert.match(pricebook, /class="pb-crop-ghost"/);
  assert.match(pricebook, /class="pb-crop-frame"/);
  assert.match(pricebook, /pb-crop-handle nw/);
  assert.match(pricebook, /image_crop:normalizeImageCrop\(crop\)/);
  assert.match(pricebook, /\/pricebook\/pricebooks\/\$\{encodeURIComponent\(remotePricebookId\)\}\/assets/);
  assert.doesNotMatch(pricebook, /Optional image URL/);
});

test('variant editors retain the compact three-column and two-row layout', () => {
  assert.match(pricebook, /\.pb-value-list\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(pricebook, /\.pb-value-editor\{grid-template-columns:[^}]+grid-template-rows:auto auto/);
  assert.match(pricebook, /\.pb-value-editor \.pb-value-remove\{grid-column:4;grid-row:1/);
  assert.match(pricebook, /\.pb-color-picker\{[^}]+border-radius:9px;background:var\(--swatch\)/);
});

test('standard price book fields use the tightened control density', () => {
  assert.match(pricebook, /\.pb-field input,\.pb-field textarea,\.pb-field select\{width:100%;padding:8px 10px/);
  assert.match(pricebook, /\.pb-field textarea\{min-height:58px/);
});

test('summary and variants share one full-height editor surface with a fixed tab header', () => {
  assert.match(pricebook, /\.pb-main\{padding:16px;overflow:hidden;min-height:0\}/);
  assert.match(pricebook, /\.pb-editor-surface\{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#fff/);
  assert.match(pricebook, /\.pb-editor-scroll\{flex:1;min-height:0;overflow:auto/);
  assert.match(pricebook, /<div class="pb-editor-header">/);
  assert.match(pricebook, /pb-editor-header-actions[^]*data-pb-add-dimension/);
  assert.doesNotMatch(pricebook, /<h3>Dimensions<\/h3>/);
});
