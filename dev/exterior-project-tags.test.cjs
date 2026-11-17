const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// FM-526: staff see full exterior projects as "EXTERIOR" in the queue and "EXT" on the dashboard.
const exteriorId = 'exteriors_' + 'a'.repeat(32);

function shifts() {
  const context = { document: { addEventListener() {} } };
  context.window = context;
  context.Portal = { escapeHtml: value => String(value) };
  vm.runInNewContext(fs.readFileSync('public/measure/internal/portal_scripts/shifts.js', 'utf8'), context);
  return context.Shifts;
}

test('dashboard tiles tag full exterior projects EXT', () => {
  const s = shifts();
  const tags = project => s.activeProjectTagsHtml(project, 'in_progress');
  assert.match(tags({ id: exteriorId, project_type: 'residential' }), /<span class="sh-work-tag exterior">EXT<\/span>/);
  assert.match(tags({ id: 'p1', measurement_scope: 'full_house' }), /sh-work-tag exterior">EXT/);
  assert.match(tags({ id: exteriorId }), /sh-work-tag type">RES/);
  assert.doesNotMatch(tags({ id: 'p1', project_type: 'residential' }), /EXT</);
  assert.doesNotMatch(tags({ id: 'fullhouse_' + 'b'.repeat(32), measurement_scope: 'full_house' }), /EXT</);
});

test('queue type tag says EXTERIOR, not FULL HOUSE', () => {
  const source = fs.readFileSync('public/measure/internal/portal_scripts/projects.js', 'utf8');
  assert.equal((source.match(/\?'EXTERIOR':\(qTypeLabels\[qPType\]/g) || []).length, 2);
  assert.doesNotMatch(source, /'FULL HOUSE':\(qTypeLabels/);
});
