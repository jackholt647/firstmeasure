import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';

test('Users field settings share definitions across branches and the user editor saves typed changes',async()=>{
  let executablePath;
  for(const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()]){try{await access(p);executablePath=p;break;}catch{}}
  const browser=await chromium.launch({executablePath,headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<div id="settings"></div><div id="values"></div>');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org',userBranchId:'east'};window.saved=[];window.writes=[];window.failWrite=false;
      window.sharedFields=[{entity:'user',path:'employee_number',key:'employee_number',label:'Employee number',type:'integer',min:1},{entity:'user',path:'readonly',label:'Fixed value',type:'text',read_only:true},{entity:'user',path:'line',label:'Platform line',type:'platform_phone',read_only:true}];
      window.PlatformAPI={branchModules:{get:async(_org,branch)=>({data:{fields:branch==='default'?window.sharedFields:[]}}),save:async(...args)=>{window.saved.push(args);}},publication:{
        read:async(_org,ref)=>({status:'ready',value:ref.export==='contract'?{recordRevision:8,fields:window.sharedFields.map(f=>({...f,writable:!f.read_only}))}:{employee_number:3,readonly:'fixed',line:{phone_number:'+12065550123',issuance_id:'issued-1'}}}),
        invoke:async(...args)=>{if(window.failWrite)throw Error('revision_conflict');window.writes.push(args);return {status:'succeeded',value:{revision:9}};}
      }};
    });
    await page.addScriptTag({path:path.resolve('../libraries/custom-fields/firstmate-custom-fields.js')});
    await page.evaluate(()=>window.FirstMateCustomFields.mountSettings(document.querySelector('#settings'),{orgId:'org',branchId:'east',entity:'user'}));
    assert.equal(await page.locator('[data-cf-scope="user"]').getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('select[name="entity"]').inputValue(),'user');
    assert.equal(await page.locator('select[name="type"] option[value="platform_phone"]').count(),0);
    await page.locator('input[name="label"]').fill('Employee ID');
    await page.locator('[data-cf-editor] button[type="submit"]').click();
    await page.waitForFunction(()=>window.saved.length===2);
    const saved=await page.evaluate(()=>window.saved);
    assert.equal(saved[0][1],'default');assert.ok(saved[0][3].fields.some(f=>f.entity==='user' && f.label==='Employee ID'));
    assert.equal(saved[1][1],'east');assert.ok(!saved[1][3].fields.some(f=>f.entity==='user'));
    await page.evaluate(async()=>{window.editor=window.FirstMateCustomFields.mountUserValues(document.querySelector('#values'),{orgId:'org',userId:'member'});await window.editor.ready;});
    assert.equal(await page.locator('[data-fm-cf-input="readonly"]').isDisabled(),true);
    assert.equal(await page.locator('#values [data-fm-cf-save]').count(),0);
    assert.equal(await page.locator('#values input[type="tel"]').inputValue(),'+12065550123');
    assert.equal(await page.locator('#values input[type="tel"]').isDisabled(),true);
    await page.locator('#values [data-fm-cf-input="employee_number"]').fill('2.5');
    await assert.rejects(()=>page.evaluate(()=>window.editor.save()));assert.equal(await page.evaluate(()=>window.writes.length),0);
    await page.locator('#values [data-fm-cf-input="employee_number"]').fill('4');await page.evaluate(()=>window.editor.save());
    const written=await page.evaluate(()=>window.writes[0]);
    assert.equal(written[1],'custom-fields.user.write');assert.equal(written[2].id,'member');assert.deepEqual(written[3],{values:{employee_number:4},expectedRevision:8});
    await page.evaluate(()=>window.editor.save());assert.equal(await page.evaluate(()=>window.writes.length),1);
    await page.locator('#values [data-fm-cf-input="employee_number"]').fill('5');await page.evaluate(()=>{window.failWrite=true;});
    await assert.rejects(()=>page.evaluate(()=>window.editor.save()));assert.equal(await page.locator('#values [data-fm-cf-input="employee_number"]').inputValue(),'5');
  }finally{await browser.close();}
});

for(const file of ['company.js','firstmeasure-users.js'])test(`${file} includes user fields in Save changes`,async()=>{
  const source=await readFile(path.resolve('../libraries/apps/settings',file),'utf8');
  const start=source.indexOf('    function openEditUserModal(u){'),end=source.indexOf('    function renderActionsMenuForUser(',start),editor=source.slice(start,end);
  assert.match(editor,/data-user-custom-fields data-settings-autosave="off"/);
  assert.match(editor,/mountUserValues/);
  assert.ok(editor.indexOf('await userFields?.save()')<editor.indexOf('await userUpdate('));
});
