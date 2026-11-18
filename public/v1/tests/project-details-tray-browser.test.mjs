import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const source=(await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const tray=source.slice(source.indexOf('  const detailsTrayText='),source.indexOf('  // Measurements under the address'));
const shell=`<div id="rOverlay"><div class="r-win"><div class="r-window-bar"><button id="rProjectIdentityTrigger"></button><span id="rWindowProjectTitle">Project</span></div><div class="r-overview-details"></div></div></div>`;
// The window's own state, which open() and the order flow change, around the tray's real code.
const harness=`
  let activeBaseProject=null,overviewWorkflowMode='',requestedWorkflow='project',ordered=false,phone=matchMedia('(max-width: 760px)').matches,detailsTrayAsked=false,activePreviewTab='map';
  const projectOpenId=()=>activeBaseProject?.id||'';
  const hasReportOrdered=()=>ordered;
  const isMobileProjectOrder=()=>phone;
  const shouldUseMobileOrderPagination=()=>isMobileProjectOrder() && requestedWorkflow==='report' && !hasReportOrdered();
  const syncTrayMeasurements=()=>{};
  ${tray}
  window.t={
    sync:syncDetailsTray,
    openProject(id){detailsTrayProjectKey=null;activeBaseProject=id?{id}:null;overviewWorkflowMode=id?'':'project';syncDetailsTray();},
    save(id){activeBaseProject={id};overviewWorkflowMode='';syncDetailsTray();},
    startOrder(){requestedWorkflow='report';overviewWorkflowMode='report';syncDetailsTray();},
    orderPlaced(id){activeBaseProject={id};requestedWorkflow='project';overviewWorkflowMode='';ordered=true;syncDetailsTray();},
    orderPages(on){document.getElementById('rOverlay').classList.toggle('mobile-order',on);syncDetailsTray();},
    userSet(open){setDetailsTrayOpen(open,{user:true});},
    // The window's tab change (setActivePreviewTab) and the guide runtime's list (FirstMateGuides.preload).
    tab(id){activePreviewTab=id;syncDetailsTrayOperations();},
    opsSetup(status,on=true){window.PlatformAPI={capabilities:{can:key=>key==='platform.materials' && on}};window.FirstMateGuides={preload:async()=>({experiences:new Map(status===undefined?[]:[['operations.setup',{id:'operations.setup',progress:status?{status}:null}]])})};},
    setupFinished(){window.FirstMateGuides.preload=async()=>({experiences:new Map([['operations.setup',{progress:{status:'completed'}}]])});window.dispatchEvent(new CustomEvent('fm:guides:ended',{detail:{id:'operations.setup'}}));},
    setPhone(on){phone=on;window.dispatchEvent(new Event('resize'));},
    isOpen:()=>document.getElementById('rOverlay').classList.contains('details-tray-open'),
    isSheet:()=>document.getElementById('rOverlay').classList.contains('details-tray-sheet'),
  };
`;

async function mount(browser,width){
  const page=await browser.newPage({viewport:{width,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://dev.1m8.ai/tray',route=>route.fulfill({contentType:'text/html',body:`<!doctype html>${shell}`}));
  await page.goto('https://dev.1m8.ai/tray');
  // A browser that closed the tray before it stopped being remembered.
  await page.evaluate(()=>localStorage.setItem('firstmate.project.detailsTray','closed'));
  await page.addScriptTag({content:harness});
  return {page,errors,isOpen:()=>page.evaluate(()=>t.isOpen()),run:(name,...args)=>page.evaluate(([n,a])=>t[n](...a),[name,args])};
}

test('on a desktop window any project starts with the details tray open, whatever this browser remembered',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen,errors,page}=await mount(browser,1280);
    await run('openProject','project_a');
    assert.equal(await isOpen(),true,'existing project');
    assert.equal(await page.evaluate(()=>t.isSheet()),false);
    await run('openProject','');
    assert.equal(await isOpen(),true,'new project');
    await run('openProject','project_ordered');
    assert.equal(await isOpen(),true,'project with an order');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('an order hands back to the project with the tray still open, also when the order saved a new project',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen}=await mount(browser,1280);
    await run('openProject','');
    await run('startOrder');
    assert.equal(await isOpen(),true,'ordering');
    await run('orderPlaced','project_new');
    assert.equal(await isOpen(),true,'new project after its order');
    await run('openProject','project_a');
    await run('startOrder');
    await run('orderPlaced','project_a');
    assert.equal(await isOpen(),true,'existing project after its order');
  }finally{await browser.close();}
});

test('a person closing the tray holds for that project, through a save, until another project opens',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen,page}=await mount(browser,1280);
    await run('openProject','project_a');
    await run('userSet',false);
    await run('sync');
    assert.equal(await isOpen(),false,'re-render keeps the close');
    await run('openProject','project_b');
    assert.equal(await isOpen(),true,'the next project starts open');
    await run('openProject','');
    await run('userSet',false);
    await run('save','project_new');
    assert.equal(await isOpen(),false,'taking an id is the same project');
    await run('openProject','project_b');
    assert.equal(await isOpen(),true);
    assert.equal(await page.evaluate(()=>localStorage.getItem('firstmate.project.detailsTray')),'closed','no choice is written any more');
  }finally{await browser.close();}
});

