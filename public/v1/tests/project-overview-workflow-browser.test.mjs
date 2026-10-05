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
  await page.setContent('<div id="rOverlay"><div class="r-overview-details"><form id="rForm"><section id="rStepCustomer"><input data-field="name"></section></form></div></div>');
  await page.evaluate(()=>{
   window.$=selector=>document.querySelector(selector);window.overviewWorkflowMode='report';window.reportProjectChoice='search';window.activeBaseProject=null;window.requestedWorkflow='report';window.addressSelected=false;window.selectedType='residential';window.hasReportOrdered=()=>false;window.firstMeasureReportOrdersEnabled=()=>true;window.actionAvailable=()=>true;window.expandedPlatformEnabled=()=>true;
   window.decorateProjectContactActions=()=>{};window.handleProjectContactAction=()=>{};window.updateModalTitle=()=>{};window.scheduleProjectMapInitialize=()=>{};
   window.loadDocPickerRows=async()=>[{id:'p1',label:'Bill & Sarah Jones',address:'123 Main',search:'bill sarah jones 123 main',data:{address:'123 Main'}}];
   window.openProject=async(project,options)=>{window.opened={project,options};};window.renderWorkflowState=()=>syncOverviewWorkflow();
  });
  await page.addScriptTag({content:app.match(/  function reportHeaderPending[^\n]+/)[0]+'\n'+app.slice(begin,end)+'\nsyncOverviewWorkflow();'});
  assert.equal(await page.locator('#rOverlay').evaluate(el=>el.classList.contains('overview-focused-report')),true);
  await page.getByRole('searchbox',{name:'Search for an existing project'}).fill('Jones');
  await page.getByRole('option').click();
  assert.deepEqual(await page.evaluate(()=>window.opened),{project:{id:'p1',address:'123 Main'},options:{workflow:'report',tab:'map',forceRefresh:true}});
  await page.getByRole('button',{name:'New Project',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.reportProjectChoice),'new');
  assert.equal(await page.locator('.r-workflow-project-picker').isVisible(),false);
  assert.equal(await page.locator('#rOverlay').evaluate(el=>el.classList.contains('overview-project-picker')),false);
  await page.evaluate(()=>{addressSelected=true;syncOverviewWorkflow();});
  assert.equal(await page.locator('#rOverlay').evaluate(el=>el.classList.contains('overview-focused-report')),false,'a defined project restores normal chrome');
  assert.equal(await page.evaluate(()=>reportProjectChoice),'existing');
  await page.evaluate(()=>{
    requestedWorkflow='project';overviewWorkflowMode='';activeBaseProject={id:'existing',measurement:{id:'report'}};addressSelected=true;
    window.hasReportOrdered=()=>true;window.applyReorderPrefillState=project=>{window.reordered=project.id;};
    window.preloadFirstReportCheckoutEligibility=()=>{};window.setActivePreviewTab=tab=>{window.chosenTab=tab;};window.queueAutosaveNotice=()=>{};
    syncOverviewWorkflow();
  });
  assert.equal(await page.getByRole('button',{name:'Order report',exact:true}).count(),0);
  await page.evaluate(()=>{window.hasReportOrdered=()=>false;syncOverviewWorkflow();});
  assert.equal(await page.getByRole('button',{name:'Order report',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'Build proposal',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'Schedule appointment',exact:true}).isVisible(),true);
  await page.getByRole('button',{name:'Order report',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>[window.reordered,requestedWorkflow,reportProjectChoice,window.chosenTab]),[undefined,'report','existing','map']);

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


test('Overview field autosave persists without a mounted proposal and honors hydration suppression',async()=>{
 const {default:vm}=await import('node:vm');const app=await source('apps/project-request/app.js');
 const start=app.indexOf('  function queueAutosaveNotice('),end=app.indexOf('\n  }',start)+4;
 const calls=[];const context={suppressAutosaveNotice:false,persistActiveBaseProject:()=>calls.push('project'),proposalsEnabled:()=>true,proposalTabModule:()=>({}),proposalInvoke:()=>calls.push('proposal')};
 vm.createContext(context);vm.runInContext(app.slice(start,end),context);context.queueAutosaveNotice();assert.deepEqual(calls,['project','proposal']);
 calls.length=0;context.suppressAutosaveNotice=true;context.queueAutosaveNotice();assert.deepEqual(calls,[]);
 context.suppressAutosaveNotice=false;context.proposalsEnabled=()=>false;context.queueAutosaveNotice();assert.deepEqual(calls,['project']);
});

test('existing projects always get normal opening identity, including explicit report entry',async()=>{
 const app=await source('apps/project-request/app.js');
 const fn=app.slice(app.indexOf('  function openingProjectHeader('),app.indexOf('  function projectHeaderState('));
 const render=new Function('projectOpenId','projectHeaderIdentityHtml','branchProjectConfig','formatProjectContactNames','projectPrimaryContactAlias','projectDisplayTitle','projectText','projectIdentity','projectHeaderPillsHtml',fn+';return openingProjectHeader;')(
  p=>p.id || p.platform_project_id || '',(title,contact,address)=>[title,contact,address].join('|'),{title_mode:'all_contacts'},()=>'',()=>({name:'Contact'}),p=>p.title || p.address,s=>s,p=>p.id,()=>'<pill>');
 assert.equal(render({}, {workflow:'report'}).title,'New Report');
 for(const options of [{},{workflow:'report'}])assert.equal(render({id:'existing',title:'Existing Project'},options).title,'Existing Project');
 assert.equal(render({platform_project_id:'existing',address:'123 Main'},{workflow:'report'}).title,'123 Main');
});


