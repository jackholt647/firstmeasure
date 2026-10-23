// The Project tab with scheduling switched off, the assignment choice's honest states, work order documents in a list
// header, and the work order column minimized when nothing requires work.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
const source = await readFile(new URL('../../libraries/apps/materials/project.js',import.meta.url),'utf8');
const helper = await readFile(new URL('../../libraries/apps/materials/scope-of-work.js',import.meta.url),'utf8');
function fn(name) {
  const start=source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start>=0,name); return source.slice(start,source.indexOf('\n  }',start)+4);
}
const escapeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const number=(value,fallback=0)=>Number.isFinite(Number(value))&&value!==null&&value!==''?Number(value):fallback;
const cleanText=value=>String(value??'').trim();

test('with scheduling off the Project tab offers no Schedule control and makes no schedule events', async () => {
  const flags=on=>({current:()=>({platform:{scheduling:on}}),has:(group,flag)=>group==='platform'&&flag==='scheduling'&&on,value:()=>on});
  const ctx={state:{lists:[{id:'m',resource_type:'material',current_items:[{}]}],schedulingListId:''},window:{},rootWindow:{Portal:{appFlags:flags(false)}},callHost:()=>undefined,cleanText,escapeHtml,number,
    resourceType:list=>list.resource_type,listItems:list=>list.current_items||[],materialListOrdered:()=>false,assignmentWorkResourceRef:()=>null,laborListFinalized:()=>null,workOrderActions:()=>[],jobSchedule:()=>({done:false}),materialListById:id=>ctx.state.lists.find(list=>list.id===id)};
  vm.createContext(ctx);for(const name of ['schedulingOn','resourceScheduleEnabled','renderListHeaderActions','scheduleJobButton','scheduleMaterialList','scheduleJob'])vm.runInContext(fn(name),ctx);
  const list=ctx.state.lists[0];
  assert.equal(ctx.schedulingOn(),false);assert.equal(ctx.resourceScheduleEnabled(list),false,'a material list is not waiting to be scheduled');
  assert.doesNotMatch(ctx.renderListHeaderActions(list,'material',''),/data-mt-list-schedule/);assert.match(ctx.renderListHeaderActions(list,'material',''),/data-mt-list-order/,'ordering stays');
  assert.equal(ctx.scheduleJobButton(),'');
  await ctx.scheduleMaterialList('m');await ctx.scheduleJob();assert.equal(ctx.state.schedulingListId,'','nothing starts placing');
  // The host's answer wins; with scheduling on, everything is back.
  ctx.callHost=name=>name==='schedulingEnabled'?true:undefined;
  assert.equal(ctx.schedulingOn(),true);assert.match(ctx.renderListHeaderActions(list,'material',''),/data-mt-list-schedule/);assert.match(ctx.scheduleJobButton(),/data-mt-schedule-job/);
  ctx.callHost=()=>undefined;ctx.rootWindow.Portal.appFlags=flags(true);assert.equal(ctx.schedulingOn(),true);
  // Ordering with a date and scheduling off keeps the date on the order and never saves a schedule event.
  assert.match(source,/schedulingOn\(\) \|\| !start\s*\n?\s*\? await persistInlineDeliverySchedule/);
  const storage=await readFile(new URL('../materials/storage.ts',import.meta.url),'utf8');
  assert.match(storage,/shouldEnsureSchedule = [\s\S]{0,200}isCapabilityEnabled\(orgId, "platform\.scheduling"\)/,'the server makes no delivery event for an order either');
});

test('the rail has no Schedule view when scheduling is off', async () => {
  const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url.includes('helper')?'text/javascript':'text/html');res.end(req.url.includes('helper')?helper:'<html><head></head><body><aside></aside></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result=await page.evaluate(async()=>{
      const helper=await import('/helper.js'),root=document.querySelector('aside');
      window.FirstMateWidgets={mount:()=>({setVisible(){},destroy(){}})};
      const tabs=()=>[...root.querySelectorAll('[data-scope-view]')].map(tab=>tab.dataset.scopeView);
      helper.mountSidebar(root,[],'','org:project',{scheduling:false});
      const off={tabs:tabs(),panel:!!root.querySelector('[data-scope-panel="schedule"]'),show:helper.showSidebarView(root,'schedule')};
      helper.mountSidebar(root,[],'','org:project',{scheduling:true});
      return {off,on:tabs()};
    });
    assert.deepEqual(result.off,{tabs:['roof','documents','aerial'],panel:false,show:false});
    assert.deepEqual(result.on,['roof','documents','aerial','schedule'],'switching it on brings the view back');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();server.close();}
});

function assignmentContext(state){
  const ctx={state:{crewsLoaded:true,crewsError:'',assigneePay:{},...state},cleanText,escapeHtml,number,money:value=>'$'+Number(value).toLocaleString('en-US'),
    workforceLabel:kind=>kind==='organization_connection'?'Partner':'Team',requirementSet:()=>ctx.requirements||null,workResourcesForScopeList:()=>ctx.crews||[],materialsAPI:null,window:{},apiReady:()=>false};
  vm.createContext(ctx);
  for(const name of ['assigneePay','assigneePayFor','assigneePayLabel','assigneePills','assigneeKindPill','laborAssignmentOptions','laborAssignmentView','renderAssignmentNote','renderAssignmentMore','renderAssignBlock'])vm.runInContext(fn(name),ctx);
  return ctx;
}

