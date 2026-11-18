// GP-1: the gear on the project Checklists tab opens Checklist settings inside the tab: per pipeline, the stages each
// default checklist is added in, and making one of the project's checklists a default. Runs the real app.js in
// Chromium with Portal, CrewAPI and PlatformAPI.publication stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const app = readFileSync(new URL('../public/libraries/apps/checklists/app.js', import.meta.url), 'utf8');

const settings = {
  revision: 3, project_id: 'project_1', default_pipeline_id: 'roofing',
  checklists: [
    { key: 'crew_safety', source_key: 'setup:crew_safety', title: 'Crew safety', audience: 'crew', signature_required: true, customer: 'none', items: [{ title: 'Harness', item_type: 'todo' }] },
    { key: 'work_completion', source_key: 'setup:work_completion', title: 'Work completion', audience: 'crew', signature_required: false, customer: 'none', items: [] }
  ],
  pipelines: [
    { id: 'roofing', name: 'Generic Roofing', color: '#2563eb', is_default: true, configured: false,
      stages: [{ id: 'new_lead', title: 'New lead', color: '#2563eb' }, { id: 'production', title: 'Production', color: '#dc2626' }, { id: 'complete', title: 'Complete', color: '#16a34a' }],
      checklists: { crew_safety: 'all', work_completion: 'all' }, project: { running: true, stage_id: 'production', stage_title: 'Production' } },
    { id: 'gutters', name: 'Gutters', color: '#0f766e', is_default: false, configured: false, stages: [{ id: 'install', title: 'Install', color: '' }], checklists: {}, project: { running: false, stage_id: '' } }
  ]
};
const list = (id, title, sourceKey = '') => ({ id, title, source_key: sourceKey, audience: 'crew', items: [{ id: `${id}_i`, title: 'One', item_type: 'todo', metadata: {} }], assigned_user_ids: [], assigned_role_ids: [], assigned_resource_group_ids: [], customer_access: {}, can_complete: true, can_edit: true });

async function mount(page, manage) {
  await page.setContent('<!doctype html><html><body><div id="host"><div data-fmcl-app></div></div></body></html>');
  await page.evaluate(({ settings, lists, manage }) => {
    window.__saves = [];
    window.__toasts = [];
    window.__APP = { userId: 'user_1' };
    window.Portal = { currentUser: { id: 'user_1' }, ui: { showToast: (title, message, ok) => window.__toasts.push({ title, message, ok }), confirm: async () => true } };
    window.FirstMateEmbeddableApps = { registerApp: (definition) => { window.__app = definition; } };
    window.CrewAPI = { projects: { checklists: async () => ({ checklists: lists, deleted_checklists: [], management: manage, permissions: { manage } }) } };
    let state = structuredClone(settings);
    window.PlatformAPI = { publication: {
      read: async (org, ref) => ({ result: { status: 'ready', value: structuredClone(state), source: ref } }),
      invoke: async (org, action, target, input, options) => {
        window.__saves.push({ action, target, input, options });
        if (input.expected_revision !== state.revision) throw Object.assign(new Error('Someone else changed the checklist settings.'), { status: 409 });
        state.revision += 1;
        if (input.pipeline) {
          const pipeline = state.pipelines.find((entry) => entry.id === input.pipeline.id);
          pipeline.configured = input.pipeline.checklists !== null;
          pipeline.checklists = input.pipeline.checklists || { crew_safety: 'all', work_completion: 'all' };
        }
        if (input.add_from_checklist_id) state.checklists.push({ key: 'list_abc', source_key: 'setup:list_abc', title: 'Walkthrough', audience: 'crew', customer: 'none', items: [] });
        return { value: structuredClone(state), receipt: { status: 'succeeded' } };
      }
    } };
  }, { settings, lists: [list('cl_safety', 'Crew safety', 'setup:crew_safety'), list('cl_walk', 'Walkthrough')], manage });
  await page.addScriptTag({ content: app });
  await page.evaluate(() => { window.__app.mount({ orgId: 'org_1', projectId: 'project_1', root: document.getElementById('host') }); });
  await page.waitForSelector('[data-fmcl-list]');
}

