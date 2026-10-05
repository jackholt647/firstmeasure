import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const load=async path=>process.env.HOSTED_ONLY ? (await fetch('https://dev.1m8.ai/'+path.replace(/^public\//,''))).text() : readFile(new URL('../../../'+path,import.meta.url),'utf8');
const source=await load('public/libraries/apps/measurements/project.js');
const shell=await load('public/libraries/apps/project-request/app.js');
function fn(name){const start=source.indexOf('  function '+name+'(');assert.ok(start>=0);return source.slice(start,source.indexOf('\n  }',start)+4);}
test('report header uses four or five equal tabs and retains selection across project/report switches',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{for(const width of [414,1100]){
 const page=await browser.newPage({viewport:{width,height:850}});
 await page.setContent('<div id="rOverlay" class="r-overlay active project-layout-prototype report-ordered"><header class="r-modal-header r-window-bar"><div id="rProjectViewerTabs">Map Reports</div></header><section data-panel="measurements" class="r-preview-panel active"><div id="rMeasureTabs"></div><div class="r-measure-body"></div></section></div>');
 await page.addStyleTag({content:shell.slice(shell.indexOf('    .r-measure-tabs{'),shell.indexOf('    .r-measure-body{'))});
 await page.evaluate(()=>{window.Portal={};window.state={mounted:true,host:{}};window.context={ordered:true,tabs:[{id:'map'},{id:'measurements'}],activeTab:'measurements'};window.activeMeasurementTab='standard';window.currentPanelRoot=()=>document.querySelector('section');window.callHost=()=>context;window.measurementTabs=()=>['summary','standard','customer'].map(id=>({id,label:id,active:id===activeMeasurementTab}));window.setActivePreviewTab=id=>{context.activeTab=id;renderReportNavigation();};window.setActiveMeasurementTab=id=>{activeMeasurementTab=id;renderReportNavigation();};});
 await page.addScriptTag({content:await load('public/portal/scripts/project_viewer.js')});
 await page.addScriptTag({content:fn('reportHeaderTabs')+'\n'+fn('renderReportNavigation')+'\nrenderReportNavigation();'});
 assert.equal(await page.locator('#rProjectViewerTabs').isVisible(),false);
 for(const photos of [false,true]){
 if(photos)await page.evaluate(()=>{context.tabs.push({id:'photos',label:'Photos',icon:'fa-camera'});renderReportNavigation();});
 const ids=['customer','standard','summary','project:map',...(photos?['project:photos']:[])];
 assert.equal(await page.locator('#rMeasureTabs button').count(),ids.length);
 for(const id of [...ids,'customer','standard']){
 await page.locator('#rMeasureTabs [data-tab="'+id+'"]').click();
 assert.equal(await page.locator('#rMeasureTabs .active').count(),1);
 assert.equal(await page.locator('#rMeasureTabs .active').getAttribute('data-tab'),id);
 assert.equal(await page.locator('#rMeasureTabs [aria-selected=true]').count(),1);
 }
 const sizes=await page.locator('#rMeasureTabs button').evaluateAll(nodes=>nodes.map(e=>e.getBoundingClientRect()));
 assert.ok(sizes.every(r=>Math.abs(r.width-sizes[0].width)<1 && r.height===32));
 }
 await page.evaluate(()=>{context.tabs.push({id:'docs'});renderReportNavigation();});
 assert.equal(await page.locator('#rProjectViewerTabs').isVisible(),true);
 assert.equal(await page.locator('section #rMeasureTabs button').count(),3);
 await page.locator('#rMeasureTabs [data-tab=summary]').click();
 assert.equal(await page.locator('#rMeasureTabs .active').getAttribute('data-tab'),'summary');
 await page.evaluate(()=>{context.tabs=context.tabs.filter(t=>t.id!=='docs');context.ordered=false;renderReportNavigation();});
 assert.equal(await page.locator('.flat-report-navigation').count(),0);
 assert.deepEqual(await page.evaluate(()=>reportHeaderTabs([{id:'map'},{id:'measurements'}],[...measurementTabs(),{id:'model'},{id:'xml'}],true).map(t=>t.id)),['project:map','summary','standard','customer']);
 assert.equal(await page.evaluate(()=>reportHeaderTabs([{id:'map'},{id:'measurements'}],[...measurementTabs(),{id:'weather'}],true)),null);
 await page.close();
 }}finally{await browser.close();}
});


test('mobile opening header has final tabs and no desktop pills before child boot',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:414,height:850}});
 await page.route('https://shell.test/**',route=>route.fulfill({contentType:'text/html',body:'<main class="main"></main>'}));
 await page.goto('https://shell.test/');
 await page.evaluate(()=>{window.Portal={modules:{request:{openingHeader:()=>({title:'Test roof',identityHtml:'Test roof',pillsHtml:'<button>Residential</button>'})}}};});
 await page.addScriptTag({content:await load('public/portal/scripts/project_viewer.js')});
 const start=shell.indexOf('  function openingProjectTabs(');
 await page.evaluate(()=>{window.projectViewerTabs=()=>[{id:'map'},{id:'measurements'}];window.weatherReportsEnabled=()=>false;window.reportFollowupEnabled=()=>false;window.appFeatureEnabled=()=>true;});
 await page.addScriptTag({content:shell.slice(start,shell.indexOf('\n  }',start)+4)+'\nPortal.modules.request.openingTabs=openingProjectTabs;'});
 for(const file of ['window-manager.js','window-shell.js','project-windows.js'])await page.addScriptTag({content:await load('public/libraries/window-manager/'+file)});
 const initial=await page.evaluate(()=>{
  window.record=FirstMateProjectWindows.open({id:'project_test',status:'processing'},{tab:'measurements'});
  const h=document.querySelector('.fm-project-loading-header');
  return {mobile:h.dataset.windowMobile,tabs:[...h.querySelectorAll('[data-tab]')].map(e=>e.dataset.tab),pills:getComputedStyle(h.querySelector('.r-project-stage-bar')).display};
 });
 assert.equal(initial.mobile,'true');assert.equal(initial.pills,'none');assert.deepEqual(initial.tabs,['project:map','summary','standard','customer']);
 assert.equal(await page.locator('.fm-project-loading-header .fa-file-pdf').count(),2);
 assert.equal(await page.locator('.fm-project-loading-header [data-tab=customer] .fa-user').count(),1);
 const sizes=await page.locator('.fm-project-loading-header [data-tab]').evaluateAll(nodes=>nodes.map(e=>e.getBoundingClientRect()));
 assert.ok(sizes.every(r=>Math.abs(r.width-sizes[0].width)<1&&r.height===32));
 assert.equal(await page.locator('.fm-project-loading-header [data-window-action=close]').isVisible(),true);
 assert.equal(await page.locator('.fm-project-loading-header [data-window-action=minimize]').isVisible(),false);
 await page.locator('.fm-project-loading-header [data-tab="project:map"]').click();
 assert.equal(await page.evaluate(()=>record.options.tab),'map');
 await page.locator('.fm-project-loading-header [data-tab=standard]').click();
 assert.equal(await page.evaluate(()=>record.options.reportView),'standard');
 await page.evaluate(()=>FirstMateProjectWindows.close(record.token));
 await page.evaluate(()=>{
  document.body.innerHTML='<div id="rOverlay"><header class="r-modal-header"><nav id="rProjectViewerTabs"></nav></header></div>';
  window.$=selector=>document.querySelector(selector);window.activeBaseProject={id:'project_test',status:'processing'};window.activePreviewTab='measurements';window.requestedWorkflow='project';
 });
 const renderStart=shell.indexOf('  function renderOpeningReportTabs(');
 await page.addScriptTag({content:shell.slice(renderStart,shell.indexOf('\n  }',renderStart)+4)+'\nrenderOpeningReportTabs();'});
 assert.deepEqual(await page.locator('#rOpeningReportTabs [data-tab]').evaluateAll(nodes=>nodes.map(e=>e.dataset.tab)),initial.tabs);
 assert.equal(await page.locator('#rOpeningReportTabs .active').getAttribute('data-tab'),'standard');

 }finally{await browser.close();}
});


