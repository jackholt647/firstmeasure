import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const source=file=>readFile(new URL(`../../libraries/${file}`,import.meta.url),'utf8');

test('new project Notes opens without reads or writes, preserves draft while acquiring project, and discovers registered trays',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<div id="shell"><header class="r-modal-header"></header><main class="r-preview" style="height:600px"></main></div>');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'user'};window.project=null;window.reads=0;window.saves=0;window.posts=[];
   window.Portal={can:()=>true};
   window.ChannelsAPI={channels:{ensureProject:async()=>{window.reads++;return {channel:{id:'channel'}};}},messages:{list:async()=>({messages:[]}),post:async(_o,_c,body)=>{window.posts.push(body);return {message:{id:'note',...body}};}}};
  });
  for(const f of ['project-notes/project-notes.js','project-trays/project-trays.js'])await page.addScriptTag({content:await source(f)});
  await page.evaluate(async()=>{window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{getProject:()=>window.project,ensureProject:async()=>{window.saves++;window.project={id:'draft'};return window.project;}});await trays.select('notes');});
  assert.equal(await page.getByRole('textbox',{name:'New project note'}).isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>[window.reads,window.saves]),[0,0]);
  await page.getByRole('textbox',{name:'New project note'}).fill('Draft stays');
  await page.getByRole('tab',{name:'Activity',exact:true}).click();
  assert.match(await page.locator('.fm-project-tray-panel:visible').textContent(),/Select or create a project/);
  await page.getByRole('tab',{name:'Notes',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'New project note'}).inputValue(),'Draft stays');
  await page.getByRole('button',{name:'Add note',exact:true}).click();
  await page.waitForFunction(()=>window.posts.length===1);
  assert.equal(await page.evaluate(()=>window.saves),1);
  await page.getByRole('textbox',{name:'New project note'}).fill('Next draft');
  await page.evaluate(()=>trays.update());
  assert.equal(await page.getByRole('textbox',{name:'New project note'}).inputValue(),'Next draft');
  await page.evaluate(()=>FirstMateProjectTrays.register({id:'files',label:'Files',icon:'fa-folder',mount:node=>{node.textContent='Registered tray';return {};}}));
  assert.equal(await page.getByRole('tab',{name:'Files',exact:true}).isVisible(),true);
  assert.equal(await page.evaluate(()=>FirstMateProjectTrays.definitions().some(item=>item.id==='files')),true);
  await page.getByRole('tab',{name:'Files',exact:true}).click();assert.match(await page.locator('.fm-project-tray-panel:visible').textContent(),/Registered tray/);
  await page.getByRole('button',{name:'Close project tray'}).click();await page.evaluate(()=>trays.update());
  assert.equal(await page.locator('.fm-project-content').getAttribute('data-tray-open'),'false');
 }finally{await browser.close();}
});

test('report entry searches existing projects, preserves report intent, and switches to new project fields',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage();const app=await source('apps/project-request/app.js');
  const begin=app.indexOf('  function syncOverviewWorkflow(){'),end=app.indexOf('  function renderWorkflowStateBody',begin);
  await page.setContent('<div id="rOverlay"><div class="r-overview-details"><form id="rForm"><input data-field="name"></form></div></div>');
  await page.evaluate(()=>{
   window.$=selector=>document.querySelector(selector);window.overviewWorkflowMode='report';window.reportProjectChoice='search';window.activeBaseProject=null;
   window.decorateProjectContactActions=()=>{};window.handleProjectContactAction=()=>{};window.updateModalTitle=()=>{};window.scheduleProjectMapInitialize=()=>{};
   window.loadDocPickerRows=async()=>[{id:'p1',label:'Bill & Sarah Jones',address:'123 Main',search:'bill sarah jones 123 main',data:{address:'123 Main'}}];
   window.openProject=async(project,options)=>{window.opened={project,options};};window.renderWorkflowState=()=>syncOverviewWorkflow();
  });
  await page.addScriptTag({content:app.slice(begin,end)+'\nsyncOverviewWorkflow();'});
  await page.getByRole('searchbox',{name:'Search for an existing project'}).fill('Jones');
  await page.getByRole('option').click();
  assert.deepEqual(await page.evaluate(()=>window.opened),{project:{id:'p1',address:'123 Main'},options:{workflow:'report',tab:'map',forceRefresh:true}});
  await page.getByRole('button',{name:'New Project',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.reportProjectChoice),'new');
  assert.equal(await page.locator('.r-workflow-project-picker').isVisible(),false);
  assert.equal(await page.locator('#rOverlay').evaluate(el=>el.classList.contains('overview-project-picker')),false);
 }finally{await browser.close();}
});

test('Overview responds to content width with a tray and preserves padding without horizontal overflow',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1600,height:900}});const app=await source('apps/project-map/app.js');
  const start=app.indexOf('    const css = `',app.indexOf('  function injectOverviewCss'));const end=app.indexOf('    `;',start);
  await page.setContent('<div style="width:600px;height:700px"><div class="r-overview"><div class="r-overview-shell"><section class="r-overview-map-section"><div class="r-overview-map-head"><div>Map</div><button>Expand</button></div><div class="r-overview-map-frame"></div></section><section class="r-overview-panel"><div class="r-overview-grid"><button class="r-overview-card">Reports</button><button class="r-overview-card">Scheduling</button></div></section></div></div></div>');
  await page.addStyleTag({content:app.slice(start+'    const css = `'.length,end)});
  const result=await page.locator('.r-overview').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,padding:getComputedStyle(el).paddingRight,columns:getComputedStyle(el.querySelector('.r-overview-shell')).gridTemplateColumns}));
  assert.equal(result.width,result.scroll);assert.equal(result.padding,'18px');assert.equal(result.columns.trim().split(' ').length,1);
 }finally{await browser.close();}
});
