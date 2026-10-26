import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// The project window on a phone (390x844, a mobile user agent): the header tabs use the full width with the trays
// behind one control, the Photos grid is dense, a photo opens full screen with its details in a bottom sheet, and
// the camera bar expands into a live camera (Chrome's fake camera) whose shots upload and line up above the shutter.
// Each test also checks the desktop layout is the one it was.
const libraries=new URL('../../libraries/',import.meta.url);
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PHONE={viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,userAgent:UA};
const DESKTOP={viewport:{width:1600,height:1000}};
const svg=(hue)=>`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="hsl(${hue},28%,62%)"/><path d="M0 330L160 190L300 300L420 220L600 340V450H0Z" fill="hsl(${hue},30%,40%)"/></svg>`;
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
async function pageFor(browser,options,html){
  const context=await browser.newContext(options);
  await context.grantPermissions(['camera'],{origin:'http://localhost:4817'}).catch(()=>{});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:4817/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
    if(pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:svg(Number(pathname.match(/\d+/)?.[0]||0)*29%360)});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif;--primary:#16a34a}</style>${html}`});
  });
  await page.goto('http://localhost:4817/');
  await page.evaluate(()=>{
    const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.__APP={userOrgId:'org',userId:'sam'};
    window.Portal={can:()=>true,cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(id,css){let el=document.getElementById('css_'+id);if(!el){el=document.createElement('style');el.id='css_'+id;document.head.append(el);}el.textContent=css;}},ui:{showToast(){}}};
    window.PlatformAPI={media:{fileUrl:(org,id)=>'/media/'+id+'.svg',thumbnailUrl:(org,id)=>'/media/'+id+'.svg',getMarkup:async()=>({layer:{data:{items:[]}}})}};
  });
  return {context,page,errors};
}
const rect=(page,selector)=>page.locator(selector).first().evaluate(el=>{const b=el.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)};});

// The window header markup the project window uses, laid out by window-shell with project-trays.
const headerHtml=`<div class="r-overlay project-layout-prototype"><div class="r-win fm-window fm-entity-window" id="win" style="position:fixed;inset:0;display:flex;flex-direction:column">
  <div class="r-modal-header r-window-bar fm-shell-header" data-header-rows="2" id="head"><div class="r-window-identity fm-shell-identity"><i class="fas fa-folder-open"></i><span>2205 Mimosa Pl, Wilmington, NC 28403, USA</span></div>
  <div class="r-tabbar fm-shell-tabs" data-tab-style="underline">${['Overview','Reports','Photos','Docs','Materials','Portal'].map((t,i)=>`<button class="r-tab" data-tab="t${i}" aria-selected="${i===2}"><i class="fas fa-image"></i></button>`).join('')}</div>
  <div class="modal-shell-actions"></div><div class="r-window-bar-actions"><div class="fm-window-controls"><button data-window-action="close" aria-label="Close">x</button></div></div></div>
  <div id="shell" style="flex:1;display:flex;min-height:0"><div class="r-preview" style="flex:1">content</div></div></div></div>`;
async function mountHeader(page,mobile){
  await page.evaluate(m=>{for(const n of [document.querySelector('#win'),document.querySelector('#head')])n.dataset.windowMobile=String(m);},mobile);
  for(const file of ['window-manager/window-shell.js','project-trays/project-trays.js'])await page.addScriptTag({url:'/libraries/'+file});
  await page.evaluate(()=>{FirstMateWindowShell.ensureStyles();window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{orgId:'org',header:document.querySelector('#head'),getProject:()=>({id:'project'})});});
}

