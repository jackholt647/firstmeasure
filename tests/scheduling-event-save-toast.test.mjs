// Saving an event in the Scheduling editor shows no success toast: the event
// is on the calendar, and on a phone the toast covered it (GP-146). A toast
// stays for failures and for what the calendar does not show.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const scheduling = fs.readFileSync(path.join(root, 'public/libraries/apps/scheduling/app.js'), 'utf8');
const saveEditor = scheduling.slice(scheduling.indexOf('async function saveEventEditor('), scheduling.indexOf('function sectionItems('));

test('the event editor save path is where expected', () => {
  assert.ok(saveEditor.length > 1000, 'saveEventEditor not found');
});

test('adding an event shows no "Event added" toast', () => {
  assert.doesNotMatch(saveEditor, /m_event_added|is on the calendar\./);
  assert.doesNotMatch(saveEditor, /Recurring item created/);
});

test('a plain update shows no toast; notes and failures still do', () => {
  assert.match(saveEditor, /if \(sharingChanged \|\| movedNote \|\| outOfOrder \|\| reportNote\) \{\s*showToast\(/);
  assert.match(saveEditor, /m_0c17d9fba77f09/);
});
