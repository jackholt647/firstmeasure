// FM-545: contact preferences show every organization contact setting, not only the time-zone checkbox. The matching
// preference (`auto_attach_exact`: use an existing contact with the same email or phone) has its own checkbox, and
// saving tags or preferences sends it back, so a save from this page never turns matching back on by itself.
// Runs the real contacts settings in Chromium against a stubbed portal and API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SOURCE = readFileSync(new URL('../public/libraries/apps/settings/contacts.js', import.meta.url), 'utf8');

const STUB = `
  window.__saves = [];
  window.__stored = { version:2, track_time_zones:true, auto_attach_exact:false, tags:[{ id:'org', label:'Org', enabled:true, builtin:true }, { id:'customer', label:'Customer', enabled:true }] };
  window.Portal = { util:{ hasPerm:() => true }, navigation:{ read:() => ({}), push(){}, registerHandler(){ return () => {}; } } };
  window.PlatformAPI = {
    contactImports:{ list:async () => ({ imports:[] }) },
    contacts:{
      settings:async () => ({ settings:structuredClone(window.__stored) }),
      saveSettings:async (orgId, body) => {
        window.__saves.push(body);
        window.__stored = { version:2, track_time_zones:body.track_time_zones === true, auto_attach_exact:body.auto_attach_exact !== false, tags:body.tags };
        return { settings:structuredClone(window.__stored) };
      }
    }
  };`;

async function openSettings(browser, subtab){
  const page = await browser.newPage({ viewport: { width: 433, height: 870 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body><div id="host"></div></body></html>');
  await page.addScriptTag({ content: STUB });
  await page.addScriptTag({ content: SOURCE });
  await page.evaluate((initialSubtab) => window.FirstMateContactsSettings.mount(document.getElementById('host'), { orgId:'org_test', initialSubtab }), subtab);
  return { page, errors };
}

test('preferences show the stored matching preference and save both preferences', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await openSettings(browser, 'preferences');
    await page.waitForFunction(() => document.querySelector('[data-cti-time-zones]')?.checked === true);
    assert.equal(await page.isChecked('[data-cti-auto-attach]'), false, 'an organization that turned matching off sees it off');
    await page.check('[data-cti-auto-attach]');
    await page.uncheck('[data-cti-time-zones]');
    await page.click('[data-cti-save-preferences]');
    await page.waitForFunction(() => window.__saves.length === 1);
    const save = await page.evaluate(() => window.__saves[0]);
    assert.equal(save.track_time_zones, false);
    assert.equal(save.auto_attach_exact, true);
    await page.waitForFunction(() => document.querySelector('[data-cti-auto-attach]')?.checked === true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('saving tags keeps the matching preference as stored', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const { page, errors } = await openSettings(browser, 'tags');
    await page.waitForSelector('[data-catalog-id=customer]');
    await page.click('[data-catalog-save]');
    await page.waitForFunction(() => window.__saves.length === 1);
    const save = await page.evaluate(() => window.__saves[0]);
    assert.equal(save.auto_attach_exact, false, 'saving tags does not turn matching back on');
    assert.equal(save.track_time_zones, true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
