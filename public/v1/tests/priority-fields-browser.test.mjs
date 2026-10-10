import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
const script=path.resolve('../libraries/priority-fields/priority-fields.js');
const project=await readFile(path.resolve('../libraries/apps/project-request/app.js'),'utf8');

test('priority editor reorders a shared list and creates a singular declared field from document alternatives',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<html><head></head><body style="font:14px Arial;padding:20px"><h2>Priority fields</h2><div id="editor"></div><div id="header"></div><div id="card"></div></body></html>');
    await page.evaluate(()=>{
      window.saved=[];window.modules={custom_fields:{data:{fields:[{entity:'project',path:'hours',label:'Hours',type:'number'}]}}};
      window.PlatformAPI={branchModules:{get:async(_org,_branch,id)=>modules[id]||null,save:async(_org,_branch,id,data)=>{modules[id]={data};saved.push({id,data});return {data};}},publication:{catalog:async()=>({providers:[{id:'project-summary',version:'1',exports:{details:{schema:{type:'object',properties:{stage:{type:'string'},project_type:{type:'string'}}},access:{scopes:['project']}}}},{id:'documents',version:'1',exports:{params:{schema:{type:'object',additionalProperties:true},access:{scopes:['project']},listable:true,argsSchema:{type:'object',additionalProperties:false},description:'Published document parameters'}}}]}),read:async()=>({status:'ready',value:{items:window.resolved}})}};
    });
    await page.addScriptTag({path:script});
    await page.evaluate(async()=>{window.config={priority_fields:[FirstMatePriorityFields.builtin('stage'),FirstMatePriorityFields.custom({path:'hours',label:'Hours',type:'number'})]};window.editor=await FirstMatePriorityFields.mountEditor(document.querySelector('#editor'),{orgId:'org',branchId:'default',config});});
    assert.deepEqual(await page.locator('[data-priority-list]>div [data-label]').evaluateAll(nodes=>nodes.map(n=>n.value)),['Stage','Hours']);
    await page.locator('[data-priority-list]>div').nth(1).locator('[data-up]').click();
    assert.deepEqual(await page.evaluate(()=>config.priority_fields.map(f=>f.label)),['Hours','Stage']);
    await page.locator('[data-priority-list]>div').nth(1).locator('[data-remove]').click();
    assert.deepEqual(await page.evaluate(()=>config.priority_fields.map(f=>f.label)),['Hours']);
    await page.locator('[data-priority-calculate]').click();
    await page.locator('[data-new-label]').fill('Contract value');await page.locator('[data-new-key]').fill('contract_value');
    const sources=page.locator('[data-new-calc] [data-calc-sources]>.fm-priority-row');
    await sources.nth(0).locator('[data-source-choice]').selectOption('documents.params');
    await sources.nth(0).locator('[data-source-path]').fill('/total');await sources.nth(0).locator('[data-source-path]').blur();
    await sources.nth(0).locator('[data-selection]').selectOption('first');
    await sources.nth(0).locator('[data-template]').fill('proposal_a');await sources.nth(0).locator('[data-template]').blur();
    await sources.nth(0).locator('[data-state]').fill('signed');await sources.nth(0).locator('[data-state]').blur();
    await page.locator('[data-calc-add]').click();
    await sources.nth(1).locator('[data-source-choice]').selectOption('documents.params');
    await sources.nth(1).locator('[data-source-path]').fill('/grand_total');await sources.nth(1).locator('[data-source-path]').blur();
    await sources.nth(1).locator('[data-selection]').selectOption('first');
    await sources.nth(1).locator('[data-template]').fill('proposal_b');await sources.nth(1).locator('[data-template]').blur();
    await page.locator('[data-new-save]').click();
    await page.waitForFunction(()=>saved.length===1 && config.priority_fields?.length===2);
    const state=await page.evaluate(()=>({definition:saved[0].data.fields.at(-1),priorities:config.priority_fields}));
    assert.equal(state.definition.path,'contract_value');assert.equal(state.definition.calculation.op,'first');
    assert.equal(state.definition.calculation.inputs[0].select.where.template_id,'proposal_a');
    assert.equal(state.definition.calculation.inputs[1].source.path,'/grand_total');
    assert.equal(state.priorities[1].source.args.field,'contract_value');assert.equal(state.priorities[1].calculation,undefined);
    assert.equal(await page.locator('[data-priority-list] [data-selection]').count(),0,'A priority entry references one field, not an aggregation');
    await mkdir('.tmp/priority-fields',{recursive:true});await page.screenshot({path:'.tmp/priority-fields/settings.png',fullPage:true});
    await page.evaluate(()=>{
      window.resolved=config.priority_fields.map((field,index)=>({...field,result:{status:'ready',value:index===0?12:0}}));
      resolved.push({...config.priority_fields[0],id:'restricted',result:{status:'denied'},empty:'show'});
      document.querySelector('#header').innerHTML=FirstMatePriorityFields.html(resolved);document.querySelector('#card').innerHTML=FirstMatePriorityFields.html(resolved);
    });
    assert.equal(await page.locator('#header').innerText(),await page.locator('#card').innerText());assert.match(await page.locator('#header').innerText(),/\$0/);assert.equal(await page.locator('#header [data-priority-field=restricted]').count(),0);
    await page.evaluate(()=>{window.projectIdentity=p=>p.id;window.projectOrgId=()=> 'org';window.branchProjectConfig=config;window.activeBaseProject={id:'p'};window.renderProjectStageBar=()=>{};});
    const start=project.indexOf('  const priorityFieldStates = new Map();'),end=project.indexOf('  function renderProjectStageBar(){',start);
    await page.addScriptTag({content:project.slice(start,end)});
    await page.evaluate(()=>{document.querySelector('#header').innerHTML=projectHeaderPillsHtml(activeBaseProject);});
    await page.waitForFunction(()=>priorityFieldStates.get('org:p')?.items?.length===3);
    await page.evaluate(()=>{document.querySelector('#header').innerHTML=projectHeaderPillsHtml(activeBaseProject);});
    assert.equal(await page.locator('#header').innerText(),await page.locator('#card').innerText());assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
