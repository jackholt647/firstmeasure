import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../firstmeasure/queue_postgres.ts', import.meta.url), 'utf8');
const script = ts.transpileModule(source.replace(/^import\s[\s\S]*?from\s+"[^"]+";\s*/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

function harness() {
  const scope = new AsyncLocalStorage();
  let checkedOut = false;
  const waiters = [];
  const state = { roster: ['senior@example.test'], busy: [], rosterCalls: 0, teamIds: [], statements: [], mirrors: [], eligibility: { rank: 'standard' }, blocked: false };
  async function withClient(fn) {
    assert.equal(scope.getStore(), undefined, 'must not acquire a second client while holding the transaction client');
    if (checkedOut) await new Promise(resolve => waiters.push(resolve));
    checkedOut = true;
    try { return await scope.run('client', () => fn(client)); }
    finally { const next = waiters.shift(); if (next) next(); else checkedOut = false; }
  }
  const client = { query: async (sql, values) => {
    state.statements.push({ sql, values });
    if (sql.includes('AS assigned')) return { rows: [{ assigned:'0', corrections:'0', reserved:'0', available_new:'2', blocking:state.blocked ? '1' : '0' }] };
    if (sql.includes('SELECT DISTINCT lower(assigned_to_email)')) return { rows: state.busy.map(email => ({email})) };
    if (sql.includes('SELECT manifest_json')) return { rows: [{manifest_json:{id:'synthetic-claim',status:'queued',workflow:{assigned_to:null,history:[]},timestamps:{}},thumbnail_artifact_name:'google.png'}] };
    return { rows: [] };
  }};
  const context = vm.createContext({
    console,
    ensurePostgresProjectIndexReady: async () => {},
    resolveTechnicianPriorityEligibility: async () => state.eligibility,
    readProductionQueuePrioritySettings: async () => ({priorities:{standard:[1,2,3,4,5],senior:[5,4,3,2,1],junior:[1,2]}}),
    onlineSeniorTechnicianEmails: async teamId => {
      state.rosterCalls++; state.teamIds.push(teamId);
      return withClient(async () => [...state.roster]);
    },
    withPostgresClient: withClient,
    withPostgresTransaction: fn => withClient(async client => { await client.query('BEGIN'); try {const r=await fn(client);await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;} }),
    projectDir: id => '/synthetic-only/' + id,
    upsertPostgresProjectIndexWithClient: async (given, manifest) => {assert.equal(given,client);assert.equal(scope.getStore(),'client');assert.equal(manifest.status,'in_progress');},
    writeProjectManifestMirror: async (id, manifest) => {assert.equal(scope.getStore(),undefined);state.mirrors.push(id);},
    badRequest: (code, message) => Object.assign(new Error(message),{code}),
    conflict: (code, message) => Object.assign(new Error(message),{code}),
    notFound: (code, message) => Object.assign(new Error(message),{code})
  });
  vm.runInContext(script,context);
  const input = {actor:{email:'standard@example.test',team_id:'team-one'}};
  return {state,context,input};
}

test('claimable status refreshes senior roster before a single-client transaction', async () => {
  const {state,context,input}=harness();
  const results = await Promise.all(Array.from({length:20},()=>context.getPostgresClaimableQueueStatus(input)));
  assert.equal(results.length,20); assert.ok(results.every(r=>r.claimable_count===1));
  assert.equal(state.rosterCalls,20); assert.ok(state.teamIds.every(t=>t==='team-one'));
  const selects=state.statements.filter(r=>r.sql.includes('SELECT manifest_json'));
  assert.ok(selects.every(r=>r.sql.includes('queue_priority <> 1')),'available senior retains P1 exclusion');
  assert.ok(selects.every(r=>!r.sql.includes('FOR UPDATE')),'status remains read-only candidate lookup');
  state.roster=[]; state.statements=[];
  await context.getPostgresClaimableQueueStatus(input);
  assert.equal(state.rosterCalls,21,'next request must not reuse a cached roster');
  assert.ok(state.statements.filter(r=>r.sql.includes('SELECT manifest_json')).every(r=>!r.sql.includes('queue_priority <> 1')),'no senior permits standard P1 fallback');
});

test('claim holds one client for busy check, row lock and write; mirror follows commit', async () => {
  const {state,context,input}=harness();
  state.busy=['senior@example.test'];
  const claimed=await context.claimNextPostgresQueue(input);
  assert.equal(claimed.project.status,'in_progress');
  assert.equal(claimed.project.workflow.assigned_to.email,input.actor.email);
  assert.equal(state.rosterCalls,1);
  assert.ok(state.statements.some(r=>r.sql.includes('FOR UPDATE SKIP LOCKED')));
  assert.ok(state.statements.filter(r=>r.sql.includes('SELECT manifest_json')).every(r=>!r.sql.includes('queue_priority <> 1')),'busy senior does not block fallback');
  assert.deepEqual(state.mirrors,['synthetic-claim']);
});

test('explicit P1 eligibility and blocked queue semantics are unchanged', async () => {
  const {state,context,input}=harness();
  state.eligibility={rank:'standard',p1Eligible:false,p2Eligible:false};
  await context.getPostgresClaimableQueueStatus(input);
  assert.equal(state.rosterCalls,0);
  assert.ok(state.statements.filter(r=>r.sql.includes('SELECT manifest_json')).every(r=>r.sql.includes('queue_priority <> 1')&&r.sql.includes('queue_priority <> 2')));
  state.blocked=true;state.statements=[];
  const blocked=await context.getPostgresClaimableQueueStatus({...input,queue_mode:'wait_for_feedback'});
  assert.equal(blocked.claimable_count,0); assert.equal(blocked.claimable_next_id,null);
  assert.ok(!state.statements.some(r=>r.sql.includes('SELECT manifest_json')));
});
