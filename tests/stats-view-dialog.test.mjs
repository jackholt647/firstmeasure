import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GP-131: the Stats view dialog. The portal loads Font Awesome 6.0.0
// (portal/index.php), which lacks icons added later (fa-sack-dollar showed as
// an empty swatch). Every icon a person can pick or a preset names must be one
// checked against that version: before adding one here, confirm
// `.fa-<name>:before` is in
// https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css
const IN_FA_6_0 = new Set([
  'fa-chart-line', 'fa-chart-column', 'fa-chart-pie', 'fa-coins', 'fa-trophy', 'fa-helmet-safety',
  'fa-bullseye', 'fa-users', 'fa-phone', 'fa-calendar-days', 'fa-truck-fast', 'fa-star', 'fa-wand-magic-sparkles'
]);

const app = readFileSync(new URL('../public/libraries/apps/stats/app.js', import.meta.url), 'utf8');
const presets = readFileSync(new URL('../public/v1/stats/presets.ts', import.meta.url), 'utf8');

test('every Stats view icon and preset icon exists in Font Awesome 6.0', () => {
  const list = app.match(/const VIEW_ICONS = \[([^\]]*)\]/);
  assert.ok(list, 'VIEW_ICONS not found');
  const icons = [...list[1].matchAll(/'(fa-[a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(icons.length >= 8);
  const presetIcons = [...presets.matchAll(/icon:\s*"(fa-[a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(presetIcons.length >= 3);
  assert.deepEqual([...icons, ...presetIcons].filter((icon) => !IN_FA_6_0.has(icon)), []);
});

test('views saved with fa-sack-dollar show an icon that exists', () => {
  assert.match(app, /RETIRED_ICONS = \{ 'fa-sack-dollar': 'fa-coins' \}/);
  assert.doesNotMatch(app, /clean\((?:view\??|preset)\.icon\) \|\| 'fa-chart-line'/);
});

test('the view dialog is a phone sheet and its copy has no em dash', () => {
  const start = app.indexOf('function openSheet(');
  const end = app.indexOf('function openViewModal(');
  assert.ok(start > 0 && end > start);
  assert.match(app.slice(start, end), /mobileSheet:true/);
  const dialog = app.slice(end, app.indexOf('const readForm', end));
  assert.match(dialog, /openSheet\(heading, content\)/);
  assert.doesNotMatch(dialog, /—/);
});
