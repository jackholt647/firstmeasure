// FM-538: dev looks like production. Calls and texts carry no "Test mode" notes, cards or badges in the app; the
// dev console's "Phone and messages" section shows test mode, onboards the test line and simulates customer
// replies. On a phone the phone tray is a bottom sheet (window manager mobileSheet).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'public/libraries', file), 'utf8');

test('the phone tray has no test-mode note and is a bottom sheet on a phone', () => {
  const tray = read('apps/comms/phone-tray.js');
  assert.doesNotMatch(tray, /Test mode|data-dev-destination|devDestination/);
  assert.doesNotMatch(tray, /Development tools|data-development-phone|Skip to fully onboarded/);
  assert.match(tray, /mobileSheet:true,sheetMinimize:activeCall/);
});

test('project Comms and chat show no test-mode card or badge', () => {
  const project = read('apps/comms/project.js');
  assert.doesNotMatch(project, /Deliveries are in test mode|data-co-sim|fmco-test/);
  assert.match(project, /async simulateInbound\(\{ channel, text \}\)/);
  assert.doesNotMatch(read('apps/chat/app.js'), /message\.test_mode/);
});

test('the dev console has a Phone and messages section that owns test mode', () => {
  const console = read('dev-console/dev-console.js');
  assert.match(console, /id: 'comms', icon: 'fa-phone', label: \['dc_section_comms', 'Phone and messages'\]/);
  const section = read('dev-console/sections/comms.js');
  assert.match(section, /voice\/development\/onboard/);
  assert.match(section, /fm:comms:development-changed/);
  assert.match(section, /simulateInbound\(/);
  assert.match(section, /destinations/);
});