test('phone header: full-width tabs, one tray control with a menu; desktop keeps the tray icons in the tab row',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await pageFor(browser,PHONE,headerHtml);
    await mountHeader(page,true);
    const tabs=await page.locator('.fm-shell-tabs > button').evaluateAll(n=>n.map(b=>Math.round(b.getBoundingClientRect().width)));
    assert.equal(Math.round((await rect(page,'.fm-shell-tabs')).width),390,'the tab row spans the screen');
    assert.ok(tabs.every(w=>w===tabs[0]&&w>=60),'six equal tabs: '+tabs);
    assert.ok((await rect(page,'.fm-shell-identity')).height<=48,'a tight title row');
    const toggle=page.locator('.fm-project-tray-toggle');
    assert.equal(await toggle.isVisible(),true);
    const t=await rect(page,'.fm-project-tray-toggle');
    assert.ok(t.y<48,'the tray control is on the title row');
    assert.equal(await page.locator('.fm-project-tray-tabs').evaluate(n=>getComputedStyle(n).visibility),'hidden','trays are tucked away');
    await toggle.click();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.fm-project-tray-tabs')).visibility==='visible');
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    const labels=await page.locator('.fm-project-tray-tabs .fm-tray-label').allInnerTexts();
    for(const name of ['Notes','To Do','Activity','Agent'])assert.ok(labels.includes(name),'the menu names each tray: '+labels);
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false','Escape closes the menu only');
    assert.deepEqual(errors,[]);

    const desk=await pageFor(browser,DESKTOP,headerHtml);
    await mountHeader(desk.page,false);
    assert.equal(await desk.page.locator('.fm-project-tray-toggle').isVisible(),false,'no tray control on desktop');
    assert.equal(await desk.page.locator('.fm-project-tray-tabs [data-tray]').count(),5);
    for(const b of await desk.page.locator('.fm-project-tray-tabs [data-tray]').all()){assert.equal(await b.isVisible(),true);assert.equal((await b.boundingBox()).width,32,'icon buttons as before');}
    assert.equal(await desk.page.locator('.fm-tray-label').first().isVisible(),false,'labels stay hidden on desktop');
    assert.deepEqual(desk.errors,[]);
  }finally{await browser.close();}
});

