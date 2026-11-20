// FM-626: QA reworked the roof in the embedded editor and sent the job back; the technician opened the last
// Save (roof cut off, lower roof missing) because a send-back never saved the editor. The reviewer kept seeing
// the fix from the browser's local wall backup. Runs the real qa.js decision code with a stub editor and API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const QA = fs.readFileSync('public/measure/internal/portal_scripts/qa.js', 'utf8');

function slice(from, to) {
  const start = QA.indexOf(from), end = QA.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `qa.js markers not found: ${from}`);
  return QA.slice(start, end);
}

const CODE = [
  slice('  async function submitDecision(', '  async function verifyQaDecisionPersisted('),
  slice('  async function submitManagerDecision(', '  // ----------------- SPLITTER'),
  slice('  async function waitForQaEmbeddedEditorWindow(', '  async function waitForQaPdfPersistenceIdle('),
  slice('  async function saveEmbeddedEditorBeforeSendBack(', '  function resolveQaReviewedPdfSync(')
].join('\n');

function portal({ frame = 'editor', saveResult = true } = {}) {
  const calls = [], alerts = [];
  const editor = {
    currentProjectId: 'exteriors_x',
    saveProjectData: async (silent, background) => { calls.push(['save', silent, background]); return saveResult; }
  };
  const iframe = frame && { contentWindow: editor, getAttribute: () => (frame === 'blank' ? 'about:blank' : 'editor.php?folder=exteriors_x') };
  const button = () => ({ disabled: false, innerHTML: '' });
  const buttons = { qaRejectBtn: button(), qaApproveBtn: button(), qaCorrectApproveBtn: button(), qaManagerRejectBtn: button(), qaManagerApproveBtn: button() };
  const context = {
    console, Date, Promise, setTimeout, String, Error, JSON, encodeURIComponent,
    currentId: 'exteriors_x', qaSubmitting: false, submitSeq: 0, inQAView: true, isManagerReviewMode: true,
    qaThreads: [], currentManifest: {}, currentProjectStatus: 'qa',
    alert: m => alerts.push(m),
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))),
    getActiveQaEditorFrame: () => iframe,
    getQaActionButton: id => buttons[id],
    resolveQaReviewedPdfSync: s => s || {},
    isCurrentCustomerReworkQaJob: () => false,
    isQaFixOnlyMode: () => false,
    qaConfirm: async () => true,
    setQaSubmitBlocking: () => {},
    syncFeedbackBeforeDecision: async () => { calls.push(['feedback']); },
    buildQaDecisionTracking: () => ({}),
    fmActor: () => ({}),
    fmPost: async (path, body) => { calls.push(['post', path, body.status]); return { success: true }; },
    verifyQaDecisionPersisted: async () => ({}),
    markCurrentProjectReturnToMe: async () => {},
    clearThreadDrafts: async () => {},
    advanceAfterQaFinish: async () => {},
    closeInspectorToList: () => {},
    updateActionButtons: () => {}
  };
  vm.runInNewContext(CODE + '\nthis.api={submitDecision,submitManagerDecision};', context);
  return { api: context.api, calls, alerts };
}

test('QA send-back saves the embedded editor before the decision', async () => {
  const { api, calls, alerts } = portal();
  await api.submitDecision('rejected');
  assert.deepEqual(alerts, []);
  assert.deepEqual(calls.map(c => c[0]), ['feedback', 'save', 'post']);
  assert.deepEqual(calls[1], ['save', true, true]);
  assert.deepEqual(calls[2], ['post', 'projects/exteriors_x/qa/decision', 'rejected']);
});

test('manager send-back saves the embedded editor before the decision', async () => {
  const { api, calls, alerts } = portal();
  await api.submitManagerDecision('rejected');
  assert.deepEqual(alerts, []);
  assert.deepEqual(calls.map(c => c[0]), ['feedback', 'save', 'post']);
  assert.deepEqual(calls[2], ['post', 'projects/exteriors_x/manager/decision', 'rejected']);
});

test('a failed save does not send the job back', async () => {
  const { api, calls, alerts } = portal({ saveResult: false });
  await api.submitDecision('rejected');
  assert.ok(!calls.some(c => c[0] === 'post'), 'no decision is posted');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /did not save, so the report was not sent back/);
});

test('with no editor open there is nothing to save', async () => {
  for (const frame of [null, 'blank']) {
    const { api, calls } = portal({ frame });
    await api.submitDecision('rejected');
    assert.deepEqual(calls.map(c => c[0]), ['feedback', 'post']);
  }
});
