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
  let activeBaseProject=null,overviewWorkflowMode='',requestedWorkflow='project',ordered=false,phone=matchMedia('(max-width: 760px)').matches,detailsTrayAsked=false;
  const projectOpenId=()=>activeBaseProject?.id||'';
  const hasReportOrdered=()=>ordered;
  const isMobileProjectOrder=()=>phone;
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