test('on a phone the sheet stays out of the way unless the form is the work',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen,page}=await mount(browser,390);
    await page.evaluate(()=>localStorage.setItem('firstmate.project.detailsTray','open'));
    await run('openProject','project_a');
    assert.equal(await isOpen(),false,'existing project');
    assert.equal(await page.evaluate(()=>t.isSheet()),true);
    await run('openProject','');
    assert.equal(await isOpen(),true,'a new project is filled in on the sheet');
    await run('save','project_new');
    assert.equal(await isOpen(),true,'saving does not pull the form away');
    await run('orderPages',true);
    assert.equal(await isOpen(),false,'the order pages keep the form in Overview');
  }finally{await browser.close();}
});

test('crossing between desktop and phone follows the default unless the person chose',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen}=await mount(browser,1280);
    await run('openProject','project_a');
    await run('setPhone',true);
    assert.equal(await isOpen(),false,'a sheet would cover the project');
    await run('setPhone',false);
    assert.equal(await isOpen(),true,'back beside the content');
    await run('userSet',false);
    await run('setPhone',true);
    await run('setPhone',false);
    assert.equal(await isOpen(),false,'the close holds');
  }finally{await browser.close();}
});

test('the window wiring reapplies the default per project and implicit report landings leave the phone sheet shut',()=>{
  assert.match(source,/function open\(baseProject = null[\s\S]{0,1200}!baseProject \|\| projectOpenId\(baseProject\) !== projectOpenId\(activeBaseProject\)\) detailsTrayProjectKey = null;/);
  assert.match(source,/function close\(options = \{\}\)\{[\s\S]{0,700}detailsTrayProjectKey = null;/);
  assert.equal(source.includes('firstmate.project.detailsTray'),false);
  assert.match(source,/if \(!options\.preferredTab\) setActivePreviewTab\('measurements',\{keepTrayClosed:true\}\);/);
  assert.match(source,/!validPreviewTabs\(\)\.includes\(activePreviewTab\)\) \{\n\s+setActivePreviewTab\('measurements',\{keepTrayClosed:true\}\);/);
});

// FM-360: guided experiences hear the tray (panel `project.details`): a tab's tour waits while the sheet covers a phone,
// the tray's tour plays when it opens and the window's tour on the person's first close.
test('the tray announces opening and closing to guided experiences, whether it covers the page and who closed it',async()=>{
  const browser=await launch();
  try{
    const {run,page,errors}=await mount(browser,390);
    await page.evaluate(()=>{window.panelEvents=[];for(const type of ['opened','closed'])addEventListener('fm:project-panel:'+type,e=>panelEvents.push({type,panel:e.detail.panel,covers:e.detail.covers,user:e.detail.user,covering:e.detail.covering()}));document.getElementById('rOverlay').classList.add('active');});
    const take=()=>page.evaluate(()=>panelEvents.splice(0));
    await run('openProject','');
    assert.deepEqual(await take(),[{type:'opened',panel:'project.details',covers:true,user:false,covering:true}],'a new project on a phone opens the sheet');
    assert.equal(await page.evaluate(()=>document.getElementById('rProjectIdentityTrigger').getAttribute('aria-expanded')),'true');
    await run('userSet',false);
    assert.deepEqual(await take(),[{type:'closed',panel:'project.details',covers:true,user:true,covering:false}]);
    assert.equal(await page.evaluate(()=>document.getElementById('rProjectIdentityTrigger').getAttribute('aria-expanded')),'false');
    await run('userSet',false);
    assert.deepEqual(await take(),[],'nothing changed, nothing announced');
    // A hidden window announces nothing; it announces the open tray once it shows.
    await page.evaluate(()=>document.getElementById('rOverlay').classList.remove('active'));
    await run('userSet',true);
    assert.deepEqual(await take(),[]);
    await page.evaluate(()=>document.getElementById('rOverlay').classList.add('active'));
    await page.waitForFunction(()=>panelEvents.length===1);
    assert.deepEqual(await take(),[{type:'opened',panel:'project.details',covers:true,user:false,covering:true}]);
    // Widened to a desktop it stays open beside the content: it no longer covers the page.
    await run('setPhone',false);
    await page.setViewportSize({width:1280,height:800});
    await page.waitForFunction(()=>panelEvents.length===1);
    assert.deepEqual(await take(),[{type:'opened',panel:'project.details',covers:false,user:false,covering:false}]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the title carries arrows pointing the way the tray will go',()=>{
  assert.match(source,/#rProjectIdentityTrigger,\.r-project-identity-trigger\)::after\{content:'\\\\f101'/,'closed: arrows pointing right, to open');
  assert.match(source,/#rProjectIdentityTrigger\[aria-expanded=true\]::after\{content:'\\\\f100'\}/,'open: arrows pointing left, as the sheet\'s close');
  assert.match(source,/close\.innerHTML='<i class="fas fa-angles-left"/);
});

// FM-611: Operations shows the measurements itself, so once Operations is set up the tray steps aside on that tab and
// comes back on leaving it, unless the person set it by hand there.
test('the Operations tab closes the tray once Operations is set up and gives it back on leaving',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen,errors,page}=await mount(browser,1280);
    const settle=()=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,20)));
    await page.evaluate(()=>{window.panelEvents=[];addEventListener('fm:project-panel:closed',e=>panelEvents.push(e.detail.user));document.getElementById('rOverlay').classList.add('active');});
    await run('opsSetup','completed');
    await run('openProject','project_a');
    await run('tab','materials');await settle();
    assert.equal(await isOpen(),false,'set up: Operations closes it');
    assert.deepEqual(await page.evaluate(()=>panelEvents),[false],'announced as not the person\'s close, so no close tour plays');
    await run('tab','docs');await settle();
    assert.equal(await isOpen(),true,'leaving Operations opens it again');
    // A tray the person had closed stays closed both ways.
    await run('userSet',false);
    await run('tab','materials');await settle();
    await run('tab','map');await settle();
    assert.equal(await isOpen(),false,'never opened by leaving when Operations did not close it');
    // Set by hand on Operations: that holds for the visit and is what stays after it.
    await run('userSet',true);
    await run('tab','materials');await settle();
    assert.equal(await isOpen(),false);
    await run('userSet',true);
    await run('tab','materials');await settle();
    assert.equal(await isOpen(),true,'opened by hand on Operations stays open there');
    await run('userSet',false);
    await run('tab','map');await settle();
    assert.equal(await isOpen(),false,'closed by hand on Operations stays closed after');
    // Opening a project straight on Operations closes it too.
    await run('openProject','project_b');await settle();
    assert.equal(await isOpen(),true);
    await run('tab','materials');await settle();
    await run('openProject','project_c');await settle();
    assert.equal(await isOpen(),false,'the next project opened on Operations');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the tray stays put on Operations until its setup is finished, then closes when it finishes',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen,errors,page}=await mount(browser,1280);
    const settle=()=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,20)));
    for(const status of [null,'started','dismissed','deferred']){
      await run('opsSetup',status);
      await run('openProject','project_'+status);
      await run('tab','materials');await settle();
      assert.equal(await isOpen(),true,`setup ${status}`);
      await run('tab','map');await settle();
    }
    await run('opsSetup',null);
    await run('tab','materials');await settle();
    await run('setupFinished');await settle();
    assert.equal(await isOpen(),false,'finishing the setup on Operations closes it');
    await run('tab','map');await settle();
    assert.equal(await isOpen(),true);
    // Not offered to this person (the list has no Operations setup): nothing to set up first.
    await run('opsSetup',undefined);
    await run('tab','materials');await settle();
    assert.equal(await isOpen(),false);
    // Operations only offered (its welcome shows), so its setup is not listed either: not set up.
    await run('tab','map');await settle();
    await run('opsSetup',undefined,false);
    await run('tab','materials');await settle();
    assert.equal(await isOpen(),true,'an offered Operations is not set up');
    // A list that could not be read leaves the tray alone.
    await run('tab','map');await settle();
    await page.evaluate(()=>{window.FirstMateGuides={preload:async()=>null};});
    await run('tab','materials');await settle();
    assert.equal(await isOpen(),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('on a phone Operations leaves the tray sheet alone',async()=>{
  const browser=await launch();
  try{
    const {run,isOpen,errors,page}=await mount(browser,390);
    const settle=()=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,20)));
    await run('opsSetup','completed');
    await run('openProject','');
    assert.equal(await isOpen(),true,'a new project is filled in on the sheet');
    await run('tab','materials');await settle();
    assert.equal(await isOpen(),true);
    await run('openProject','project_a');
    await run('tab','map');await settle();
    assert.equal(await isOpen(),false,'never opened over the page by leaving Operations');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the window tells the tray about every tab change',()=>{
  assert.match(source,/syncProjectModalAppActivation\(previousTab\);\n\s+syncDetailsTrayOperations\(\);/);
});