test('mobile title and dropdown geometry match before and after content boot',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:414,height:850}});
 await page.route('https://shell.test/**',route=>route.fulfill({contentType:'text/html',body:'<main class="main"></main>'}));await page.goto('https://shell.test/');
 await page.evaluate(()=>{window.Portal={modules:{request:{openingHeader:()=>({title:'1850 N Clark St, Chicago, IL 60614',identityHtml:'<strong>1850 N Clark St, Chicago, IL 60614</strong>',pillsHtml:''})}}};});
 const cssStart=shell.indexOf('  const css = `')+15;
 await page.addStyleTag({content:shell.slice(cssStart,shell.indexOf('\n  `;',cssStart))});
 for(const file of ['window-manager.js','window-shell.js','project-windows.js'])await page.addScriptTag({content:await load('public/libraries/window-manager/'+file)});
 await page.evaluate(()=>{window.record=FirstMateProjectWindows.open({id:'project_test',status:'processing'},{tab:'measurements'});});
 const readGeometry=()=>{
  const header=document.querySelector('.fm-project-loading-header') || document.querySelector('.r-window-bar');
  const trigger=header.querySelector('.r-project-identity-trigger'),title=trigger.querySelector('span'),controls=header.querySelector('.r-window-bar-actions');
  return {mobile:header.dataset.windowMobile,headerClass:header.className,parent:header.parentElement.className,headerWidth:header.getBoundingClientRect().width,identityWidth:trigger.parentElement.getBoundingClientRect().width,controlsWidth:controls.getBoundingClientRect().width,stageWidth:header.querySelector('.r-project-stage-bar')?.getBoundingClientRect().width,stageDisplay:getComputedStyle(header.querySelector('.r-project-stage-bar')).display,font:getComputedStyle(title).fontSize,width:trigger.getBoundingClientRect().width,titleWidth:title.getBoundingClientRect().width,maxWidth:getComputedStyle(trigger).maxWidth,height:header.getBoundingClientRect().height,border:getComputedStyle(controls).borderLeftWidth};
 };
 await page.addStyleTag({url:'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'});await page.evaluate(()=>document.fonts.ready);
 const opening=await page.evaluate(readGeometry);
 if(process.env.EVIDENCE_DIR)await page.screenshot({path:process.env.EVIDENCE_DIR+'/opening.png'});
 assert.equal(opening.font,'18px');assert.equal(opening.maxWidth,'100%');assert.equal(opening.border,'0px');
 await page.evaluate(()=>{
  const header=document.querySelector('.fm-project-loading-header').cloneNode(true);
  FirstMateProjectWindows.close(record.token);
  header.className='r-window-bar r-modal-header fm-shell-header';
  header.querySelector('.r-project-identity-trigger').id='rProjectIdentityTrigger';header.querySelector('.r-window-project-title').id='rWindowProjectTitle';
  const overlay=document.createElement('div');overlay.className='r-overlay active window-managed project-layout-prototype';overlay.style.cssText='display:block;position:fixed;inset:0';
  const win=document.createElement('div');win.className='r-win fm-entity-window';win.style.cssText='position:absolute;inset:0;width:100%;height:100%;padding:0;max-width:none;max-height:none;border:0';win.append(header);overlay.append(win);document.body.append(overlay);
 });
 const windowStart=shell.indexOf("injectCSS('project-window', `")+"injectCSS('project-window', `".length;
 await page.addStyleTag({content:shell.slice(windowStart,shell.indexOf('`);',windowStart))});
 const layout=await load('public/libraries/window-manager/project-layout.js');const layoutStart=layout.indexOf('textContent=`')+13;
 await page.addStyleTag({content:layout.slice(layoutStart,layout.indexOf('`;',layoutStart))});
 await page.evaluate(()=>document.head.append(document.getElementById('fm-window-shell-style')));
 const loaded=await page.evaluate(readGeometry);
 if(process.env.EVIDENCE_DIR)await page.screenshot({path:process.env.EVIDENCE_DIR+'/loaded.png'});
 assert.equal(loaded.font,opening.font);assert.equal(loaded.maxWidth,opening.maxWidth);assert.equal(loaded.border,opening.border);
 assert.ok(Math.abs(loaded.width-opening.width)<1,JSON.stringify({opening,loaded}));
 assert.ok(Math.abs(loaded.titleWidth-opening.titleWidth)<1,JSON.stringify({opening,loaded}));
 assert.ok(Math.abs(loaded.height-opening.height)<1,JSON.stringify({opening,loaded}));
 }finally{await browser.close();}
});
