import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

/* FM-324: autosave clicked the company Save after each pause in typing, and when
 * the (slow) save returned it wrote the saved, trimmed and by then older name back
 * into the field: "Tri " lost its space and "Tri Roo" went back to "Tri". This runs
 * the real settings autosave adapter with the real company Save handler and a slow
 * save, typing while saves are in flight. */
const libraries = new URL('../../libraries/', import.meta.url);
const read = (file) => readFile(new URL(file, libraries), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `found ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `found ${end}`);
  return source.slice(from, to);
};

test('typing in the company name while autosaves are in flight keeps every character', async () => {
  const runtime = await read('settings-pages/firstmate-settings-pages.js');
  const company = await read('apps/settings/company.js');
  const saveHandler = between(company, "      let companySaveRunning = null;", "      if(csLogoFile) csLogoFile.addEventListener('change'");
  const renderCompany = between(company, '    function renderCompany(', '    function renderReports(){');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="panel"><div class="cs-layout"><section data-settings-pane="company">
      <input id="csName" value="Your Company"><input id="csCompanyEmail" value="owner@example.test"><input id="csCompanyPhone" value="">
      <input id="csPrimary" value="#f0d030"><input id="csSecondary" value="#000000"><span id="csStatus"></span>
      <button id="csSave" type="button">Save</button></section></div></div>`);
    await page.addScriptTag({ content: runtime });
    await page.evaluate(({ saveHandler, renderCompany }) => {
      const panel = document.getElementById('panel');
      const paneCompany = panel.querySelector('[data-settings-pane]');
      const $ = (selector, scope = document) => scope.querySelector(selector);
      window.saves = [];
      window.inFlight = 0;
      window.maxInFlight = 0;
      const state = { name: 'Your Company', primary: '#f0d030', secondary: '#000000', palette: [], logo_display: {}, company_email: 'owner@example.test', company_phone: '' };
      // A save that answers slowly, as the real one does (several requests).
      const saveOrg = async (payload) => {
        window.inFlight += 1;
        window.maxInFlight = Math.max(window.maxInFlight, window.inFlight);
        window.saves.push(payload.name);
        await new Promise((resolve) => setTimeout(resolve, 700));
        window.inFlight -= 1;
        return { ok: true };
      };
      const csName = $('#csName', paneCompany);
      csName.addEventListener('input', () => { state.name = csName.value; });
      const bind = new Function('$', 'paneCompany', 'state', 'saveOrg', 'csName', 'csStatus', 'csPrimary', 'csSecondary', 'csCompanyEmail', 'csCompanyPhone',
        'companyFontsEnabled', 'extendedPalette', 'advancedLogos', 'companyBusinessAddress', 'readBusinessAddressInputs', 'formatOrganizationBusinessAddress',
        'organizationBusinessAddressFromState', 'showToast', 'canCompany', 'clampHex', 'DEFAULT_PRIMARY', 'DEFAULT_SECONDARY', 'normalizeBrandPalette',
        'normalizeLogoDisplay', 'renderBrandPalette', 'renderLogoAppearance', 'applyCssVars', 'persistTheme', 'updateSidebarLogoIfNeeded', 'updatePreviewLogoIfNeeded',
        `${renderCompany}\n${saveHandler}\nreturn renderCompany;`);
      const noop = () => {};
      window.companyState = state;
      window.renderCompany = bind($, paneCompany, state, saveOrg, csName, $('#csStatus', paneCompany), $('#csPrimary', paneCompany), $('#csSecondary', paneCompany),
        $('#csCompanyEmail', paneCompany), $('#csCompanyPhone', paneCompany), false, false, false, false, () => ({}), () => '',
        () => ({}), noop, true, (value) => value, '#f0d030', '#000000', (palette) => palette || [], (value) => value || {}, noop, noop, noop, noop, noop, noop);
      window.FirstMateSettingsPages.installAutosave(panel, { source: 'company-settings', inputDelay: 350 });
    }, { saveHandler, renderCompany });

    const name = page.locator('#csName');
    await name.fill('');
    // Pause after each word so autosave saves mid-name, then keep typing while it runs.
    for (const chunk of ['Tri ', 'Roo', 'fing ', 'Co']) {
      await name.pressSequentially(chunk, { delay: 40 });
      assert.ok((await name.inputValue()).endsWith(chunk), `typed ${JSON.stringify(chunk)} stays in the field`);
      await page.waitForTimeout(450);
    }
    assert.equal(await name.inputValue(), 'Tri Roofing Co');
    await page.waitForFunction(() => window.inFlight === 0 && window.saves.at(-1) === 'Tri Roofing Co', null, { timeout: 8000 }).catch(async (e) => { console.log(await page.evaluate(() => JSON.stringify({ saves: window.saves, inFlight: window.inFlight }))); throw e; });
    await page.waitForTimeout(500);
    assert.equal(await name.inputValue(), 'Tri Roofing Co', 'a save that answers late does not write over the field');
    assert.equal(await page.evaluate(() => window.maxInFlight), 1, 'company saves run one at a time');
    assert.equal(await page.evaluate(() => window.saves.at(-1)), 'Tri Roofing Co', 'the last save carries the whole name');
    assert.equal(await page.evaluate(() => window.inFlight), 0);

    // A load that answers late (renderCompany writing inputs from state) leaves
    // the field being typed in alone and still fills the others.
    await name.focus();
    const after = await page.evaluate(() => {
      Object.assign(window.companyState, { name: 'Your Company', company_email: 'server@example.test' });
      window.renderCompany({ writeInputs: true });
      return { name: document.getElementById('csName').value, email: document.getElementById('csCompanyEmail').value };
    });
    assert.deepEqual(after, { name: 'Tri Roofing Co', email: 'server@example.test' });
  } finally {
    await browser.close();
  }
});