test('the assignment choice is never a bare "nobody": it loads, fails with a retry, explains an empty directory, or lists everyone', () => {
  const crews=[{id:'a',name:'Crew A',resource_kind:'resource_group'},{id:'b',name:'Sub B',resource_kind:'organization_connection'},{id:'truck',name:'Truck 4',resource_kind:'equipment_unit'}];
  const list={id:'project:p',resource_type:'labor'};
  // The directory has not answered yet (the lists drew first).
  let ctx=assignmentContext({crewsLoaded:false});ctx.crews=crews;
  assert.match(ctx.renderAssignBlock(list),/Loading assignees…/);assert.doesNotMatch(ctx.renderAssignBlock(list),/data-mt-assign-pick/);
  // The directory read failed: say so, offer a retry, never "no one".
  ctx=assignmentContext({crewsError:'Network error'});
  let html=ctx.renderAssignBlock(list);assert.match(html,/could not be loaded\. Network error/);assert.match(html,/role="alert"/);assert.match(html,/data-mt-assign-retry="project:p">Try again/);
  // Nobody is in the directory (or in this person's branches): explained, with where to add someone.
  ctx=assignmentContext({});ctx.crews=[];
  html=ctx.renderAssignBlock(list);assert.match(html,/Add a group of users or an outside company in People/);assert.match(html,/only the assignees in your branches/);assert.match(html,/Reload/);
  // Prices are still being worked out, or failed: everyone is listed anyway; equipment never is.
  ctx=assignmentContext({assigneePay:{'project:p':{loading:true,rows:[]}}});ctx.crews=crews;
  html=ctx.renderAssignBlock(list);assert.equal((html.match(/data-mt-assign-pick=/g)||[]).length,2);assert.doesNotMatch(html,/Truck 4/);assert.match(html,/Working out what each would be paid/);
  ctx=assignmentContext({assigneePay:{'project:p':{loading:false,error:'Pay sheets are unavailable',rows:[]}}});ctx.crews=crews;
  html=ctx.renderAssignBlock(list);assert.equal((html.match(/data-mt-assign-pick=/g)||[]).length,2);assert.match(html,/Pay could not be worked out[^<]*Pay sheets are unavailable/);assert.match(html,/data-mt-assign-retry/);
  // The job requires work and nobody is marked as doing it: everyone is still offered, and it says why.
  ctx=assignmentContext({assigneePay:{'project:p':{loading:false,rows:[{assignee:{id:'a'},sheet:null,overlap:0},{assignee:{id:'b'},sheet:{id:'s'},complete:true,total_cents:100000,overlap:0}]}}});ctx.crews=crews;ctx.requirements={data:{requirements:[{kind:'work',id:'roofing.tear_off'}]}};
  html=ctx.renderAssignBlock(list);assert.equal((html.match(/data-mt-assign-pick=/g)||[]).length,2);assert.match(html,/No one is marked as doing this job's work yet, so everyone is listed/);
  // Someone does the work: they come first, and the rest are one click away.
  ctx.state.assigneePay['project:p'].rows[1].overlap=2;
  html=ctx.renderAssignBlock(list);assert.equal((html.match(/data-mt-assign-pick=/g)||[]).length,1);assert.match(html,/Sub B/);assert.match(html,/data-mt-assign-more="project:p">Show 1 more who is not marked/);
  ctx.state.assignShowAll=new Set(['project:p']);
  html=ctx.renderAssignBlock(list);assert.match(html,/Sub B[\s\S]*Not marked for this work[\s\S]*Crew A/);
  // The directory load says so when it fails, rather than leaving an empty directory behind.
  assert.match(fn('loadWorkResources'),/state\.crewsError = error\?\.message/);assert.match(fn('loadWorkResources'),/syncAssignBlocks\(\); syncLaborMenu\(\)/);
});

test('a labor list header offers Generate work order, then Open and Download (and Update when the list changed), folding into ⋮ when narrow', async () => {
  const code='var LIST_NAME_ROOM=96;var listFitObserver=null;\n'+['css','renderListHeaderActions','renderLaborListControls','fitListActions','openListMore','closeListMore','listMoreDismiss','colorPortalHost','workOrderActions','workOrderFor','workOrderRows','workOrderSourceLists','workOrderWorthy','workOrdersAvailable','workOrderKey'].map(fn).join('\n');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:400}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<html><body><div id="root" data-materials-root></div></body></html>');
    const result=await page.evaluate(code=>{
      const list={id:'wo',resource_type:'labor',title:'',revision:3,metadata:{},current_items:[{id:'l1'}],assignment:{work_resource_ref:{id:'crew2',name:'Crew 2'}}};
      Object.assign(window,{state:{panelRoot:document.getElementById('root'),schedulingListId:'',laborMenu:null,lists:[list],workOrders:null,workOrderBusy:''},cleanText:v=>String(v??'').trim(),escapeHtml:v=>String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'),
        number:(v,f=0)=>Number.isFinite(Number(v))&&v!==null&&v!==''?Number(v):f,materialListOrdered:()=>false,resourceScheduleEnabled:()=>true,assignmentWorkResourceRef:entry=>entry.assignment?.work_resource_ref||null,laborListFinalized:()=>null,laborSettings:entry=>({id:entry.id,resource:entry.assignment.work_resource_ref}),
        materialRoot:()=>document.getElementById('root'),materialListById:id=>state.lists.find(entry=>entry.id===id),resourceType:entry=>entry.resource_type,listItems:entry=>entry.current_items||[],orgId:()=>'org',projectId:()=>'p',apiReady:()=>true,documentsOn:()=>true,materialsAPI:{labor:{workOrders:()=>null}},loadWorkOrders(){}});
      (0,eval)(code);const style=document.createElement('style');style.textContent=css();document.head.append(style);
      const draw=width=>{document.getElementById('root').innerHTML=`<div style="width:${width}px"><header class="mt-list-head" data-mt-actions-head><button type="button" data-mt-collapse-list="wo"><i></i></button><input data-mt-list-name="wo" value="" placeholder="Default"><span class="mt-list-total">$685.05</span>${renderLaborListControls(list,{bare:true})}${renderListHeaderActions(list,'labor','')}</header></div>`;fitListActions(document.getElementById('root'));
        return {shown:[...document.querySelectorAll('[data-mt-action]')].filter(b=>!b.hidden).map(b=>b.dataset.mtAction),more:!document.querySelector('[data-mt-list-more]').hidden};};
      state.workOrders={key:'org:p',rows:[]};
      const none=draw(900);
      state.workOrders.rows=[{scope:'list',list_id:'wo',document_id:'doc_work_order_wo',document:{metadata:{source_list_revisions:{wo:3}}}}];
      const written=draw(900);
      list.revision=4;
      const stale=draw(900),narrow=draw(270);
      openListMore(document.querySelector('[data-mt-list-more]'));
      return {none,written,stale,narrow,menu:[...document.querySelectorAll('[data-mt-list-more-menu] button span')].map(span=>span.textContent),staleDot:!!document.querySelector('[data-mt-work-order-open][data-stale="true"]')};
    },code);
    assert.deepEqual(result.none,{shown:['schedule','generate','payout','workorder','delete'],more:false});
    assert.deepEqual(result.written,{shown:['schedule','generate','payout','workorder','workorder-download','delete'],more:false},'once written: open and download, no second Generate');
    assert.deepEqual(result.stale.shown,['schedule','generate','payout','workorder','workorder-download','workorder-update','delete'],'a changed list can be written again');
    assert.equal(result.narrow.more,true,JSON.stringify(result));
    assert.ok(result.menu.includes('Download work order PDF')&&result.menu.includes('Update work order'),'the work order controls fold into ⋮ before Pay out does: '+JSON.stringify(result));
    assert.equal(result.staleDot,true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the work order column starts minimized when the documents require no work, once, and only with no work on it', () => {
  const run=({requirements,lists=[],loading=false})=>{
    const ctx={state:{loading,lists,minimizedTypes:new Set(),workOrderMinimizeDecided:''},cleanText,requirementsKey:()=>'org:p',requirementSet:()=>({key:'org:p',loading:false,error:'',data:{requirements}}),
      resourceCategories:()=>[{id:'material'},{id:'labor'},{id:'equipment'}],workOrderMerged:()=>true,resourceType:list=>list.resource_type,listItems:list=>list.current_items||[],assignmentWorkResourceRef:list=>list.assigned?{id:list.assigned}:null};
    vm.createContext(ctx);vm.runInContext(fn('minimizeIdleWorkOrder'),ctx);
    const first=ctx.minimizeIdleWorkOrder();return {first,minimized:ctx.state.minimizedTypes.has('labor'),ctx};
  };
  assert.deepEqual((({first,minimized})=>({first,minimized}))(run({requirements:[{kind:'material'}]})),{first:true,minimized:true});
  assert.equal(run({requirements:[]}).minimized,true,'a project with no requirements yet has no work either');
  assert.equal(run({requirements:[{kind:'work'}]}).minimized,false);
  assert.equal(run({requirements:[{kind:'function'}]}).minimized,false,'a function is met from the work order column too');
  assert.equal(run({requirements:[],lists:[{resource_type:'labor',current_items:[{}]}]}).minimized,false,'work already on the column is never hidden');
  assert.equal(run({requirements:[],lists:[{resource_type:'equipment',current_items:[{}]}]}).minimized,false);
  assert.equal(run({requirements:[],loading:true}).minimized,false,'not decided before the lists have loaded');
  // Decided once: restoring the column keeps it open.
  const {ctx}=run({requirements:[]});ctx.state.minimizedTypes.delete('labor');assert.equal(ctx.minimizeIdleWorkOrder(),false);assert.equal(ctx.state.minimizedTypes.has('labor'),false);
});
