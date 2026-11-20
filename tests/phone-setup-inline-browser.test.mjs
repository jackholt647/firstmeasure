// GP-138: setting up the business phone from a setup (the appointment setup, the Communications setup) runs carrier
// registration as more steps of that setup's tray, not as a full-screen wizard of its own: drawn in the setup's step
// with no head, step rail or step count, each step named in the setup's title, and Back on its first step returning
// to the page it was started from. The phone's back walks its steps (depth). Settings still opens the full-screen one.
// Runs the real texting-setup.js, setup-wizard.js and sms-registration.js in Chromium; the API answers are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILES = {
  'texting-setup.js': '../public/libraries/guided-experiences/texting-setup.js',
  'setup-wizard.js': '../public/libraries/setup-wizard/setup-wizard.js',
  'sms-registration.js': '../public/libraries/apps/settings/sms-registration.js',
  'comms-setup.js': '../public/libraries/guided-experiences/comms-setup.js',
  'appointments-setup.js': '../public/libraries/guided-experiences/appointments-setup.js',
};
const file = (name) => readFileSync(new URL(FILES[name], import.meta.url), 'utf8');
const ORIGIN = 'http://fm.test';
const STUBS = `
  window.__APP = { userOrgId: 'org_1', userId: 'user_1' };
  window.__actions = [];
  window.PlatformAPI = {
    baseUrl: () => '${ORIGIN}/v1/platform',
    appFlags: { has: () => false, load: async () => ({}) }, capabilities: { load: async () => ({}) },
    publication: { invoke: async (orgId, action) => { window.__actions.push(action); return { value: { done: { phone: true }, phone: { registration: 'draft' } } }; } },
  };
  window.Portal = { ui: { showToast() {} } };`;
const PAGE = `<!doctype html><html><head><script>${STUBS}</script>
  <script type="module">import * as texting from '/libraries/guided-experiences/texting-setup.js'; window.texting = texting;</script></head>
  <body style="margin:0"><div class="tray" style="height:860px;overflow:auto;display:flex;flex-direction:column"><div id="step" style="display:flex;flex-direction:column;flex:1 0 auto">Kinds of appointments</div></div></body></html>`;

async function open(viewport){
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport });
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url()), name = url.pathname.split('/').pop();
    if (url.pathname.startsWith('/v1/messaging/')) {
      if (url.pathname.endsWith('/sms/setup')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [], telnyx: { registration_live: false } }) });
      const body = route.request().postDataJSON?.() || {};
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profile: { id: 'profile_1', ...body } }) });
    }
    if (!FILES[name]) return route.fulfill({ contentType: 'text/html', body: PAGE });
    return route.fulfill({ contentType: 'text/javascript', body: file(name) });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.texting?.setUpTexting);
  return { browser, page };
}
// Starts the phone setup in #step as a setup does; window.__run is its promise, __titles what it named the steps.
const start = (page) => page.evaluate(() => {
  window.__titles = []; window.__steps = 0; window.__handle = null; window.__left = null;
  const host = document.getElementById('step');
  window.__run = window.texting.setUpTexting({ orgId: 'org_1', status: { done: { phone: true }, phone: { registration: 'none' } }, host,
    setTitle: (text) => window.__titles.push(text), onStep: () => { window.__steps += 1; },
    onRegistering: (handle) => { window.__handle = handle || null; } }).then((result) => { window.__left = result.left; return result; });
});

test('both setups that offer the business phone load (the step shows "didn’t load" otherwise)', async () => {
  const { browser, page } = await open({ width: 800, height: 600 });
  try {
    const loaded = await page.evaluate(() => Promise.all(['comms-setup.js', 'appointments-setup.js'].map((name) =>
      import(`/libraries/guided-experiences/${name}`).then((module) => typeof module.mount, (error) => error.message))));
    assert.deepEqual(loaded, ['function', 'function']);
  } finally {
    await browser.close();
  }
});