test('Checklist settings: stages per pipeline, saved one change at a time', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 433, height: 870 }, hasTouch: true });
    await mount(page, false);
    assert.equal(await page.locator('[data-fmcl-settings-open]').count(), 0, 'no gear for someone who cannot manage checklists');

    await mount(page, true);
    await page.locator('[data-fmcl-settings-open]').click();
    await page.waitForSelector('[data-fmcl-set-stage="production"]');
    assert.equal(await page.locator('[data-fmcl-list]').count(), 0, 'the panel replaces the lists inside the tab');
    assert.match(await page.locator('.fmcl-set-pipeline.active').innerText(), /Generic Roofing[\s\S]*This project/, "the project's pipeline is picked and marked");
    assert.match(await page.locator('[data-fmcl-set-stage="production"]').innerText(), /This project is here/);
    assert.match(await page.locator('.fmcl-set-status').innerText(), /Not set up yet: every default checklist is added when a scope/);
    // Not set up: each default is on in All stages, and shown as inherited in every stage.
    assert.equal(await page.locator('[data-fmcl-set-all].on').count(), 2);
    assert.equal(await page.locator('[data-fmcl-set-stage="complete"] .fmcl-set-chip.inherited').count(), 2);
    const noOverflow = await page.evaluate(() => [...document.querySelectorAll('[data-fmcl-settings-panel] *')].every((node) => node.getBoundingClientRect().right <= window.innerWidth + 1));
    assert.ok(noOverflow, 'nothing runs off a phone-width screen');

    // Leaving Work completion out of New lead keeps it in every other stage.
    await page.locator('[data-fmcl-set-stage="new_lead"] [data-fmcl-set-toggle="work_completion"]').click();
    await page.waitForFunction(() => window.__saves.length === 1);
    let save = (await page.evaluate(() => window.__saves))[0];
    assert.equal(save.action, 'checklists.defaults.save');
    assert.deepEqual(save.target, { scope: 'project', organizationId: 'org_1', projectId: 'project_1' });
    assert.deepEqual(save.input, { expected_revision: 3, pipeline: { id: 'roofing', checklists: { crew_safety: 'all', work_completion: ['production', 'complete'] } } });
    assert.ok(save.options.idempotencyKey, 'every save carries an idempotency key');
    await page.waitForSelector('.fmcl-set-status .fa-circle-check', { state: 'attached' });
    assert.equal(await page.locator('[data-fmcl-set-stage="new_lead"] [data-fmcl-set-toggle="work_completion"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-fmcl-set-stage="production"] [data-fmcl-set-toggle="work_completion"]').getAttribute('aria-pressed'), 'true');

    // Two quick taps save in order, each against the revision the one before returned.
    await page.locator('[data-fmcl-set-stage="complete"] [data-fmcl-set-toggle="work_completion"]').click();
    await page.locator('[data-fmcl-set-all="work_completion"]').click();
    await page.waitForFunction(() => window.__saves.length === 3);
    const later = (await page.evaluate(() => window.__saves)).slice(1).map((entry) => entry.input);
    assert.deepEqual(later, [
      { expected_revision: 4, pipeline: { id: 'roofing', checklists: { crew_safety: 'all', work_completion: ['production'] } } },
      { expected_revision: 5, pipeline: { id: 'roofing', checklists: { crew_safety: 'all', work_completion: 'all' } } }
    ]);
    assert.equal((await page.evaluate(() => window.__toasts)).filter((toast) => toast.ok === false).length, 0);

    // Another pipeline, then make one of this project's checklists a default.
    await page.locator('[data-fmcl-set-pipeline="gutters"]').click();
    assert.match(await page.locator('.fmcl-set-status').innerText(), /adds no default checklists/);
    assert.equal(await page.locator('[data-fmcl-set-adopt]').count(), 1, 'only the checklist that is not a default yet is offered');
    await page.locator('[data-fmcl-set-adopt="cl_walk"]').click();
    await page.waitForFunction(() => window.__saves.length === 4);
    assert.deepEqual((await page.evaluate(() => window.__saves))[3].input, { expected_revision: 6, add_from_checklist_id: 'cl_walk' });
    await page.waitForSelector('[data-fmcl-set-default="list_abc"]');

    await page.locator('[data-fmcl-settings-close]').click();
    await page.waitForSelector('[data-fmcl-list]');
    assert.equal(await page.locator('[data-fmcl-settings-panel]').count(), 0, 'back returns to the checklists');
  } finally {
    await browser.close();
  }
});
