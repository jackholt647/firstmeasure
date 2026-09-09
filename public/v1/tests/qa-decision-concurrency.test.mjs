import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real route callbacks and lock helper, not a restatement of their
// control flow. Storage/provider boundaries are deterministic in-memory fakes;
// these tests do not authenticate a request or send email.
const source = await readFile(new URL('../firstmeasure/api.ts', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source boundary: ${start}`);
  return source.slice(a, b);
}
const lockSource = section('async function withQaProjectClaimLock<', 'async function listQaClaimedManifestsForActor(');
const routesSource = [
  section('function qaReservationEmail(', 'function prioritizeQaReservations('),
  section('  app.post("/qa/bulk-approve"', '  app.post("/projects/:id/qa/claim"'),
  section('  app.post("/projects/:id/qa/decision"', '  app.post("/projects/:id/drafter/qa-response"'),
  section('async function approveQaProjectFromBulk(', 'function qaQueueCacheKey('),
].join('\n');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function sharedLocks() {
  const locks = new Map();
  return async (key, options = {}) => {
    const owner = options.owner || randomUUID();
    // The real PostgreSQL lock regards a repeated owner as renewal/re-entry.
    while (locks.has(key) && locks.get(key) !== owner) await delay(1);
    locks.set(key, owner);
    return async () => { if (locks.get(key) === owner) locks.delete(key); };
  };
}
function createNode({ acquire = sharedLocks(), state = new Map(), deliveries = [], lockOnly = false } = {}) {
  const routes = new Map();
  const error = (code, message) => Object.assign(new Error(message), { code });
  const context = vm.createContext({
    process: { pid: 1234 }, // Different droplets can have the same process ID.
    qaProjectClaimLocks: new Map(), acquireFirstMeasureLock: acquire,
    app: { post: (url, fn) => routes.set(url, fn) },
    asRecord: value => value || {}, getProjectId: params => params.id,
    normalizeOptionalPortalActor: value => value,
    normalizeDrafterRankMap: () => new Map(),
    toSqlDateString: date => date.toISOString(),
    conflict: error, badRequest: error,
    readManifest: async id => { const value = structuredClone(state.get(id)); await delay(3); return value; },
    buildLegacyManifest: value => value,
    patchManifest: async (id, patch) => { await delay(3); state.set(id, { ...state.get(id), ...structuredClone(patch) }); return structuredClone(state.get(id)); },
    updateStatus: async (id, status) => { await delay(3); state.get(id).status = status; return structuredClone(state.get(id)); },
    resolveProjectPdfSyncReference: async () => null,
    enqueueProjectReportDelivery: async id => { await delay(3); const jobId = randomUUID(); deliveries.push({ id, jobId }); return { jobId }; },
    readPortalUserByEmail: async () => ({ is_qa_trainee: false }),
    requireQaManagerReviewActor: async () => {}, requireQaBulkApprovalAdmin: async () => {},
    buildCustomerReworkCompletionPatch: () => ({}), rushBonusRemovalPatch: () => ({}),
    getActiveCustomerReworkRequest: () => null,
    resolveOriginalTechnician: () => ({ email: 'tech@1m8.ai', name: 'Test Tech' }),
    isTechnicianOnlineForReturn: async () => false,
    routeProjectBackToTechnician: async ({ projectId, patch, targetTech }) => {
      await delay(3);
      const manifest = { ...state.get(projectId), ...structuredClone(patch), status: 'queued' };
      state.set(projectId, manifest);
      return { manifest, targetTech, deliveryMode: 'unreserved_queue', techOnline: false };
    },
    readStoredPdf: async () => ({ content: Buffer.from('%PDF-test') }),
    qaClaimEmail: manifest => manifest.qa_claimed_by_email || '',
    buildQaRankMeta: async () => ({ error_score: 10 }), qaBulkApprovalMatches: () => true,
    qaTechQueueCache: new Map(),
    mapWithConcurrency: async (values, _limit, fn) => Promise.all(values.map(fn)),
  });
  vm.runInContext(compile(lockSource + (lockOnly ? '' : routesSource)), context);
  return { routes, context, locks: context.qaProjectClaimLocks };
}

test('failed shared-lock acquisition does not permanently block the project locally', async () => {
  let attempts = 0;
  const node = createNode({ lockOnly: true, acquire: async () => {
    if (++attempts === 1) throw new Error('simulated database timeout');
    return async () => {};
  } });
  await assert.rejects(vm.runInContext("withQaProjectClaimLock('fixture', async () => 1)", node.context), /database timeout/);
  const second = vm.runInContext("withQaProjectClaimLock('fixture', async () => 2)", node.context);
  assert.equal(await Promise.race([second, delay(100).then(() => 'blocked')]), 2);
  assert.equal(node.locks.size, 0);
});

test('different nodes with identical PIDs cannot concurrently own the QA lock', async () => {
  const acquire = sharedLocks();
  const nodes = [createNode({ acquire, lockOnly: true }), createNode({ acquire, lockOnly: true })];
  let active = 0, maximum = 0;
  await Promise.all(nodes.map(node => {
    node.context.operation = async () => { active++; maximum = Math.max(maximum, active); await delay(15); active--; };
    return vm.runInContext("withQaProjectClaimLock('fixture', operation)", node.context);
  }));
  assert.equal(maximum, 1);
});

test('operation/release failures do not block the next local lock attempt', async () => {
  const node = createNode({ lockOnly: true, acquire: async () => async () => { throw new Error('release disconnected'); } });
  await assert.rejects(vm.runInContext("withQaProjectClaimLock('fixture', async () => { throw new Error('operation failed'); })", node.context), /operation failed/);
  assert.equal(await vm.runInContext("withQaProjectClaimLock('fixture', async () => 2)", node.context), 2);
  assert.equal(node.locks.size, 0);
});

for (const kind of ['qa', 'manager', 'bulk', 'qa-versus-bulk']) {
  test(`${kind}: simultaneous requests across nodes enqueue only one report`, async () => {
    const actor = { email: 'synthetic@1m8.ai', name: 'Synthetic QA' };
    const state = new Map([['fixture', {
      id: 'fixture', status: kind === 'manager' ? 'awaiting_manager_review' : 'awaiting_review',
      qa_claimed_by_email: actor.email, workflow: {}, qa_history: [], work_history: []
    }]]);
    const acquire = sharedLocks(), deliveries = [];
    const nodes = [createNode({ acquire, state, deliveries }), createNode({ acquire, state, deliveries })];
    const requests = Array.from({ length: 8 }, (_, index) => {
      const node = nodes[index % 2];
      const bulk = kind === 'bulk' || (kind === 'qa-versus-bulk' && index % 2 === 1);
      const url = bulk ? '/qa/bulk-approve' : `/projects/:id/${kind === 'manager' ? 'manager' : 'qa'}/decision`;
      return node.routes.get(url)({ params: { id: 'fixture' }, body: { actor, status: 'approved', threads: [], project_ids: ['fixture'], criteria: {} } });
    });
    const results = await Promise.allSettled(requests);
    assert.equal(deliveries.length, 1, `jobs: ${deliveries.length}; results: ${results.map(r => r.status === 'rejected' ? r.reason?.stack || r.reason : r.status).join('\n')}`);
    assert.equal(state.get('fixture').status, 'completed');
    assert.equal(state.get('fixture').work_history.length, 1);
  });
}

for (const kind of ['qa', 'manager']) {
  test(`${kind}: concurrent approval and rejection cannot both succeed`, async () => {
    const actor = { email: 'synthetic@1m8.ai', name: 'Synthetic QA' };
    const state = new Map([['fixture', {
      id: 'fixture', status: kind === 'manager' ? 'awaiting_manager_review' : 'awaiting_review',
      qa_claimed_by_email: actor.email, workflow: {}, qa_history: [], work_history: []
    }]]);
    const acquire = sharedLocks(), deliveries = [];
    const nodes = [createNode({ acquire, state, deliveries }), createNode({ acquire, state, deliveries })];
    const results = await Promise.allSettled(nodes.map((node, index) => node.routes.get(`/projects/:id/${kind}/decision`)({
      params: { id: 'fixture' }, body: { actor, status: index ? 'approved' : 'rejected', threads: [], failures: [] }
    })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1,
      results.map(result => result.status === 'rejected' ? result.reason?.stack || result.reason : result.status).join('\n'));
    assert.equal(state.get('fixture').work_history.length, 1);
    assert.equal(deliveries.length, state.get('fixture').status === 'completed' ? 1 : 0);
  });
}
