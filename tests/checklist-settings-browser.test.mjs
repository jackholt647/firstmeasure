// GP-1, GP-72: the gear on the project Checklists tab opens Checklist settings inside the tab: the organization's
// default checklists listed on the left and edited on the right like a project checklist, without checkboxes, and
// "See Advanced Controls", which opens the Automations Hub (where the stages each default is added in now live).
// Runs the real app.js in Chromium with Portal, CrewAPI and PlatformAPI.publication stubbed.
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
    { key: 'crew_safety', source_key: 'setup:crew_safety', title: 'Crew safety', audience: 'crew', signature_required: true, customer: 'none', items: [{ title: 'Harness', item_type: 'todo' }, { title: 'Ladder footing', item_type: 'rating' }] },
    { key: 'work_completion', source_key: 'setup:work_completion', title: 'Work completion', audience: 'crew', signature_required: false, customer: 'none', items: [] }
  ],
  pipelines: [
    { id: 'roofing', name: 'Generic Roofing', color: '#2563eb', is_default: true, configured: false,
      stages: [{ id: 'new_lead', title: 'New lead', color: '#2563eb' }, { id: 'production', title: 'Production', color: '#dc2626' }],
      checklists: { crew_safety: 'all', work_completion: 'all' }, project: { running: true, stage_id: 'production', stage_title: 'Production' } }
  ]
};
const list = (id, title, sourceKey = '') => ({ id, title, source_key: sourceKey, audience: 'crew', items: [{ id: `${id}_i`, title: 'One', item_type: 'todo', metadata: {} }], assigned_user_ids: [], assigned_role_ids: [], assigned_resource_group_ids: [], customer_access: {}, can_complete: true, can_edit: true });

async function mount(page, { manage = true, hub = true } = {}) {
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="host" style="height:100vh"><div data-fmcl-app style="height:100%"></div></div></body></html>');
  await page.evaluate(({ settings, lists, manage, hub }) => {
    window.__saves = [];
    window.__toasts = [];
    window.__routes = [];
    window.__APP = { userId: 'user_1' };
    window.Portal = {
      currentUser: { id: 'user_1', hasApp: (id) => hub && id === 'portal.automations_hub' },
      navigation: { navigate: (route, options) => window.__routes.push({ route, options }), push() {} },
      ui: { showToast: (title, message, ok) => window.__toasts.push({ title, message, ok }), confirm: async () => true },
      util: { injectCSS: (id, css) => { const style = document.createElement('style'); style.id = `css_${id}`; style.textContent = css; document.head.append(style); } }
    };
    window.FirstMateEmbeddableApps = { registerApp: (definition) => { window.__app = definition; } };
    window.CrewAPI = { projects: { checklists: async () => ({ checklists: lists, deleted_checklists: [], management: manage, permissions: { manage } }) } };
    let state = structuredClone(settings);
    let made = 0;
    window.PlatformAPI = { publication: {
      read: async (org, ref) => ({ result: { status: 'ready', value: structuredClone(state), source: ref } }),
      invoke: async (org, action, target, input, options) => {
        window.__saves.push({ action, target, input: structuredClone(input), options });
        // A slow server, so a second edit is made while the first is still saving.
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (input.expected_revision !== state.revision) throw Object.assign(new Error('Someone else changed the checklist settings.'), { status: 409 });
        state.revision += 1;
        let created = null;
        let added = null;
        if (input.update) { const { key, ...changes } = input.update; Object.assign(state.checklists.find((entry) => entry.key === key), changes); }
        if (input.create) { created = { key: `list_new${++made}` }; state.checklists.push({ key: created.key, source_key: `setup:${created.key}`, title: input.create.title, customer: 'none', items: [] }); }
        if (input.remove) state.checklists = state.checklists.filter((entry) => !input.remove.includes(entry.key));
        if (input.add_from_checklist_id) { added = { key: 'list_abc', checklist_id: input.add_from_checklist_id }; state.checklists.push({ key: 'list_abc', source_key: 'setup:list_abc', title: 'Walkthrough', audience: 'crew', customer: 'none', items: [{ title: 'One', item_type: 'todo' }] }); }
        return { value: { ...structuredClone(state), created, added }, receipt: { status: 'succeeded' } };
      }
    } };
  }, { settings, lists: [list('cl_safety', 'Crew safety', 'setup:crew_safety'), list('cl_walk', 'Walkthrough')], manage, hub });
  await page.addScriptTag({ content: app });
  await page.evaluate(() => { window.__app.mount({ orgId: 'org_1', projectId: 'project_1', root: document.getElementById('host') }); });
  await page.waitForSelector('[data-fmcl-list]');
}
const saves = (page) => page.evaluate(() => window.__saves.map((entry) => entry.input));
const editorItems = (page) => page.locator('[data-fmcl-def-item] [data-fmcl-def-field]').evaluateAll((inputs) => inputs.map((input) => input.value));

