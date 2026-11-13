// FM-450: on the project Checklists tab, "To sign" on a checklist that needs a signature is a button that opens
// the sign-off (a name and a drawn signature, once every item is done) and saves it through signChecklist.
// Runs the real app.js in Chromium at the reporter's phone width with Portal and CrewAPI stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const app = readFileSync(new URL('../public/libraries/apps/checklists/app.js', import.meta.url), 'utf8');

const item = (id, completed) => ({ id, title: `Item ${id}`, item_type: 'todo', completed, metadata: {} });
const checklist = (id, items, extra = {}) => ({
  id, title: `List ${id}`, audience: 'crew', kind: 'standard', signature_required: true, crew_signature: null,
  can_complete: true, can_edit: true, items, assigned_user_ids: [], assigned_role_ids: [], assigned_resource_group_ids: [],
  customer_access: {}, ...extra
});

async function mount(page, lists) {
  await page.setContent('<!doctype html><html><body><div id="host"><div data-fmcl-app></div></div></body></html>');
  await page.evaluate((lists) => {
    window.__signed = [];
    window.__toasts = [];
    window.Portal = { currentUser: { id: 'user_1', name: 'Sam Signer' }, ui: { showToast: (title, message, ok) => window.__toasts.push({ title, message, ok }) } };
    window.FirstMateEmbeddableApps = { registerApp: (definition) => { window.__app = definition; } };
    window.CrewAPI = { projects: {
      checklists: async () => ({ checklists: lists, deleted_checklists: [], permissions: {} }),
      signChecklist: async (org, project, checklistId, signature) => {
        window.__signed.push({ org, project, checklistId, signature });
        return { ok: true, checklist: { crew_signature: { signer_name: signature.signer_name, signed_at: new Date().toISOString() } } };
      }
    } };
  }, lists);
  await page.addScriptTag({ content: app });
  await page.evaluate(() => { window.__app.mount({ orgId: 'org_1', projectId: 'project_1', root: document.getElementById('host') }); });
  await page.waitForSelector('[data-fmcl-list]');
}

test('To sign opens the sign-off and saves a drawn signature', async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 433, height: 870 }, hasTouch: true });
    await mount(page, [checklist('cl_done', [item('a', true), item('b', true)]), checklist('cl_open', [item('c', true), item('d', false)])]);

    const done = page.locator('[data-fmcl-list="cl_done"]');
    const toSign = done.locator('button[data-fmcl-sign-open]');
    assert.equal(await toSign.count(), 1, '"To sign" is a button');
    await toSign.click();
    const pad = done.locator('canvas[data-fmcl-sign-pad]');
    assert.ok(await pad.isVisible(), 'tapping it opens the signature pad');
    assert.equal(await done.locator('[data-fmcl-sign-name]').inputValue(), 'Sam Signer', 'the name starts as the signed-in person');

    // Signing with nothing drawn asks for a signature and saves nothing.
    await done.locator('[data-fmcl-sign-save]').click();
    assert.equal((await page.evaluate(() => window.__signed)).length, 0);
    assert.match((await page.evaluate(() => window.__toasts.at(-1)?.message)) || '', /Draw your signature/);

    const box = await pad.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 });
    await page.mouse.move(box.x + 220, box.y + 50, { steps: 8 });
    await page.mouse.up();
    await done.locator('[data-fmcl-sign-save]').click();
    await page.waitForFunction(() => window.__signed.length === 1);
    const [call] = await page.evaluate(() => window.__signed);
    assert.equal(call.checklistId, 'cl_done');
    assert.equal(call.signature.type, 'drawn');
    assert.equal(call.signature.signer_name, 'Sam Signer');
    assert.match(call.signature.image_data, /^data:image\/png;base64,/);
    await page.waitForSelector('[data-fmcl-list="cl_done"] .fmcl-signature.signed');
    assert.equal(await done.locator('[data-fmcl-sign]').count(), 0, 'the sign-off closes once signed');

    // A list with items still open says how many are left instead of offering the pad.
    const open = page.locator('[data-fmcl-list="cl_open"]');
    await open.locator('button[data-fmcl-sign-open]').click();
    assert.match(await open.locator('[data-fmcl-sign]').innerText(), /1 to go/);
    assert.equal(await open.locator('canvas[data-fmcl-sign-pad]').count(), 0);
    await open.locator('[data-fmcl-sign-cancel]').click();
    assert.equal(await open.locator('[data-fmcl-sign]').count(), 0, 'Cancel closes it');
  } finally {
    await browser.close();
  }
});
