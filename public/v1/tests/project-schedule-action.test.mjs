import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// FM-382: appointments are booked in the Schedule tab. The project's left column offers no "Schedule Appointment"
// action; only the New button's "New Appointment" workflow still starts one from the project window.
test('the project left column has no Schedule Appointment action', () => {
  const order = source('libraries/apps/firstmeasure/order/app.js');
  assert.doesNotMatch(order, /data-report-choice="schedule"/);
  const request = source('libraries/apps/project-request/app.js');
  const overviewChoices = request.match(/const choices=\[\['roof'.*$/m)?.[0] || '';
  assert.ok(overviewChoices, 'the overview action choices are found');
  assert.doesNotMatch(overviewChoices, /'schedule'/);
  assert.match(request, /action === 'schedule'\) return schedulingEnabled\(\) && requestedWorkflow === 'appointment'/);
});

test('nothing mounts the schedule over an offered Schedule tab welcome', () => {
  const request = source('libraries/apps/project-request/app.js');
  assert.match(request, /if \(!app\?\.mount \|\| projectScheduleOffered\(\)\) return null;/);
});
