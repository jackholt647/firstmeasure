import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../../libraries/apps/billing/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function tryAutoSubmitPending(');
const body = source.slice(start, source.indexOf('\n  function setStripeReconcileActive', start));
for (const failSave of [false, true]) test(`checkout resume links the existing project and never resubmits after save ${failSave ? 'failure' : 'success'}`, async () => {
  let pending = { fields: { address:'123 Preview Lane', platform_project_id:'project-1', projectNotes:'Keep this note', pins:'[{"lat":47,"lng":-122}]', cc_emails:'["fictional@example.test"]' } };
  let queues = 0, saves = 0;
  const updates = [];
  const context = {
    inFlightAutoSubmit:false, autoSubmitSuppressed:() => false, readPending:() => pending,
    pendingOrderAmount:() => 7, showToast:() => {}, pendingIncludesGutters:() => false,
    pendingIncludesWeather:() => false, pendingReportMode:() => 'full',
    postAction: async (action, payload) => { assert.equal(action, 'queue'); queues++; assert.equal(payload.platform_project_id, 'project-1'); return { data:{ success:true, folder:'new-report' } }; },
    clearPending:() => { pending = null; }, renderPendingSafe:() => {}, close:() => {},
    CustomEvent:class { constructor(type, options) { this.type=type; this.detail=options.detail; } },
    console:{ warn() {} },
    window:{ dispatchEvent:event => updates.push(event), Portal:{ credits:{lastCredits:35, refreshCredits:async () => {}}, ProjectStore:{
      fromQueue(payload, data, options) { assert.equal(options.persist,false); assert.equal(payload.project_notes,'Keep this note'); return { id:payload.platform_project_id, measurement:{id:data.folder} }; },
      async saveRemote(project) { saves++; assert.equal(project.measurement.id,'new-report'); if (failSave) throw Error('Unavailable'); }
    } } },
  };
  vm.createContext(context); vm.runInContext(body,context);
  assert.equal(await context.tryAutoSubmitPending('stripe_return'),true);
  assert.equal(await context.tryAutoSubmitPending('stripe_return'),false);
  assert.equal(queues,1); assert.equal(saves,1);
  assert.equal(updates.find(event => event.type==='fm:projects:optimistic-update').detail.project.id,'project-1');
});