const galleryHtml=`<div id="tab" style="position:absolute;inset:0;display:flex;flex-direction:column"><div id="rPhotoFeedMount" style="height:100%;min-height:0"></div></div>`;
async function mountGallery(page){
  await page.addScriptTag({url:'/libraries/apps/photos/feed.js'});
  await page.evaluate(()=>{
    const photos=Array.from({length:12},(_,i)=>({id:'p'+i,media_id:'p'+i,src:'/media/p'+i+'.svg',thumb:'/media/p'+i+'.svg',content_type:'image/svg+xml',label:'Roof '+(i+1),uploaded_at:'2026-10-25T15:00:00Z',uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera'}));
    Portal.PhotoFeed.mountProjectGallery(document.querySelector('#rPhotoFeedMount'),{project:{id:'proj',title:'12 Stage Street',photos},photos,title:'',uploadLabel:'Upload',mobileGrid:'dense',enableProjectLinks:false,projectLinkEnabled:false,routeScope:''});
  });
  await page.waitForSelector('#rPhotoFeedMount .pf-thumb');
}

test('phone Photos tab: three photos a row edge to edge, a one-line group header, long press selects; desktop unchanged',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await pageFor(browser,PHONE,galleryHtml);
    await mountGallery(page);
    const thumbs=await page.locator('.pf-thumb').evaluateAll(n=>n.slice(0,4).map(t=>{const b=t.getBoundingClientRect();return [Math.round(b.x),Math.round(b.y),Math.round(b.width)];}));
    assert.equal(thumbs[0][1],thumbs[2][1],'three on the first row');
    assert.ok(thumbs[3][1]>thumbs[0][1],'the fourth wraps');
    assert.ok(thumbs[0][0]<=1&&thumbs[2][0]+thumbs[2][2]>=388,'edge to edge: '+JSON.stringify(thumbs));
    assert.ok(thumbs[1][0]-(thumbs[0][0]+thumbs[0][2])<=3,'hairline gaps');
    const head=await rect(page,'.pf-group-head'),day=await rect(page,'.pf-day-heading');
    assert.equal(head.y,day.y,'the group line shares the day line');
    assert.ok(head.height<=40,'a slim header');
    assert.equal(await page.locator('.pf-group-head strong, .pf-group-head .pf-project-link').first().isVisible().catch(()=>false),false,'no repeated project title');
    const toolbar=await rect(page,'.pf-toolbar');
    assert.ok(toolbar.y<=1&&toolbar.height<=56,'the toolbar sits at the top, one line: '+JSON.stringify(toolbar));
    // Long press (touch) starts a selection and the floating dock.
    const box=await page.locator('.pf-thumb').first().boundingBox();
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
    await page.waitForTimeout(650);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForSelector('.pf-seldock.open');
    assert.equal(await page.locator('.pf-thumb.selected').count(),1);
    assert.ok((await rect(page,'.pf-seldock')).width<=390,'the dock fits the phone');
    assert.deepEqual(errors,[]);

    const desk=await pageFor(browser,DESKTOP,galleryHtml);
    await mountGallery(desk.page);
    const deskThumb=await rect(desk.page,'.pf-thumb');
    assert.ok(deskThumb.width>=150&&deskThumb.width<=220,'desktop tiles keep their size: '+deskThumb.width);
    assert.equal(await desk.page.locator('.pf-title').isVisible(),true);
    assert.equal(await desk.page.locator('.pf-group').evaluate(n=>getComputedStyle(n).display),'block','desktop keeps its group cards');
    assert.deepEqual(desk.errors,[]);
  }finally{await browser.close();}
});

async function openViewer(page){
  await page.addScriptTag({url:'/libraries/markup/firstmate-markup.js'});
  await page.evaluate(()=>{window.viewer=FirstMateMarkup.openPhotoViewer({photos:[0,1,2].map(i=>({media_id:'m'+i,url:'/media/'+i+'.svg',content_type:'image/svg+xml',label:'Roof '+(i+1)})),index:0,project:{title:'12 Stage Street'}});});
  await page.waitForSelector('.fm-photo-modal [data-photo-img]');
  await page.waitForFunction(()=>document.querySelector('[data-photo-img]').complete);
  await page.waitForTimeout(400);
}

test('phone photo viewer: full screen, swipe to the next photo, details in a bottom sheet; desktop keeps the side panel',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await pageFor(browser,PHONE,'<main id="mainPanels" style="position:fixed;inset:60px 0 0 0"></main>');
    await openViewer(page);
    assert.deepEqual(await rect(page,'.fm-photo-modal'),{x:0,y:0,width:390,height:844},'full screen');
    assert.ok((await rect(page,'.fm-photo-side')).y>=844,'details start tucked away below the screen');
    // Swipe left with touch.
    const stage=await rect(page,'.fm-photo-stage');
    const cdp=await page.context().newCDPSession(page);
    const y=stage.y+stage.height/2;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:320,y}]});
    for(const x of [280,220,160,100])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForFunction(()=>window.viewer.index===1);
    assert.equal(await page.locator('[data-photo-mobile-counter]').textContent(),'2 / 3');
    await page.locator('[data-photo-details]').click();
    await page.waitForFunction(()=>document.querySelector('.fm-photo-modal').classList.contains('sheet-open'));
    await page.waitForTimeout(400);
    const sheet=await rect(page,'.fm-photo-side');
    assert.ok(sheet.y>120&&sheet.y+sheet.height>=843&&sheet.width===390,'a bottom sheet: '+JSON.stringify(sheet));
    assert.equal(await page.locator('.fm-photo-meta').isVisible(),true,'the details are in the sheet');assert.ok((await rect(page,'.fm-photo-meta')).y>=186,'inside the sheet');
    await page.locator('[data-photo-sheet-close]').click();
    await page.waitForFunction(()=>!document.querySelector('.fm-photo-modal').classList.contains('sheet-open'));
    await page.locator('[data-photo-actions]').click();
    for(const name of ['data-photo-rename','data-photo-download-markup','data-photo-delete'])assert.equal(await page.locator(`[${name}]`).count(),1,name);
    assert.deepEqual(errors,[]);

    const desk=await pageFor(browser,DESKTOP,'<main id="mainPanels" style="position:fixed;inset:60px 0 0 0"></main>');
    await openViewer(desk.page);
    assert.equal(await desk.page.locator('.fm-photo-modal').evaluate(n=>n.classList.contains('is-mobile')),false);
    assert.deepEqual(await rect(desk.page,'.fm-photo-modal'),{x:0,y:60,width:1600,height:940},'bounded to the host as before');
    assert.equal((await rect(desk.page,'.fm-photo-side')).width,360,'the side panel stays');
    assert.equal(await desk.page.locator('[data-photo-details]').isVisible(),false);
    assert.deepEqual(desk.errors,[]);
  }finally{await browser.close();}
});