test('carrier registration from a setup is more steps of its tray, and Back returns to the setup', async () => {
  const { browser, page } = await open({ width: 433, height: 870 });
  try {
    await start(page);
    await page.waitForSelector('#step > .fm-wizard-inline[data-fm-wizard="sms-workflow"] [data-sms-field]');
    const shown = await page.evaluate(() => ({
      overPage: document.querySelectorAll('.fm-wizard-backdrop').length,
      head: document.querySelectorAll('.fm-wizard-head, .fm-wizard-close').length,
      rail: document.querySelectorAll('.fm-wizard-rail, .fm-wizard-step').length,
      count: /STEP \d+ OF/i.test(document.getElementById('step').textContent),
      title: window.__titles.at(-1), depth: window.__handle?.depth(), steps: window.__steps,
      back: !!document.querySelector('#step [data-fm-actions] #smsPrev:not(:disabled)'),
    }));
    assert.deepEqual(shown, { overPage: 0, head: 0, rail: 0, count: false, title: 'Tell us about your business', depth: 1, steps: 1, back: true },
      'drawn in the step: no dialog, head, rail or step count; the tray names it; one Back leads out of it');
    // Its buttons sit side by side along the bottom, in the tray's look (not the wizard's pills).
    const buttons = await page.evaluate(() => [...document.querySelectorAll('#step [data-fm-actions] > button')].map((button) => { const box = button.getBoundingClientRect(); return { top: Math.round(box.top), height: Math.round(box.height), radius: getComputedStyle(button).borderRadius }; }));
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].top, buttons[1].top, 'Back and Continue share a row');
    assert.deepEqual([buttons[0].height, buttons[0].radius], [46, '12px'], 'the setup tray\'s buttons on a phone');

    await page.click('#step [data-fm-actions] #smsPrev');
    await page.waitForFunction(() => window.__left !== null);
    const after = await page.evaluate(() => ({ left: window.__left, handle: window.__handle, inline: document.querySelectorAll('.fm-wizard-inline').length, actions: window.__actions }));
    assert.deepEqual(after, { left: 'back', handle: null, inline: 0, actions: [] }, 'Back on its first step leaves it, back to the setup, without reading anything more');

    // Closing the setup (its X) takes registration down with it.
    await start(page);
    await page.waitForFunction(() => window.__handle?.depth() === 1);
    await page.evaluate(() => window.__handle.close());
    await page.waitForFunction(() => window.__left !== null);
    assert.equal(await page.evaluate(() => window.__left), 'host');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.fm-wizard-inline').length), 0);
  } finally {
    await browser.close();
  }
});

test('the inline wizard walks back step by step, then out; on its own it is still a full-screen dialog', async () => {
  const { browser, page } = await open({ width: 1200, height: 900 });
  try {
    await page.evaluate(async () => { await window.texting.loadScript('/libraries/setup-wizard/setup-wizard.js'); });
    const walk = await page.evaluate(async () => {
      const host = document.getElementById('step'); host.replaceChildren();
      const titles = [], closed = [];
      const step = (id) => ({ id, label: id, render: (el) => { el.textContent = `page ${id}`; } });
      const wizard = window.FirstMateSetupWizard.open({ id: 'walk', container: host, backOut: true, steps: [step('one'), step('two'), step('three')],
        onTitle: (label) => titles.push(label), onClose: (info) => closed.push(info.reason) });
      const depths = [wizard.depth()];
      host.querySelector('[data-fm-next]').click(); await new Promise((r) => setTimeout(r, 0));
      host.querySelector('[data-fm-next]').click(); await new Promise((r) => setTimeout(r, 0));
      depths.push(wizard.depth());
      wizard.back(); await new Promise((r) => setTimeout(r, 0));
      depths.push(wizard.depth());
      wizard.back(); await new Promise((r) => setTimeout(r, 0));
      const firstBack = !!host.querySelector('[data-fm-back]');
      wizard.back(); await new Promise((r) => setTimeout(r, 0));
      return { titles, depths, firstBack, closed, left: host.children.length, again: wizard.back() };
    });
    assert.deepEqual(walk, { titles: ['one', 'two', 'three', 'two', 'one'], depths: [1, 3, 2], firstBack: true, closed: ['back'], left: 0, again: false });

    const dialog = await page.evaluate(() => {
      const wizard = window.FirstMateSetupWizard.open({ id: 'alone', title: 'Alone', steps: [{ id: 'a', label: 'A', render(el){ el.textContent = 'a'; } }] });
      const shown = { backdrop: wizard.el.parentElement === document.body && wizard.el.classList.contains('fm-wizard-backdrop'), head: !!wizard.el.querySelector('.fm-wizard-head'), back: wizard.back(), depth: wizard.depth() };
      wizard.close({ force: true });
      return shown;
    });
    assert.deepEqual(dialog, { backdrop: true, head: true, back: false, depth: 0 });
  } finally {
    await browser.close();
  }
});
