const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The editor's rush timer helpers, run as the page defines them.
function timerHelpers() {
  const editor = fs.readFileSync('public/measure/internal/editor.php', 'utf8').replace(/\r\n/g, '\n');
  const start = editor.indexOf('window.firstMeasureParseClaimTimestamp = function');
  const end = editor.indexOf('window.firstMeasureResolveProjectPoints = function');
  assert.ok(start > 0 && end > start, 'timer helpers found in editor.php');
  const context = { Date, Number, String, Array, Set, Math };
  context.window = context;
  vm.runInNewContext(editor.slice(start, end), context);
  return context;
}

// FM-386: production project 61ddd744…, rejected for the wrong structure type and reordered.
function reorderedManifest() {
  const history = [
    { event: 'claimed_new', ts: '2026-11-10T21:05:36.711Z' },
    { event: 'credit_refunded', ts: '2026-11-10T21:08:40.462Z' },
    { event: 'reordered_rejected_project', ts: '2026-11-10T21:15:22.333Z' },
    { event: 'claimed_new', ts: '2026-11-10T21:15:22.824Z' }
  ];
  return {
    status: 'in_progress',
    reordered_from_rejection: true,
    reordered_at: '2026-11-10 21:15:22',
    // Before the fix the reorder kept the first claim's start.
    started_at: '2026-11-10T21:05:36.711Z',
    work_history: history,
    workflow: {
      assigned_at: '2026-11-10T21:15:22.824Z',
      history: history.filter((entry) => entry.event !== 'reordered_rejected_project')
    }
  };
}

test('a reorder of a rejected project restarts the rush timer at the new claim', () => {
  const w = timerHelpers();
  const manifest = reorderedManifest();
  assert.equal(w.firstMeasureFindClaimStartedAt(manifest), Date.parse('2026-11-10T21:15:22.824Z'));
  const timing = w.firstMeasureBuildClaimTiming(manifest, w.firstMeasureFindClaimStartedAt(manifest));
  assert.equal(timing.totalPausedMs, 0);
  assert.equal(timing.pausedAtMs, null);
});

test('without a reorder the earliest claim still starts the timer', () => {
  const w = timerHelpers();
  const manifest = reorderedManifest();
  manifest.work_history = manifest.work_history.filter((entry) => entry.event !== 'reordered_rejected_project');
  assert.equal(w.firstMeasureFindClaimStartedAt(manifest), Date.parse('2026-11-10T21:05:36.711Z'));
});

test('reopening for edits still restarts the timer', () => {
  const w = timerHelpers();
  const manifest = reorderedManifest();
  manifest.work_history = manifest.work_history.map((entry) => entry.event === 'reordered_rejected_project'
    ? { ...entry, event: 'project_reopened_for_edits' }
    : entry);
  assert.equal(w.firstMeasureFindClaimStartedAt(manifest), Date.parse('2026-11-10T21:15:22.824Z'));
});

// Earnings, payroll and stats pay a speed band from the same timer (portal_scripts/*.js).
function portalTimer(file, endMarker) {
  const source = fs.readFileSync(`public/measure/internal/portal_scripts/${file}`, 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  function parseProjectTimestamp(raw) {');
  const end = source.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `timer functions found in ${file}`);
  const context = {};
  vm.runInNewContext(`${source.slice(start, end)}\nthis.collectionElapsedMs = collectionElapsedMs;`, context);
  return context.collectionElapsedMs;
}

for (const [file, endMarker] of [
  ['earnings.js', '  function speedBandForElapsed('],
  ['payroll.js', '  function speedBandForElapsed('],
  ['stats.js', '  function speedBandForElapsed(']
]) {
  test(`${file} counts a reordered project's drafting time from the new claim`, () => {
    const manifest = reorderedManifest();
    manifest.work_history = [
      ...manifest.work_history,
      { event: 'submitted_for_qa', ts: '2026-11-10T21:27:20.742Z' },
      { event: 'qa_sent_back_to_tech', ts: '2026-11-10T21:55:21.254Z' },
      { event: 'correction_submitted', ts: '2026-11-10T22:16:01.939Z' }
    ];
    const elapsedMs = portalTimer(file, endMarker)(manifest);
    const expected = (Date.parse('2026-11-10T21:27:20.742Z') - Date.parse('2026-11-10T21:15:22.824Z'))
      + (Date.parse('2026-11-10T22:16:01.939Z') - Date.parse('2026-11-10T21:55:21.254Z'));
    assert.equal(elapsedMs, expected);
  });
}

test('the projects list timer treats a reorder as a reset point', () => {
  const source = fs.readFileSync('public/measure/internal/portal_scripts/projects.js', 'utf8');
  const body = source.slice(source.indexOf('latestProjectTimerReopenMs(project){'), source.indexOf('findProjectTimerStartMs(project){'));
  assert.match(body, /'reordered_rejected_project'/);
});
