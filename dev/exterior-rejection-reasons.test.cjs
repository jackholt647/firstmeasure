const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// FM-410: staff can reject a Full Exterior for insufficient footage, and only a Full Exterior (the API refuses it
// for a roof order, and the customer is offered a retry with more footage or the roof alone).
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

test('insufficient footage is a default rejection reason in PHP and the staff portal', () => {
  assert.match(read('public/measure/internal/firstmeasure_node.php'), /\['id' => 'insufficient_footage', 'label' => 'Insufficient footage'/);
  assert.match(read('public/measure/internal/portal_scripts/projects.js'), /\{ id: 'insufficient_footage', label: 'Insufficient footage'/);
});

test('the queue reject dialog shows insufficient footage only for a Full Exterior order', () => {
  const source = read('public/measure/internal/portal_scripts/projects.js');
  const start = source.indexOf('    openRejectModal(folder, address){');
  const end = source.indexOf('    closeRejectModal(){');
  assert.ok(start > 0 && end > start);
  const buttons = ['no_height_map', 'insufficient_footage'].map((reason) => ({ dataset: { reason }, style: { display: '' }, classList: { remove() {} } }));
  const overlay = { style: {}, querySelectorAll: (selector) => selector === '.qrej-reason-btn' ? buttons : [] };
  const context = {
    cfg: () => ({ flags: { is_queue_admin: true } }), COVERAGE_REJECTION_DISCLAIMER: '',
    FULL_EXTERIOR_ONLY_REJECTION_REASONS: new Set(['insufficient_footage']),
    document: { getElementById: (id) => id === 'qRejectOverlay' ? overlay : null },
  };
  vm.runInNewContext(`const modal = {${source.slice(start, end)}}; this.open = (folder) => modal.openRejectModal(folder, '');`, context);
  context.open('roof_fixture');
  assert.deepEqual(buttons.map((b) => b.style.display), ['', 'none']);
  context.open('exteriors_' + 'a'.repeat(32));
  assert.deepEqual(buttons.map((b) => b.style.display), ['', '']);
});

test('the editor reject dialog offers insufficient footage only in the Full Exterior editor', () => {
  const source = read('public/measure/internal/editor_scripts/main.js');
  assert.match(source, /reason\.id !== 'insufficient_footage' \|\| window\.FIRSTMEASURE_FULL_HOUSE === true/);
});