test('phone camera: the bar expands into a live camera, a shot adds a thumbnail and an upload, Back collapses it',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await pageFor(browser,PHONE,'<div id="host" style="position:fixed;inset:90px 0 0 0;background:#fff"></div>');
    await page.addScriptTag({url:'/libraries/camera-capture/camera-capture.js'});
    await page.evaluate(()=>{window.uploads=[];window.done=null;window.failNext=true;
      window.cam=FirstMateCamera.mount(document.querySelector('#host'),{upload:async file=>{window.uploads.push(file.name);if(window.failNext){window.failNext=false;throw new Error('offline');}return {ok:true};},onDone:entries=>{window.done=entries.map(e=>e.status);}});});
    const bar=await rect(page,'.fmc-bar');
    assert.ok(bar.height<=48&&bar.y+bar.height>=820,'a slim bar along the bottom: '+JSON.stringify(bar));
    await page.locator('.fmc-bar').click();
    await page.waitForSelector('.fmc-stage.live');
    await page.waitForTimeout(450);
    assert.deepEqual(await rect(page,'.fmc-shell'),{x:0,y:90,width:390,height:754},'the camera fills the tab under the header');
    assert.equal(await page.locator('.fmc-bar').isVisible(),false);
    await page.locator('[data-fmc-shutter]').click();
    await page.waitForSelector('.fmc-tile.failed');
    assert.equal(await page.evaluate(()=>window.uploads.length),1,'the shot went to the upload');
    await page.locator('.fmc-retry').click();
    await page.waitForSelector('.fmc-tile .fmc-ok');
    await page.locator('[data-fmc-shutter]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.fmc-tile .fmc-ok').length===2);
    const strip=await rect(page,'.fmc-strip'),shutter=await rect(page,'[data-fmc-shutter]');
    assert.ok(strip.y+strip.height<=shutter.y,'thumbnails line up above the shutter');
    assert.equal(await page.locator('.fmc-tile').count(),2);
    await page.locator('[data-fmc-back]').click();
    await page.waitForFunction(()=>window.done);
    assert.deepEqual(await page.evaluate(()=>window.done),['done','done']);
    await page.waitForFunction(()=>!document.querySelector('.fmc-shell').classList.contains('open'));
    assert.equal(await page.locator('.fmc-bar').isVisible(),true,'Back collapses it to the bar');
    assert.equal(await page.evaluate(()=>document.querySelector('.fmc-stage video').srcObject),null,'the camera is released');
    // The full-screen entry point takes a "what next" step after Done and resolves.
    await page.evaluate(()=>{window.session=FirstMateCamera.open({projectTitle:'12 Stage Street',next:async(entries,step)=>{step.setTitle('Add to a project');step.body.innerHTML='<button id="pick">Pick</button>';return new Promise(r=>step.body.querySelector('#pick').onclick=()=>r('project-1'));},onDone:(entries,choice)=>{window.choice=choice;}});});
    await page.waitForSelector('.fmc-shell.fullscreen .fmc-stage.live');
    assert.match(await page.locator('.fmc-shell.fullscreen .fmc-head-title').innerText(),/12 Stage Street/);
    await page.locator('.fmc-shell.fullscreen [data-fmc-shutter]').click();
    await page.locator('.fmc-shell.fullscreen [data-fmc-done]').click();
    await page.locator('#pick').click();
    assert.equal((await page.evaluate(()=>window.session.done)).length,1);
    assert.equal(await page.evaluate(()=>window.choice),'project-1');
    assert.equal(await page.locator('.fmc-shell.fullscreen').count(),0);
    assert.deepEqual(errors,[]);

    const desk=await pageFor(browser,DESKTOP,'<div id="host" style="position:fixed;inset:90px 0 0 0"></div>');
    await desk.page.addScriptTag({url:'/libraries/camera-capture/camera-capture.js'});
    await desk.page.evaluate(()=>FirstMateCamera.mount(document.querySelector('#host'),{}));
    assert.equal(await desk.page.locator('.fmc-bar').isVisible(),false,'no camera bar on desktop');
    assert.equal(await desk.page.locator('.fmc-shell').isVisible(),false);
  }finally{await browser.close();}
});

test('the camera falls back to choosing photos when the camera is refused',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await pageFor(browser,PHONE,'<div id="host" style="position:fixed;inset:90px 0 0 0"></div>');
    await page.addScriptTag({url:'/libraries/camera-capture/camera-capture.js'});
    await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');};window.cam=FirstMateCamera.mount(document.querySelector('#host'),{});});
    await page.locator('.fmc-bar').click();
    await page.waitForSelector('[data-fmc-pick]:not([hidden])');
    assert.match(await page.locator('[data-fmc-message]').innerText(),/Allow the camera/);
    assert.equal(await page.locator('[data-fmc-shutter]').isDisabled(),true);
    await page.locator('[data-fmc-input]').setInputFiles({name:'roof.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6b0AAAAASUVORK5CYII=','base64')});
    await page.waitForSelector('.fmc-tile');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
