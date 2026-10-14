import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';
const scheduling=await readFile(new URL('../../libraries/platform-scheduling/platform-scheduling.js',import.meta.url),'utf8');

test('calendar configuration uses organization departments and invalidates cached branch views after edits',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      window.departmentName='Dispatch';window.departmentReads=0;
      window.PlatformAPI={branchModules:{get:async()=>({data:{appointment_catalog:{departments:[{id:'old',label:'Old branch department'}]}}})},workforce:{departments:async()=>{window.departmentReads++;return {departments:[{id:'dispatch',label:window.departmentName}],groups:[]};}}};
    });
    await page.addScriptTag({content:scheduling});
    const first=await page.evaluate(()=>window.PlatformScheduling.loadBranchConfig('org','east'));
    assert.deepEqual(first.appointment_catalog.departments,[{id:'dispatch',label:'Dispatch'}]);
    assert.deepEqual(first.scheduling.appointment_catalog,first.appointment_catalog);
    await page.evaluate(()=>window.PlatformScheduling.loadBranchConfig('org','east'));
    assert.equal(await page.evaluate(()=>window.departmentReads),1);
    await page.evaluate(()=>{window.departmentName='Dispatch updated';window.dispatchEvent(new CustomEvent('fm:departments:updated'));});
    const next=await page.evaluate(()=>window.PlatformScheduling.loadBranchConfig('org','east'));
    assert.equal(next.appointment_catalog.departments[0].label,'Dispatch updated');
    assert.equal(await page.evaluate(()=>window.departmentReads),2);
  }finally{await browser.close();}
});

// The department editor itself moved to People > Departments; its behaviour (members of every kind, inherited memberships,
// units, categories, app visibility, narrow screens) is covered by people-settings-browser.test.mjs.
test('department search lands on People > Departments',async()=>{
  const catalog=await readFile(new URL('../../libraries/apps/settings/search.js',import.meta.url),'utf8');
  const root={};new Function('window',catalog)(root);
  for(const query of ['department','departments','organizational units']){
    const hit=root.FirstMateSettingsSearch.search(query)[0];
    assert.deepEqual([hit.section,hit.view],['people','departments'],query);
  }
  assert.equal(root.FirstMateSettingsSearch.search('subcontractors').some(item=>item.section==='crews'||item.section==='users'),false);
});
