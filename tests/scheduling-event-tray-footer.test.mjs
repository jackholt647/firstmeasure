// On a phone the event editor is the calendar's bottom tray. The tray grows to
// fit the whole editor when the screen has the room, and its Save row is the
// last row of the form, never a sticky white strip over it (GP-145).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const scheduling = read('public/libraries/apps/scheduling/app.js');
const scheduleView = read('public/libraries/platform-schedule-view/platform-schedule-view.js');

test('the tray footer is not a sticky strip', () => {
  const rule = scheduling.match(/\.prs-event-tray \.dash-event-pop-actions\{([^}]*)\}/);
  assert.ok(rule, 'no .prs-event-tray .dash-event-pop-actions rule');
  assert.match(rule[1], /position:static/);
  assert.match(rule[1], /background:none/);
  assert.match(rule[1], /border-top:0/);
});

test('the tray is only limited by the room above it, not a share of the screen', () => {
  const body = scheduleView.slice(scheduleView.indexOf('function presentEventTray('), scheduleView.indexOf('function dismissEventTray('));
  assert.match(body, /setProperty\('max-height', `\$\{Math\.max\(180, roomForTray\)\}px`, 'important'\)/);
  assert.doesNotMatch(body, /0\.58|\b520\b/);
  assert.doesNotMatch(scheduleView, /min\(58dvh,520px\)/);
});
