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
 assert.deepEqual(await page.evaluate(()=>reportHeaderTabs([{id:'map'},{id:'measurements'}],[...measurementTabs(),{id:'model'},{id:'xml'}],true).map(t=>t.id)),['customer','standard','summary','project:map']);
 assert.equal(await page.evaluate(()=>reportHeaderTabs([{id:'map'},{id:'measurements'}],[...measurementTabs(),{id:'weather'}],true)),null);
 await page.close();
 }}finally{await browser.close();}
});