for(const width of [390,1280])for(const expanded of [false,true])test(`unordered overview actions and contact visibility ${width}, expanded=${expanded}`,async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage({viewport:{width,height:900}}),app=await source('apps/project-request/app.js');
 const contact='<div class="r-group"><div id="rContactList"><div class="r-contact-card"><input aria-label="Contact name" value="Kept contact"></div></div></div>';
 const address='<section id="rStepAddress"><input id="rAddress" value="123 Main"></section><section id="rStepType"><select aria-label="Property type"><option>Residential</option></select></section>';
 await page.setContent(`<div id="rOverlay" class="r-overlay active"><div class="r-overview-details"><form><div class="r-scroll"><section id="rStepCustomer">${contact}${expanded?address+'<div id="rProjectCustomFields">Custom</div>':''}</section>${expanded?'':address}<div id="rWorkflowDock">Tasks</div></div><div class="r-left-bottom">Internal notes</div></form></div><section class="r-project-identity-popover"><input aria-label="Header contact" value="Kept contact"></section></div>`);
 const cssStart=app.indexOf('  const css = `')+15;await page.addStyleTag({content:app.slice(cssStart,app.indexOf('\n  `;',cssStart))});
 await page.addStyleTag({content:'#rOverlay{display:block;overflow:auto}.r-project-identity-popover{position:static}'});
 await page.evaluate(expanded=>{
 window.$=s=>document.querySelector(s);window.expandedPlatformEnabled=()=>expanded;window.hasReportOrdered=()=>false;window.overviewWorkflowMode='';window.reportProjectChoice='existing';window.activeBaseProject={id:'p1'};window.requestedWorkflow='project';window.addressSelected=true;window.selectedType='residential';window.firstMeasureReportOrdersEnabled=()=>true;window.actionAvailable=()=>expanded;window.decorateProjectContactActions=()=>{};window.handleProjectContactAction=()=>{};window.updateModalTitle=()=>{};window.preloadFirstReportCheckoutEligibility=()=>{};window.setActivePreviewTab=t=>window.selectedTab=t;window.queueAutosaveNotice=()=>{};window.renderWorkflowState=()=>syncOverviewWorkflow();
 },expanded);
 const begin=app.indexOf('  function syncOverviewWorkflow(){'),end=app.indexOf('  function renderWorkflowStateBody',begin);
 await page.addScriptTag({content:app.match(/  function reportHeaderPending[^\n]+/)[0]+'\n'+app.slice(begin,end)+'\nsyncOverviewWorkflow();'});
 assert.equal(await page.locator('.r-overview-initial-actions button').count(),expanded?3:1);
 const boxes=await page.evaluate(()=>Object.fromEntries(['#rStepAddress','#rStepType','.r-overview-initial-actions'].map(s=>[s,document.querySelector(s).getBoundingClientRect().toJSON()])));
 assert.ok(boxes['.r-overview-initial-actions'].y>=boxes['#rStepType'].bottom);assert.ok(boxes['.r-overview-initial-actions'].y>=boxes['#rStepAddress'].bottom);
 assert.equal(await page.getByRole('textbox',{name:'Contact name',exact:true}).isVisible(),expanded);
 if(!expanded)assert.equal(await page.locator('.r-left-bottom').isVisible(),false);
 assert.equal(await page.getByRole('textbox',{name:'Header contact'}).inputValue(),'Kept contact');
 assert.equal(await page.locator('#rStepAddress').evaluate(e=>getComputedStyle(e).borderTopWidth),expanded?'1px':'0px');
 await page.getByRole('button',{name:'Order report',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>[requestedWorkflow,reportProjectChoice,selectedTab]),['report','existing','map']);
 assert.equal(await page.locator('#rOverlay').evaluate(e=>e.classList.contains('firstmeasure-unordered-overview')),false);
 assert.equal(await page.getByRole('textbox',{name:'Contact name',exact:true}).inputValue(),'Kept contact');
 await page.evaluate(()=>{requestedWorkflow='project';window.hasReportOrdered=()=>true;syncOverviewWorkflow();});
 assert.equal(await page.locator('#rStepCustomer').isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'Order report',exact:true}).count(),0);
 }finally{await browser.close();}
});


test('an unordered FirstMeasure project can edit an empty contact from its header before entering the order',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage(),app=await source('apps/project-request/app.js');await page.setContent('<div id="rContactList"></div>');
 await page.evaluate(()=>{window.$=s=>document.querySelector(s);window.requestedWorkflow='project';window.expandedPlatformEnabled=()=>false;window.hasReportOrdered=()=>false;window.calls=[];window.addContactCard=(data,options)=>{calls.push(options);document.querySelector('#rContactList').innerHTML='<div class="r-contact-card"></div>';};});
 const start=app.indexOf('  function ensureOrderContactFields(){'),end=app.indexOf('  function openProjectIdentityPopover',start);await page.addScriptTag({content:app.slice(start,end)+'\nensureOrderContactFields();ensureOrderContactFields();'});
 assert.deepEqual(await page.evaluate(()=>calls),[{hydrate:true}]);
 }finally{await browser.close();}
});
