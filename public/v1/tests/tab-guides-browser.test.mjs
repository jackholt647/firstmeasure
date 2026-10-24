import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Project tab pills, first-open tutorials, the organization's tab order and the
// terminology rename (docs/architecture/project-tab-guides.md).
const read=file=>readFile(new URL('../../'+file,import.meta.url),'utf8');
const sources={
  promos:await read('libraries/apps/tab-promos/project.js'),
  viewer:await read('portal/scripts/project_viewer.js'),
  tutorial:await read('libraries/apps/tutorial/app.js'),
  guides:await read('libraries/tab-guides/tab-guides.js'),
  terminology:await read('libraries/platform-terminology/platform-terminology.js')
};
const settings={order:['project.photos','project.map'],pills:{'project.photos':'new','project.docs':'coming_soon'}};

/** One page load of a project window's tab strip, with the person's saved preferences (`store`) and the organization's tab settings. */
async function load(browser,store,{width=1280,tutorial=true}={}){
  const page=await browser.newPage({viewport:{width,height:720}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<style>body{margin:0;font:14px Arial}#tabs{display:flex;overflow-x:auto;max-width:100%}.r-tab{display:inline-flex;align-items:center;gap:6px;padding:10px 12px;border:0;background:#fff;white-space:nowrap}
    .stage{position:relative;height:420px}.r-preview-panel{position:absolute;inset:0}</style>
    <nav id="tabs"></nav><div class="stage"><div class="r-preview-panel" data-panel="photos"><button id="upload">Upload</button><p id="grid">Photos</p></div></div>`);
  await page.evaluate(({store,settings})=>{
    window.saved=store;
    window.Portal={cfg:{},util:{injectCSS(id,css){if(document.getElementById(id))return;const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}},currentUser:{identity:{preferences:JSON.parse(JSON.stringify(store))}}};
    window.PlatformAPI={appFlags:{projectTabs:()=>settings},preferences:{get:async()=>({preferences:window.saved}),patch:async(patch)=>{Object.assign(window.saved,patch);return {preferences:window.saved};}}};
  },{store,settings});
  for(const source of [sources.promos,sources.viewer,sources.tutorial,sources.guides,sources.terminology])await page.addScriptTag({content:source});
  await page.evaluate(({tutorial})=>{
    if(tutorial)window.FirstMateTabGuides.registerTutorial({id:'project.photos.basics',tab:'project.photos',steps:[
      {target:'#upload',title:'Add photos',text:'Upload <b>here</b>.'},
      {target:'#missing',title:'Never shown',text:'Its target is not on the page.'},
      {target:'#grid',title:'Your photos',text:'They show up here.',placement:'top'}
    ]});
    const apps=[{appId:'project.map',id:'map',label:'Overview'},{appId:'project.materials',id:'materials',terminologyKey:'scope.project_tab',label:'Scope'},{appId:'project.photos',id:'photos',label:'Photos',icon:'fa-images'},{appId:'project.docs',id:'docs',label:'Docs'},{appId:'project.money',id:'money',label:'Money'}];
    window.render=(iconOnly=false)=>{
      const tabs=window.FirstMateTabGuides.order(apps).map(app=>{const pill=window.FirstMateTabGuides.pill(app.appId);return {...app,label:window.PlatformTerminology.appLabel(app,app.label),badge:pill?.label||'',badgeKind:pill?.kind||''};});
      window.Portal.ProjectViewer.renderTabs(document.getElementById('tabs'),tabs,{tabClass:'r-tab',iconOnly,onTabClick:tab=>window.openTab(tab)});
    };
    window.openTab=tab=>{if(window.FirstMateTabGuides.opened({appId:tab.appId,tabId:tab.id,container:document.querySelector('.stage'),delay:50}))window.render();};
    window.render();
  },{tutorial});
  const state=()=>page.evaluate(()=>[...document.querySelectorAll('#tabs [data-tab]')].map(button=>({tab:button.dataset.tab,label:button.querySelector('.pv-tab-label')?.textContent||'',pill:button.querySelector('.pv-tab-badge')?.textContent||'',kind:[...button.querySelector('.pv-tab-badge')?.classList||[]].find(name=>name.startsWith('pv-tab-badge--'))||''})));
  return {page,errors,state};
}

test('tab pills, order, first-open tutorials and the renamed Project tab',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const store={};
    let {page,errors,state}=await load(browser,store);
    // Listed tabs first, in the listed order; the rest keep their own order after them.
    assert.deepEqual((await state()).map(tab=>tab.tab),['photos','map','materials','docs','money']);
    let tabs=Object.fromEntries((await state()).map(tab=>[tab.tab,tab]));
    assert.deepEqual([tabs.photos.pill,tabs.photos.kind],['New','pv-tab-badge--new']);
    assert.deepEqual([tabs.docs.pill,tabs.docs.kind],['Coming soon','pv-tab-badge--coming_soon']);
    assert.equal(tabs.map.pill,'');
    // Without the organization's terminology the Project tab keeps its name.
    assert.equal(tabs.materials.label,'Project');

    // Opening Photos clears its pill and plays its tutorial once; steps whose target is missing are skipped.
    await page.click('#tabs [data-tab="photos"]');
    assert.equal((await state()).find(tab=>tab.tab==='photos').pill,'');
    await page.waitForFunction(()=>window.saved.seen_tabs?.includes('project.photos'));
    await page.waitForSelector('.tut-tt');
    assert.equal(await page.locator('.tut-tt strong').textContent(),'Add photos');
    assert.match(await page.locator('.tut-tt').innerHTML(),/Upload &lt;b&gt;here&lt;\/b&gt;\./,'step text is text, not markup');
    assert.equal(await page.locator('.tut-tt').getAttribute('data-fmr-ignore'),'','the overlay is left out of session replays');
    assert.equal(await page.locator('svg.tut-svg').getAttribute('data-fmr-ignore'),'');
    assert.ok(Number(await page.locator('svg.tut-svg').evaluate(svg=>getComputedStyle(svg).zIndex))>2147483200,'above the project window');
    await page.click('.tut-next');
    await page.waitForFunction(()=>document.querySelector('.tut-tt strong')?.textContent==='Your photos',null,{timeout:4000});
    assert.equal(await page.locator('.tut-next').textContent(),'Done');
    await page.click('.tut-back');
    await page.waitForFunction(()=>document.querySelector('.tut-tt strong')?.textContent==='Add photos');
    await page.click('.tut-next');
    await page.waitForFunction(()=>document.querySelector('.tut-tt strong')?.textContent==='Your photos',null,{timeout:4000});
    await page.click('.tut-next');
    await page.waitForFunction(()=>!document.querySelector('.tut-tt') && !document.querySelector('svg.tut-svg'));
    await page.waitForFunction(()=>window.saved.seen_tutorials?.includes('project.photos.basics'));
    // Opening it again plays nothing; the help button replays it on request, and Escape closes it.
    await page.click('#tabs [data-tab="map"]');
    await page.click('#tabs [data-tab="photos"]');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.tut-tt').count(),0);
    assert.equal(await page.locator('.stage > .fm-tab-help').count(),1);
    await page.click('.stage > .fm-tab-help');
    await page.waitForSelector('.tut-tt');
    assert.equal(await page.locator('.tut-tt strong').textContent(),'Add photos');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('.tut-tt'));
    // A tab with no tutorial has no help button.
    await page.evaluate(()=>window.openTab({appId:'project.map',id:'map'}));
    assert.equal(await page.locator('.stage > .fm-tab-help').count(),0);
    assert.deepEqual(errors,[]);
    Object.assign(store,await page.evaluate(()=>window.saved));
    await page.close();

    // After a reload (the same person, from their saved preferences): New stays cleared, Coming soon stays, the tutorial does not replay.
    ({page,errors,state}=await load(browser,JSON.parse(JSON.stringify(store))));
    tabs=Object.fromEntries((await state()).map(tab=>[tab.tab,tab]));
    assert.equal(tabs.photos.pill,'');
    assert.equal(tabs.docs.pill,'Coming soon');
    await page.click('#tabs [data-tab="docs"]');
    assert.equal((await state()).find(tab=>tab.tab==='docs').pill,'Coming soon','Coming soon never clears');
    await page.click('#tabs [data-tab="photos"]');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.tut-tt').count(),0);
    assert.deepEqual(store.seen_tabs,['project.photos'],'only tabs with a New pill are remembered');
    // The organization's terminology renames the Project tab.
    await page.evaluate(()=>{window.PlatformTerminology.setConfig({mappings:{labels:{scope:{project_tab:'Materials'}}}},{silent:true});window.render();});
    assert.equal((await state()).find(tab=>tab.tab==='materials').label,'Materials');
    assert.deepEqual(errors,[]);
    await page.close();

    // A phone: a fresh person sees the pill inside its tab, with no page overflow; icon-only tabs keep the pill and drop the label.
    ({page,errors,state}=await load(browser,{},{width:375,tutorial:false}));
    const fits=await page.evaluate(()=>{const button=document.querySelector('#tabs [data-tab="photos"]'),pill=button.querySelector('.pv-tab-badge');const a=button.getBoundingClientRect(),b=pill.getBoundingClientRect();return {inside:b.left>=a.left && b.right<=a.right+0.5 && b.height<=a.height,overflow:document.documentElement.scrollWidth>window.innerWidth};});
    assert.deepEqual(fits,{inside:true,overflow:false});
    await page.evaluate(()=>window.render(true));
    const photos=(await state()).find(tab=>tab.tab==='photos');
    assert.deepEqual([photos.label,photos.pill,photos.kind],['','New','pv-tab-badge--new']);
    assert.deepEqual(errors,[]);
    await page.close();
  }finally{
    await browser.close();
  }
});

test('order leaves every tab in place without a setting, and a bad tutorial is refused',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<p></p>');
    await page.evaluate(()=>{window.Portal={util:{injectCSS(){}}};window.PlatformAPI={appFlags:{projectTabs:()=>({order:[],pills:{}})}};});
    await page.addScriptTag({content:sources.guides});
    assert.deepEqual(await page.evaluate(()=>window.FirstMateTabGuides.order([{appId:'b'},{appId:'a'},{appId:'c'}]).map(app=>app.appId)),['b','a','c']);
    assert.equal(await page.evaluate(()=>window.FirstMateTabGuides.pill('project.photos')),null);
    assert.match(await page.evaluate(()=>{try{window.FirstMateTabGuides.registerTutorial({id:'x',tab:'project.photos',steps:[]});return '';}catch(error){return error.message;}}),/at least one step/);
    // A tutorial can also be declared on the tab's own app entry.
    await page.evaluate(()=>{window.FirstMateEmbeddableApps={getApp:id=>id==='project.docs'?{tutorial:{id:'project.docs.tour',steps:[{target:'p',title:'Docs',text:'Here.'}]}}:null};});
    assert.deepEqual(await page.evaluate(()=>{const t=window.FirstMateTabGuides.tutorialFor('project.docs');return [t.id,t.tab,t.steps.length];}),['project.docs.tour','project.docs',1]);
    assert.equal(await page.evaluate(()=>window.FirstMateTabGuides.opened({appId:'project.docs'})),false,'no pill to clear');
  }finally{
    await browser.close();
  }
});
