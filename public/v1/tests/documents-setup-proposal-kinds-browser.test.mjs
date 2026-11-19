// GP-55: the document setup asks a company that does insurance work which kinds of proposals it makes (retail,
// insurance agreements, or both, as many as apply). Any other company goes on past the step without seeing it, and Back
// from the step after it passes it the other way. The real player plays real documents-setup.js steps; the company
// profile (company-profile.profile) is the only read.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib = (file) => readFile(new URL('../../libraries/' + file, import.meta.url), 'utf8');
const LIBS = ['navigation/portal-navigation.js', 'guided-experiences/guided-experiences.js', 'guided-experiences/guided-setup.js'];
const t = (key, text) => ({ key, text });
const step = (id, part) => ({ id, widget: 'module', module: '/libraries/guided-experiences/documents-setup.js', options: { part }, title: t(`gx_tk_${id}`, id), required: true });
const setup = { id: 'documents.setup', version: 1, kind: 'modal', scope: 'organization', title: t('gx_tk_title', 'Kinds test'), tab: '', replayable: true,
  steps: [step('kind', 'kind'), step('proposal_kinds', 'proposal_kinds'), step('presentation', 'presentation')],
  completion: { action: null, screen: 'none', say: [], then: [] }, triggers: [], progress: null };
const page = (services) => `<!doctype html><html><head><style>body{margin:0;font:14px Arial}</style></head><body>
  <script>window.__APP={userOrgId:'o',platformApiBase:'https://fm.test/v1/platform'};
    window.PlatformAPI={publication:{read:async(org,ref)=>({value:ref.provider==='company-profile'?{services:${JSON.stringify(services.map((id) => ({ id })))}}:{}})}};</script>
  ${LIBS.map((file) => `<script src="/libraries/${file}"></script>`).join('')}
  </body></html>`;

async function open(browser, services){
  const tab = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [], events = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.route('https://fm.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'text/javascript', body: await lib(url.pathname.slice(11)) });
    if (url.pathname === '/portal/') return route.fulfill({ contentType: 'text/html', body: page(services) });
    if (url.pathname.endsWith('/experiences')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, experiences: [setup], reveals: [], faqs: null }) });
    if (url.pathname.endsWith('/events')) events.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await tab.goto('https://fm.test/portal/');
  await tab.evaluate(() => { FirstMateGuides.play('documents.setup', { replay: true }); });
  await tab.waitForSelector('[data-gx-step="kind"] [data-choice="proposal"]');
  return { tab, errors, events };
}
/** The step on screen: the newest pane that is not leaving. */
const current = (tab) => tab.evaluate(() => [...document.querySelectorAll('.gxs-step')].filter((pane) => pane.getAttribute('aria-hidden') !== 'true').at(-1)?.dataset.gxStep || '');
const until = async (tab, id) => { for (let at = 0; at < 60; at += 1) { if (await current(tab) === id) return true; await tab.waitForTimeout(100); } return false; };
const done = (events, id) => events.filter((event) => event.type === 'step_done' && event.step_id === id).at(-1);

test('the kinds of proposals: asked only of a company that does insurance work', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    // No insurance work: Continue on the kind goes on to how they present a proposal, retail; Back comes back to the kind.
    {
      const { tab, errors, events } = await open(browser, ['roof_replacement']);
      // Every frame: whether the step's pane was painted visible (a pane slides in from opacity 0).
      await tab.evaluate(() => { window.__shown = 0; const look = () => { const pane = document.querySelector('[data-gx-step="proposal_kinds"]'); const style = pane && getComputedStyle(pane); if (style && style.visibility === 'visible' && Number(style.opacity) > 0.05) window.__shown += 1; requestAnimationFrame(look); }; requestAnimationFrame(look); });
      await tab.click('[data-gxs=next]');
      assert.ok(await until(tab, 'presentation'), 'straight on to the proposal questions');
      assert.equal(done(events, 'proposal_kinds')?.selections?.proposal_kinds, 'retail');
      assert.equal(await tab.evaluate(() => window.__shown), 0, 'the step was never shown');
      await tab.click('[data-gxs=back]');
      assert.ok(await until(tab, 'kind'), 'Back passes it the other way');
      assert.equal(await tab.evaluate(() => window.__shown), 0, 'not on the way back either');
      await tab.waitForTimeout(400);
      assert.equal(await current(tab), 'kind', 'and stays on the kind');
      await tab.click('[data-gxs=next]');
      assert.ok(await until(tab, 'presentation'), 'on again, past it again');
      assert.deepEqual(errors, []);
      await tab.close();
    }
    // Insurance work: two choices, as many as apply; Continue waits for one.
    {
      const { tab, errors, events } = await open(browser, ['roof_replacement', 'storm_insurance']);
      await tab.click('[data-gxs=next]');
      assert.ok(await until(tab, 'proposal_kinds'));
      await tab.waitForSelector('[data-gx-step="proposal_kinds"] [data-kind="insurance"]');
      assert.deepEqual(await tab.$$eval('[data-gx-step="proposal_kinds"] [data-kind]', (tiles) => tiles.map((tile) => [tile.dataset.kind, tile.getAttribute('role'), tile.getAttribute('aria-checked')])),
        [['retail', 'checkbox', 'false'], ['insurance', 'checkbox', 'false']]);
      assert.equal(await tab.isDisabled('[data-gxs=next]'), true, 'nothing picked yet');
      await tab.click('[data-kind="retail"]');
      await tab.click('[data-kind="insurance"]');
      assert.equal(await tab.isDisabled('[data-gxs=next]'), false);
      await tab.click('[data-gxs=next]');
      assert.ok(await until(tab, 'presentation'));
      assert.equal(done(events, 'proposal_kinds')?.selections?.proposal_kinds, 'both');
      // Back shows it again with what was picked; unpicking retail leaves insurance agreements only.
      await tab.click('[data-gxs=back]');
      assert.ok(await until(tab, 'proposal_kinds'));
      await tab.waitForSelector('[data-gx-step="proposal_kinds"] [data-kind="retail"][aria-checked="true"]');
      await tab.click('[data-kind="retail"]');
      await tab.click('[data-gxs=next]');
      await tab.waitForTimeout(300);
      assert.equal(done(events, 'proposal_kinds')?.selections?.proposal_kinds, 'insurance');
      assert.deepEqual(errors, []);
      await tab.close();
    }
  } finally { await browser.close(); }
});
