// FM-447: the project Checklists tab header keeps "New checklist" as a plus
// icon beside the "New from Audio" mic, never a full-width button on phones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/libraries/apps/checklists/app.js', import.meta.url), 'utf8');

test('New checklist is an icon button just left of the mic', () => {
  const actions = source.match(/<div class="fmcl-head-actions">([\s\S]*?)<\/div><\/header>/);
  assert.ok(actions, 'header actions markup found');
  const html = actions[1];
  const toggle = html.match(/<button class="fmcl-btn primary new-checklist"[^>]*data-fmcl-new-toggle[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(toggle, 'New checklist button carries the new-checklist class');
  assert.match(toggle[0], /aria-label="/, 'icon button keeps its label for screen readers');
  assert.match(toggle[0], /title="/, 'icon button keeps its label as a tooltip');
  assert.equal(toggle[1].trim(), '<i class="fas fa-plus" aria-hidden="true"></i>', 'button shows only the plus icon');
  assert.ok(html.indexOf('data-fmcl-new-toggle') < html.indexOf('data-fmcl-new-audio'), 'plus sits left of the mic');
});

test('header buttons are sized like the mic and never stretched', () => {
  assert.match(source, /\.fmcl-btn\.new-checklist\{width:38px;padding:0\}/);
  assert.doesNotMatch(source, /\.fmcl-head-actions \.fmcl-btn\.primary\{flex:1\}/);
  assert.doesNotMatch(source, /\.fmcl-head-actions\{width:100%\}/);
});
