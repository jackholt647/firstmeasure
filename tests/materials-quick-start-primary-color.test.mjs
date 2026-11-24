// The Materials quick start's primary button (Open proposal, Create proposal, Generate materials) is drawn in the
// organization's primary color, not the Materials category color it sits in (GP-158: it showed the category red).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/apps/materials/project.js'), 'utf8');

test('the quick start primary button follows --primary and --on-primary', () => {
  const rule = source.match(/\.mt-quick-start-actions button\.primary\{([^}]*)\}/);
  assert.ok(rule, 'quick start primary button rule');
  assert.doesNotMatch(rule[1], /--resource-color/);
  assert.match(rule[1], /background:var\(--primary,#d93025\)/);
  assert.match(rule[1], /color:var\(--on-primary,#fff\)/);
});
