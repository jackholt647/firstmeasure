import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

test('custom-field builder and editors handle organization values, integer validation and nested arrays', async () => {
  let executablePath;
  for (const file of ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium',chromium.executablePath()]) { try { await access(file); executablePath=file; break; } catch {} }
  assert.ok(executablePath,'A Chromium browser is required.');
  const browser = await chromium.launch({executablePath,headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:960}}), errors=[];
    page.on('pageerror',e => errors.push(e.message));
    await page.setContent('<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="panel"></div></body></html>');
    await page.evaluate(() => {
      window.saved=[];window.writes=[];
      window.fields=[{id:'count',entity:'project',path:'count',label:'Count',type:'integer'}, {id:'inventory',entity:'project',path:'inventory',label:'Inventory',type:'array',schema:{items:{type:'object',properties:{name:{type:'string'},quantity:{type:'integer',minimum:0}},required:['name','quantity'],additionalProperties:false}}}];
      window.__APP={userOrgId:'org',userBranchId:'default'};
      window.PlatformAPI={branchModules:{get:async()=>({data:{fields:window.fields}}),save:async(_org,_branch,_module,data)=>{window.fields=data.fields;window.saved.push(data);}},publication:{
        read:async(_org,source)=>({status:'ready',value:source.export==='contract'?{recordRevision:0,fields:window.fields.filter(f=>f.entity==='organization').map(f=>({...f,writable:true}))}:{}}),
        invoke:async(...args)=>{window.writes.push(args);return {value:{revision:1}};}
      }};
    });
    await page.addScriptTag({path:path.resolve('../libraries/custom-fields/firstmate-custom-fields.js')});
    await page.addStyleTag({content:'body{margin:0;background:#f3f5f8;font-family:Arial,sans-serif;padding:24px}#panel{background:white;padding:20px;border-radius:16px}button,input,select{font-family:inherit}'});
    await page.evaluate(() => window.FirstMateCustomFields.mountSettings(document.querySelector('#panel')));
    await mkdir('.tmp/custom-fields',{recursive:true});
    await page.screenshot({path:'.tmp/custom-fields/settings-empty.png',fullPage:true});
    assert.deepEqual(await page.locator('[data-cf-scope]').evaluateAll(els=>els.map(el=>el.dataset.cfScope)),['project','contact','organization']);
    assert.equal(await page.locator('[data-cf-scope="project"]').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('[data-cf-overview-label]').innerText(),'Project details');
    await page.locator('[name="entity"]').selectOption('contact');
    assert.equal(await page.locator('[data-cf-overview-label]').innerText(),'Contact details');
    await page.locator('[name="entity"]').selectOption('organization');
    assert.equal(await page.locator('[data-cf-overview-toggle]').isVisible(),false);
    await page.locator('[data-cf-scope="organization"]').click();
    await page.locator('[data-cf-add="organization"]').click();
    await page.locator('[name="label"]').fill('Company count');
    await page.locator('.cf-advanced > summary').click();
    await page.locator('[name="key"]').fill('company_count');
    await page.locator('[name="type"]').selectOption('integer');
    await page.locator('[name="min"]').fill('0');
    await page.locator('[type="submit"]').click();
    await page.waitForFunction(() => window.saved.length===1);
    assert.equal(await page.evaluate(() => window.saved[0].fields.at(-1).entity),'organization');
    assert.equal(await page.locator('[data-cf-organization-values]').count(),0);
    assert.equal(await page.locator('[data-cf-add]').count(),1);
    await page.waitForFunction(() => !document.querySelector('[data-cf-org-editor]')?.textContent.includes('Loading'));
    assert.equal(await page.locator('[data-cf-value-host] [data-fm-cf-input="company_count"]').count(),1,await page.locator('#panel').innerText());
    await page.locator('[data-cf-value-host] [data-fm-cf-input="company_count"]').fill('6');
    await page.screenshot({path:'.tmp/custom-fields/settings-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:'.tmp/custom-fields/settings-mobile.png',fullPage:true});
    await page.setViewportSize({width:1280,height:960});
    await page.locator('[data-fm-cf-save]').click();
    await page.waitForFunction(() => window.writes.length===1);
    assert.deepEqual(await page.evaluate(() => window.writes[0].slice(1,4)),['custom-fields.organization.write',{scope:'organization',organizationId:'org'},{values:{company_count:6},expectedRevision:0}]);
    await page.evaluate(async () => {
      window.record={custom_field_values:{count:1,inventory:[{name:'Chair',quantity:2}]}};
      await window.FirstMateCustomFields.renderEditor(document.querySelector('#panel'),window.record,'project',{showSave:false});
    });
    await page.locator('[data-fm-cf-input="count"]').fill('1.5');
    assert.equal(await page.evaluate(() => window.FirstMateCustomFields.validateEditor(document.querySelector('#panel'),window.record).valid),false);
    await page.locator('[data-fm-cf-input="count"]').fill('3');
    const array=page.locator('[data-fm-cf-input="inventory"]');
    await array.locator('[data-node-add]').click();
    const rows=array.locator('[data-cf-node="array"] > [data-cf-node-row]');
    await rows.nth(1).locator('[data-cf-node="string"]').fill('Table');
    await rows.nth(1).locator('[data-cf-node="integer"]').fill('1.5');
    assert.equal(await page.evaluate(() => window.FirstMateCustomFields.validateEditor(document.querySelector('#panel'),window.record).valid),false);
    await rows.nth(1).locator('[data-cf-node="integer"]').fill('1');
    const valid=await page.evaluate(() => window.FirstMateCustomFields.validateEditor(document.querySelector('#panel'),window.record));
    assert.equal(valid.valid,true,JSON.stringify(valid.errors));
    assert.deepEqual(valid.values.inventory,[{name:'Chair',quantity:2},{name:'Table',quantity:1}]);
    await rows.nth(0).locator('[data-node-remove]').click();
    assert.equal(await page.evaluate(() => window.FirstMateCustomFields.editorValues(document.querySelector('#panel'),window.record).inventory.length),1);
    await mkdir('.tmp/custom-fields',{recursive:true});
    await page.screenshot({path:'.tmp/custom-fields/editor.png',fullPage:true});
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
