// The Phone workspace (phone-modal.js) writes "Loading voicemails…" and the other list messages
// straight into .fmpm-list-items, which has no padding of its own for its rows. GP-64: a message
// there is marked role="status" and that state is inset like the list heading, so it never sits
// against the window's edge; errors in the list go through the same state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/apps/comms/phone-modal.js'), 'utf8');

test('a list message is padded', () => {
  const match = /\.fmpm-list-items\[role=status\]\{([^}]*)\}/.exec(source);
  assert.ok(match, 'no rule for the list message state');
  assert.match(match[1], /padding:\d+px \d+px/);
});

test('every list loading message is in the padded state', () => {
  const lists = [...source.matchAll(/<div class="fmpm-list-items"([^>]*)>([^<]+)<\/div>/g)];
  assert.ok(lists.length >= 4, 'loading messages not found');
  for (const [, attrs, text] of lists) assert.match(attrs, /role="status"/, text);
});

test('list errors use the padded state, not bare text', () => {
  assert.doesNotMatch(source, /\.fmpm-list-items'\)\.textContent=/);
  assert.match(source, /const listMessage=.*setAttribute\('role','status'\)/);
});
