import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../../libraries/apps/billing/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function tryAutoSubmitPending(');
const helpersStart = source.indexOf('  function pendingOrderProjectId(');
const helpers = source.slice(helpersStart, source.indexOf('  async function reopenOrderProject(', helpersStart));
const body = helpers + source.slice(start, source.indexOf('\n  function setStripeReconcileActive', start));
for (const failSave of [false, true]) test(`checkout resume links the existing project and never resubmits after save ${failSave ? 'failure' : 'success'}`, async () => {
  let pending = { fields: { address:'123 Preview Lane', platform_project_id:'project-1', projectNotes:'Keep this note', pins:'[{"lat":47,"lng":-122}]', cc_emails:'["fictional@example.test"]' } };
  let queues = 0, saves = 0;
  const updates = [], calls = [];
  const cache = {};
  const context = {
    inFlightAutoSubmit:false, autoSubmitSuppressed:() => false, readPending:() => pending,
    pendingOrderAmount:() => 7, showToast:() => {}, pendingIncludesGutters:() => false,
    pendingIncludesWeather:() => false, pendingReportMode:() => 'full',
    postAction: async (action, payload) => { assert.equal(action, 'queue'); queues++; assert.equal(payload.platform_project_id, 'project-1'); return { data:{ success:true, folder:'new-report' } }; },
    clearPending:() => { pending = null; }, renderPendingSafe:() => {}, close:() => {},
    CustomEvent:class { constructor(type, options) { this.type=type; this.detail=options.detail; } },
    console:{ warn() {} },
    window:{ dispatchEvent:event => updates.push(event), __APP:{ userOrgId:'org-1' },
      // The Stripe return page never read the project: it is read (and becomes the diff base) before the link is saved.
      PlatformAPI:{ projects:{
        async get(orgId, id) { calls.push(`get ${orgId} ${id}`); return { document:{ id, revision:4, data:{ id, title:'Stored title', photos:[{id:'p1'}] } } }; },
        rebaseline(id, data, revision) { calls.push(`rebaseline ${id} ${revision}`); }
      } },
      Portal:{ credits:{lastCredits:35, refreshCredits:async () => {}}, ProjectStore:{
      cache(project) { calls.push(`cache ${project.id}`); cache[project.id] = project; return project; },
      fromQueue(payload, data, options) { calls.push('fromQueue'); assert.equal(options.persist,false); assert.equal(payload.project_notes,'Keep this note'); assert.equal(cache['project-1'].photos.length,1); return { id:payload.platform_project_id, measurement:{id:data.folder} }; },
      async saveRemote(project) { saves++; assert.equal(project.measurement.id,'new-report'); if (failSave) throw Error('Unavailable'); }
    } } },
  };
  vm.createContext(context); vm.runInContext(body,context);
  assert.equal(await context.tryAutoSubmitPending('stripe_return'),true);
  assert.equal(await context.tryAutoSubmitPending('stripe_return'),false);
  assert.equal(queues,1); assert.equal(saves,1);
  assert.deepEqual(calls, ['get org-1 project-1', 'rebaseline project-1 4', 'cache project-1', 'fromQueue']);
  assert.equal(updates.find(event => event.type==='fm:projects:optimistic-update').detail.project.id,'project-1');
});

test('a Stripe return reopens the project window the order was placed from', async () => {
  const start = source.indexOf('  async function reopenOrderProject(');
  const fn = source.slice(start, source.indexOf('  function hasPendingOrder(', start));
  const opened = [];
  const context = { console:{ warn() {} }, wait:async () => { context.window.Portal.modules.request = { openProject:async (project) => { opened.push(project); } }; }, window:{ Portal:{ modules:{} } } };
  vm.createContext(context); vm.runInContext(fn, context);
  await context.reopenOrderProject('project-1');
  await context.reopenOrderProject('');
  assert.deepEqual(opened.map(project => project.id), ['project-1']);
  // The project is taken from the pending order before any await, then reopened on paid, canceled and unconfirmed returns.
  const reconcile = source.slice(source.indexOf('  async function reconcileStripeCheckout('), source.indexOf('  async function handleStripeReturn('));
  assert.ok(reconcile.indexOf('pendingOrderProjectId(readPending())') < reconcile.indexOf('stripeReconcilePromise = (async'));
  assert.match(reconcile, /finally \{[\s\S]*reopenOrderProject\(orderProjectId\)/);
});

test('a Stripe return without the order in this browser takes it from the checkout, once', async () => {
  const start = source.indexOf('  function readPending(');
  const block = source.slice(start, source.indexOf('  /* A Stripe return lands on a page', start));
  const store = {};
  const taken = [];
  let serverOrder = { fields: { address: '1 Test St', platform_project_id: 'project-9' } };
  const context = {
    PENDING_ORDER_KEY: 'fm_pending_order_v1', inFlightAutoSubmit: false, wait: async () => {}, console: { warn() {} },
    localStorage: { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); }, removeItem: key => { delete store[key]; } },
    postAction: async (action, payload) => { assert.equal(action, 'stripe_pending_order'); taken.push(payload.session_id); const order = serverOrder; serverOrder = null; return { data: { success: true, order } }; },
    window: { __APP: { userOrgId: 'org-1', userId: 'user-1' } }
  };
  vm.createContext(context);
  vm.runInContext(block + '\nthis.restore = stripePendingOrderFromCheckout; this.projectOf = pendingOrderProjectId; this.placed = submittedOrders;', context);
  const restored = await context.restore('cs_1');
  assert.equal(context.projectOf(restored), 'project-9');
  assert.equal(JSON.parse(store.fm_pending_order_v1).organization_id, 'org-1');
  // Reloading the return page finds nothing left on the server and keeps what this browser has.
  delete store.fm_pending_order_v1;
  assert.equal(await context.restore('cs_1'), null);
  assert.deepEqual(taken, ['cs_1', 'cs_1']);
  // An order this page already placed is never restored from the checkout's copy.
  serverOrder = { fields: { address: '2 Test St' } };
  context.placed.add(JSON.stringify(serverOrder.fields));
  assert.equal(await context.restore('cs_2'), null);
  assert.equal(store.fm_pending_order_v1, undefined);
});
