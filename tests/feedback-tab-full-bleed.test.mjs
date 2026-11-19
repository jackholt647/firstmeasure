// The Feedback portal tab fills the app area like every other app (GP-71): it is full-bleed, so the portal's grey
// shell inset never frames it or its welcome, and its host is the white page and its own scroller.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'public/libraries/apps', file), 'utf8');

test('portal.feedback is declared full-bleed, before and after its bundle loads', () => {
  const manifest = read('firstmate-apps-manifest.js');
  const entry = /\{\s*id: 'portal\.feedback',[\s\S]*?bundles:/.exec(manifest)?.[0];
  assert.ok(entry, 'portal.feedback manifest entry');
  assert.match(entry, /fullBleed: true/);
  assert.match(manifest, /'portal\.feedback': \{[^}]*fullBleed:true[^}]*\}/);
});

test('the Feedback host is a white scroller with no outer margin', () => {
  const css = /style\.textContent = '([^']+)'/.exec(read('feedback/app.js'))?.[1] || '';
  const host = /\.fm-feedback-host\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(host, /height:100%/);
  assert.match(host, /overflow:auto/);
  assert.match(host, /background:#fff/);
  assert.doesNotMatch(host, /margin|max-width/, 'the host fills the tab; only its content is capped');
});