test('Checklist settings: default checklists listed left, edited right without checkboxes', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
    await mount(page, { manage: false });
    assert.equal(await page.locator('[data-fmcl-settings-open]').count(), 0, 'no gear for someone who cannot manage checklists');

    await mount(page);
    await page.locator('[data-fmcl-settings-open]').click();
    await page.waitForSelector('[data-fmcl-def-editor="crew_safety"]');
    assert.equal(await page.locator('[data-fmcl-list]').count(), 0, 'the page replaces the lists inside the tab');
    assert.equal(await page.locator('[data-fmcl-set-stage], [data-fmcl-set-pipeline], [data-fmcl-set-toggle]').count(), 0, 'no stages here: they are in the Automations Hub');
    assert.deepEqual(await page.locator('[data-fmcl-def-open]').evaluateAll((rows) => rows.map((row) => row.dataset.fmclDefOpen)), ['crew_safety', 'work_completion']);
    assert.equal(await page.locator('[data-fmcl-def-open="crew_safety"]').getAttribute('aria-current'), 'true', 'the first default is open beside the list');
    assert.deepEqual(await editorItems(page), ['Harness', 'Ladder footing']);
    assert.equal(await page.locator('[data-fmcl-def-editor] .fmcl-check, [data-fmcl-def-editor] .fmcl-rate, [data-fmcl-def-editor] [data-fmcl-toggle]').count(), 0, 'defaults have nothing to tick');
    const box = async (selector) => page.locator(selector).boundingBox();
    assert.ok((await box('.fmcl-def-side')).x + (await box('.fmcl-def-side')).width <= (await box('.fmcl-def-editor')).x, 'the list is on the left, the editor on the right');

    // Rename, then two quick edits: each saves against the revision the one before returned, and the screen keeps both.
    await page.locator('[data-fmcl-def-field="title"]').fill('Site safety');
    await page.locator('[data-fmcl-def-field="title"]').press('Enter');
    await page.waitForFunction(() => window.__saves.length === 1);
    await page.locator('[data-fmcl-def-new-item]').fill('Hard hats on');
    await page.locator('[data-fmcl-def-new-item]').press('Enter');
    await page.waitForSelector('[data-fmcl-def-item="2"]');
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-fmcl-def-new-item')), true, 'the add box keeps focus for the next item');
    await page.locator('[data-fmcl-def-item="2"] [data-fmcl-def-move="-1"]').click();
    await page.waitForFunction(() => window.__saves.length === 3 && !document.querySelector('[aria-busy]'));
    await page.waitForTimeout(250);
    assert.deepEqual(await saves(page), [
      { expected_revision: 3, update: { key: 'crew_safety', title: 'Site safety' } },
      { expected_revision: 4, update: { key: 'crew_safety', items: [{ title: 'Harness', item_type: 'todo' }, { title: 'Ladder footing', item_type: 'rating' }, { title: 'Hard hats on', item_type: 'todo' }] } },
      { expected_revision: 5, update: { key: 'crew_safety', items: [{ title: 'Harness', item_type: 'todo' }, { title: 'Hard hats on', item_type: 'todo' }, { title: 'Ladder footing', item_type: 'rating' }] } }
    ]);
    assert.deepEqual(await editorItems(page), ['Harness', 'Hard hats on', 'Ladder footing']);
    assert.match(await page.locator('[data-fmcl-def-open="crew_safety"]').innerText(), /Site safety[\s\S]*3 items · Sign-off/);
    const first = (await page.evaluate(() => window.__saves))[0];
    assert.equal(first.action, 'checklists.defaults.save');
    assert.deepEqual(first.target, { scope: 'project', organizationId: 'org_1', projectId: 'project_1' });
    assert.ok(first.options.idempotencyKey, 'every save carries an idempotency key');

    // A rating item, sign-off, who the customer is, an emptied item comes off.
    await page.locator('[data-fmcl-def-new-type="rating"]').click();
    await page.locator('[data-fmcl-def-new-item]').fill('Clean-up');
    await page.locator('[data-fmcl-def-add]').click();
    await page.locator('[data-fmcl-def-sign]').click();
    await page.locator('[data-fmcl-def-customer="view"]').click();
    await page.locator('[data-fmcl-def-field="item:0"]').fill('');
    await page.locator('[data-fmcl-def-field="item:0"]').press('Enter');
    await page.waitForFunction(() => window.__saves.length === 7);
    assert.deepEqual((await saves(page)).slice(3).map((input) => input.update), [
      { key: 'crew_safety', items: [{ title: 'Harness', item_type: 'todo' }, { title: 'Hard hats on', item_type: 'todo' }, { title: 'Ladder footing', item_type: 'rating' }, { title: 'Clean-up', item_type: 'rating' }] },
      { key: 'crew_safety', signature_required: false },
      { key: 'crew_safety', customer: 'view' },
      { key: 'crew_safety', items: [{ title: 'Hard hats on', item_type: 'todo' }, { title: 'Ladder footing', item_type: 'rating' }, { title: 'Clean-up', item_type: 'rating' }] }
    ]);
    assert.equal((await page.evaluate(() => window.__toasts)).filter((toast) => toast.ok === false).length, 0);

    // Another default, a new one, one made from this project, and one removed.
    await page.locator('[data-fmcl-def-open="work_completion"]').click();
    await page.waitForSelector('[data-fmcl-def-editor="work_completion"]');
    await page.locator('[data-fmcl-def-new]').click();
    await page.waitForSelector('[data-fmcl-def-editor="list_new1"]');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-fmcl-def-field')), 'title', 'a new default opens with its title ready to type');
    await page.locator('.fmcl-def-adopt summary').click();
    assert.equal(await page.locator('[data-fmcl-set-adopt]').count(), 1, 'only the checklist that is not a default yet is offered');
    await page.locator('[data-fmcl-set-adopt="cl_walk"]').click();
    await page.waitForSelector('[data-fmcl-def-editor="list_abc"]');
    await page.locator('[data-fmcl-def-open="crew_safety"]').click();
    await page.locator('[data-fmcl-def-remove]').click();
    await page.waitForFunction(() => !document.querySelector('[data-fmcl-def-open="crew_safety"]'));
    const later = (await saves(page)).slice(7);
    assert.deepEqual(later.map(({ expected_revision, ...rest }) => rest), [{ create: { title: 'Untitled checklist' } }, { add_from_checklist_id: 'cl_walk' }, { remove: ['crew_safety'] }]);

    // See Advanced Controls opens the Automations Hub in the portal.
    await page.locator('[data-fmcl-advanced]').click();
    assert.deepEqual((await page.evaluate(() => window.__routes)).map((entry) => entry.route), [{ tab: 'automations_hub' }]);
    await mount(page, { hub: false });
    await page.locator('[data-fmcl-settings-open]').click();
    await page.waitForSelector('[data-fmcl-def-editor]');
    assert.equal(await page.locator('[data-fmcl-advanced]').count(), 0, 'no button for someone without the Automations Hub');

    await page.locator('[data-fmcl-settings-close]').click();
    await page.waitForSelector('[data-fmcl-list]');
    assert.equal(await page.locator('[data-fmcl-settings-panel]').count(), 0, 'back returns to the checklists');
  } finally {
    await browser.close();
  }
});

test('Checklist settings on a phone: the list, then one default full width', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await mount(page);
    await page.locator('[data-fmcl-settings-open]').click();
    await page.waitForSelector('[data-fmcl-def-open="crew_safety"]');
    assert.equal(await page.locator('[data-fmcl-def-editor]').count(), 0, 'nothing is open until one is picked');
    assert.ok(await page.locator('[data-fmcl-advanced]').isVisible());
    await page.locator('[data-fmcl-def-open="crew_safety"]').tap();
    await page.waitForSelector('[data-fmcl-def-editor="crew_safety"]');
    assert.equal(await page.locator('.fmcl-def-side').isVisible(), false, 'the editor takes the screen');
    const noOverflow = await page.evaluate(() => [...document.querySelectorAll('[data-fmcl-settings-panel] *')].every((node) => node.getBoundingClientRect().right <= window.innerWidth + 1));
    assert.ok(noOverflow, 'nothing runs off a phone-width screen');
    await page.locator('[data-fmcl-def-close]').tap();
    await page.waitForSelector('[data-fmcl-def-open="crew_safety"]');
    assert.equal(await page.locator('[data-fmcl-def-editor]').count(), 0);
  } finally {
    await browser.close();
  }
});
