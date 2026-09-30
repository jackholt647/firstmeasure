import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

const source = await readFile(new URL('../../libraries/apps/scheduling/app.js', import.meta.url), 'utf8');
test('equipment picker requires confirmation for down units and supports keyboard dismissal', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setContent('<main id="app" style="width:320px"></main><button id="outside">Outside</button>');
    const css = source.slice(source.indexOf('  const css = `') + '  const css = `'.length, source.indexOf('  `;', source.indexOf('  const css = `')));
    await page.addStyleTag({ content: css + '.fas{display:inline-block;width:12px;height:12px}' });
    await page.evaluate(() => {
      window.clean = value => String(value || '').trim();
      window.escapeHtml = value => String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      window.equipmentSchedulingOn = () => true;
      window.isMaterialEvent = () => false;
      window.eventTypeId = () => '';
      window.eventAdvancedOpen = false;
      window.equipmentUnits = [{id:'ready',name:'Truck One',type_id:'truck',status:'available'}, {id:'down',name:'Truck Two',type_id:'truck',status:'down'}];
      window.equipmentTypes = [{id:'truck',name:'Pickup truck',icon:'fa-truck'}];
      window.draft = {id:'event',resource_refs:[]};
      window.eventEquipRefs = event => event.resource_refs;
      window.equipmentUnitConflict = () => false;
      window.eventEditorContext = () => ({event: draft});
      window.patches = [];
      window.applyEditorPatch = patch => { patches.push(patch); Object.assign(draft,patch); };
      window.eventStart = window.eventEnd = () => new Date('2026-09-28T12:00:00Z');
      window.editorAnchorFor = () => null;
      // Down-unit details read the company's conflict mode and any known
      // maintenance windows; unknown mode keeps the "Assign anyway" confirm.
      window.floatingEvents = [];
      window.equipmentConflictMode = '';
      window.isEquipmentWindowEvent = () => false;
      window.eventKind = () => '';
      window.floatingEventIsDisposableDraft = () => false;
    });
    await page.addScriptTag({content: source.slice(source.indexOf('  function equipmentUnitDown('), source.indexOf('  function closeEventDraftPopover(')) + '\nwindow.renderEventDraftPopover = () => { const app=document.querySelector("#app"); app.innerHTML=eventEquipmentSectionHtml({},draft,{}); bindEventEquipmentSection(app,draft); }; renderEventDraftPopover();'});
    const open = () => page.locator('summary').click();
    await open();
    assert.equal(await page.locator('[data-event-equipment-add="ready"] small').textContent(), 'Pickup truck');
    assert.equal(await page.locator('[data-event-equipment-add="ready"] .fa-truck').count(), 1);
    assert.equal(await page.locator('[data-event-equipment-add="down"] strong').evaluate(el => getComputedStyle(el).textDecorationLine), 'line-through');
    await page.locator('[data-event-equipment-add="down"]').click();
    assert.equal(await page.evaluate(() => patches.length), 0);
    assert.equal(await page.locator('[data-equipment-warning]').isVisible(), true);
    await page.locator('[data-equipment-cancel]').click();
    assert.equal(await page.evaluate(() => patches.length), 0);
    await page.locator('[data-event-equipment-add="down"]').click();
    await page.locator('[data-equipment-confirm]').click();
    await page.locator('.dash-event-equipment-chip.down').waitFor();
    assert.equal(await page.evaluate(() => draft.resource_refs[0].id), 'down');
    await open();
    await page.locator('[data-event-equipment-add="ready"]').click();
    await page.waitForFunction(() => draft.resource_refs.length === 2);
    assert.equal(await page.evaluate(() => patches.length), 2);
    await page.locator('[data-event-equipment-remove="ready"]').click();
    await page.locator('summary').waitFor();
    await open();
    await page.locator('[data-event-equipment-add="ready"]').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('details').getAttribute('open'), null);
  } finally { await browser.close(); }
});
