// The project window's Customer Portal tab: one page with the customer link,
// the media and a narrow history column; explanations live in tooltips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries=new URL('../../libraries/',import.meta.url);
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';

const LIVE='https://portal.test/p/live-123';
const PREVIEW='https://portal.test/p/preview/prev-456';

const PHONE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function setup(browser,{width=1280,height=860,reducedMotion='no-preference',photos=3,activity=true,draft=false,runtime=false,caps=['scheduling.customer_rescheduling','customer_portal.guest_links'],cover='',satellite=false,topDownInList=false,savedSatellite=false,serverSatellite=false,phone=false}={}){
  const page=await browser.newPage({viewport:{width,height},reducedMotion,...(phone?{userAgent:PHONE_UA,isMobile:true,hasTouch:true}:{})});
  // The portal preview page, for the phone preview frame and the desktop new tab.
  await page.context().route('https://portal.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body><h1>Customer portal preview page</h1></body></html>'}));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const offsite=[];page.on('request',request=>{const url=new URL(request.url());if(!['data:','blob:'].includes(url.protocol)&&url.host!=='cp.test')offsite.push(request.url());});
  await page.route('http://cp.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
    if(pathname.includes('missing'))return route.fulfill({status:404,body:''});
    if(pathname.startsWith('/img/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#9ab"/></svg>'});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;font-family:Arial"><div id="stage" style="height:100vh"><div id="panel" style="height:100%"></div></div></body></html>'});
  });
  await page.goto('http://cp.test/');
  await page.evaluate(({LIVE,PREVIEW,photos,activity,draft,caps,cover,satellite,topDownInList,savedSatellite,serverSatellite})=>{
    const now=Date.now();
    window.calls=[];window.toasts=[];
    window.Portal={util:{},ui:{showToast:(...args)=>toasts.push(args)},modules:{},capabilities:{can:key=>caps.includes(key)}};
    const portal={
      live_url:LIVE,preview_url:PREVIEW,customer:{email:'pat@example.com'},
      shared_items:[{type:'media',item_id:'m1'}],
      settings:{sharing:{enabled:true}},
      guest_links:[
        {id:'g1',label:'For my sister',preset:'photos_only',status:'active',expires_at:new Date(now+7*864e5).toISOString(),url:'https://portal.test/p/pgl_abc',created_by:'customer'},
        {id:'g2',label:'Old link',preset:'full_view',status:'revoked'}
      ]
    };
    const events=activity?[
      {type:'customer_portal.viewed',created_at:new Date(now-5*60000).toISOString(),visitor_ip:'203.0.113.9',user_agent:'Mozilla/5.0 (iPhone) Safari/604.1',city:'Austin'},
      {type:'customer_portal.media_opened',media_id:'m1',created_at:new Date(now-4*60000).toISOString(),visitor_ip:'203.0.113.9'},
      {type:'customer_portal.viewed',created_at:new Date(now-2*864e5).toISOString(),visitor_ip:'198.51.100.4',portal_access_mode:'guest',portal_guest_link_id:'g1'}
    ]:[];
    const clone=value=>JSON.parse(JSON.stringify(value));
    window.portalRecord=portal;
    window.PlatformAPI={customerPortals:{
      ensure:async(...args)=>{calls.push(['ensure',...args]);return {portal:clone(portalRecord)};},
      activity:async(...args)=>{calls.push(['activity',...args]);return {events};},
      update:async(org,project,body)=>{calls.push(['update',org,project,body]);if(body.settings)portalRecord.settings=body.settings;return {portal:clone(portalRecord)};},
      shareMedia:async(org,project,ids)=>{calls.push(['shareMedia',ids]);if(window.holdShare)await new Promise(resolve=>window.releaseShare=resolve);portalRecord.shared_items=[...portalRecord.shared_items,...ids.map(item_id=>({type:'media',item_id}))];return {portal:clone(portalRecord)};},
      unshareMedia:async(org,project,ids)=>{calls.push(['unshareMedia',ids]);portalRecord.shared_items=portalRecord.shared_items.filter(item=>!ids.includes(item.item_id));return {portal:clone(portalRecord)};},
      revokeShare:async(org,project,id)=>{calls.push(['revokeShare',id]);portalRecord.guest_links=portalRecord.guest_links.map(link=>link.id===id?{...link,status:'revoked'}:link);return {ok:true};}
    }};
    // The cover as PlatformAPI.projectMedia resolves it: the chosen cover_photo, else the satellite image.
    const satellitePhoto={id:'top_down_thumbnail',designator:'top_down_thumbnail',is_top_down_thumbnail:true,src:'/img/sat-missing.svg',thumb:'/img/sat-missing.svg',label:'Top-down satellite'};
    window.PlatformAPI.projectMedia={
      primaryPhoto:(project)=>{
        const id=project.custom_field_values?.cover_photo?.media_id;
        if(id)return {...(project.photos.find(item=>item.id===id)||{}),media_id:id};
        return satellite?satellitePhoto:(project.photos[0]||null);
      },
      googleStaticMapPhoto:()=>({src:'/img/static-map.svg'}),
      savedSatellitePhoto:(list)=>(list||[]).find(item=>item.media_id&&item.metadata?.source==='satellite_top_down')||null,
      withSavedSatellite:(list,result)=>[...list,...(result.photos||[]).filter(item=>!list.some(own=>own.id===item.id))],
      ...(serverSatellite?{ensureSatelliteMedia:async(org,project)=>{calls.push(['ensureSatelliteMedia',org,project]);return {status:'saved',media_id:'sat',photos:[{id:'sat',media_id:'sat',label:'Top-down satellite',thumb:'/img/sat.svg',metadata:{source:'satellite_top_down'}}],custom_field_values:{cover_photo:{media_id:'sat'}}};}}:{})
    };
    window.PlatformAPI.media={thumbnailUrl:(org,id)=>'/img/'+id+'-320.svg'};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{calls.push(['clipboard',text]);}}});
    window.mediaList=Array.from({length:photos},(_,index)=>({id:'m'+(index+1),label:'Photo '+(index+1),thumb:'/img/'+(index+1)+'.svg'}));
    if(topDownInList)mediaList.unshift({id:'top_down_thumbnail',is_top_down_thumbnail:true,thumb:'/img/sat.svg'});
    if(savedSatellite)mediaList.unshift({id:'sat',media_id:'sat',label:'Top-down satellite',thumb:'/img/sat.svg',metadata:{source:'satellite_top_down'}});
    window.cpHost={
      getProject:()=>({id:'p1',contacts:[{id:'c1',primary:true,name:'Pat',email:'pat@example.com'}]}),
      getPhotos:()=>mediaList,
      setPhotos:list=>{window.mediaList=list;},
      projectOrgId:()=>'org1',
      customerPortalEnabled:()=>true,
      customerPortalMediaEnabled:()=>true
    };
    window.currentProject=draft?{}:{id:'p1',contacts:[{id:'c1',primary:true,name:'Pat',email:'pat@example.com'}],custom_field_values:cover?{cover_photo:{media_id:cover}}:{}};
    window.cpHost.getProject=()=>window.currentProject;
    window.savedProject={id:'p1',contacts:[{id:'c1',primary:true,name:'Pat',email:'pat@example.com'}]};
    window.cpHost.ensureProject=async()=>{calls.push(['ensureProject']);await new Promise(resolve=>setTimeout(resolve,60));window.currentProject=window.savedProject;return window.currentProject;};
  },{LIVE,PREVIEW,photos,activity,draft,caps,cover,satellite,topDownInList,savedSatellite,serverSatellite});
  await page.addScriptTag({url:'/libraries/platform-qr/platform-qr.js'});
  if(runtime)await page.addScriptTag({url:'/libraries/app-runtime/firstmate-embeddable-apps.js'});
  await page.addScriptTag({url:'/libraries/apps/customer-portal/project.js'});
  await page.evaluate(async()=>{
    const app=Portal.modules.customerPortalProject;
    const panel=document.getElementById('panel');
    panel.innerHTML='<div class="cpo-panel" id="rCustomerPortalPanel"></div>';
    app.mount({panelRoot:panel,host:cpHost,projectWorkspace:cpHost});
    await app.load({silent:true});
  });
  page.offsite=offsite;
  const root=page.locator('#rCustomerPortalPanel');
  if(!draft&&photos)await root.locator('[data-cpo-tile]').first().waitFor().catch(()=>{});
  return {page,errors,root};
}

async function withBrowser(fn){
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{await fn(browser);}finally{await browser.close();}
}

test('a draft project shows the whole tab, empty, and opening or reading it creates nothing',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{draft:true,runtime:true,photos:0});
  // The tab is offered before the project is saved, like the other tabs.
  const offered=await page.evaluate(()=>window.FirstMateEmbeddableApps.listApps({surface:'project_modal',entityType:'project',customerPortalEnabled:true,activeProject:null}).map(app=>app.id));
  assert.ok(offered.includes('project.customer_portal'),offered.join(','));
  await page.evaluate(()=>Portal.modules.customerPortalProject.activate({}));
  assert.doesNotMatch(await root.innerText(),/once this project is saved/);
  assert.equal(await root.locator('[data-app-header] .cpo-title strong').innerText(),'Customer Portal');
  const preview=root.locator('[data-cpo-preview]');
  assert.equal(await preview.getAttribute('aria-disabled'),'true');
  assert.equal(await preview.getAttribute('href'),null);
  assert.match(await preview.getAttribute('data-fm-tooltip'),/Generate the customer link first/);
  assert.match(await root.locator('[data-cpo-no-link]').innerText(),/No link yet/);
  assert.equal(await root.locator('[data-cpo-link]').count(),0);
  assert.equal(await root.getByRole('button',{name:'Generate link'}).count(),1);
  assert.equal(await root.locator('[data-cpo-sharing]').isDisabled(),false,'switches are usable; they save the draft first');
  assert.equal(await root.locator('[data-cpo-media-empty]').count(),1);
  assert.equal(await root.locator('[data-cpo-history-empty]').count(),1);
  await preview.click({force:true});
  assert.deepEqual(await page.evaluate(()=>calls),[],'opening, reading and the disabled preview create no project and load nothing');
  assert.deepEqual(errors,[]);
}));

test('Generate link saves the draft once, then the tab adopts the project and shows its link',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{draft:true,photos:0});
  const generate=root.getByRole('button',{name:'Generate link'});
  await generate.click();
  await page.evaluate(()=>document.querySelector('[data-cpo-generate]')?.click());
  await root.locator('[data-cpo-link]').waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-cpo-link]')?.value);
  assert.equal(await root.locator('[data-cpo-link]').inputValue(),LIVE);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call[0]==='ensureProject').length),1,'saved once');
  assert.deepEqual(await page.evaluate(()=>calls.find(call=>call[0]==='ensure').slice(1,3)),['org1','p1']);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call[0]==='ensure').length),1);
  assert.equal(await root.locator('[data-cpo-preview]').getAttribute('href'),PREVIEW);
  assert.equal(await root.locator('[data-cpo-preview]').getAttribute('aria-disabled'),null);
  assert.equal(await root.locator('[data-cpo-generate]').count(),0);
  assert.deepEqual(errors,[]);
}));

test('sharing media or a switch on a draft saves it first, then does the write',()=>withBrowser(async browser=>{
  {
    const {page,errors,root}=await setup(browser,{draft:true,photos:2});
    await root.locator('[data-cpo-tile="m2"]').click();
    await root.locator('[data-cpo-share]').click();
    await page.waitForFunction(()=>calls.some(call=>call[0]==='shareMedia'));
    const order=await page.evaluate(()=>calls.map(call=>call[0]).filter(name=>name!=='activity'));
    assert.deepEqual(order,['ensureProject','ensure','shareMedia']);
    assert.deepEqual(await page.evaluate(()=>calls.find(call=>call[0]==='shareMedia')[1]),['m2']);
    await page.waitForFunction(()=>document.querySelector('[data-cpo-tile="m2"]')?.classList.contains('is-shared'));
    assert.deepEqual(errors,[]);
  }
  {
    // Without a window-provided ensureProject the tab uses the project window's tray path.
    const {page,errors,root}=await setup(browser,{draft:true,photos:0});
    await page.evaluate(()=>{
      delete cpHost.ensureProject;
      window.ensureDraftBaseProject=()=>{calls.push(['ensureDraftBaseProject']);window.currentProject=window.savedProject;return window.currentProject;};
      Portal.ProjectStore={saveRemote:async project=>{calls.push(['saveRemote',project.id]);return project;}};
    });
    await root.locator('label.cpo-switch').first().click();
    await page.waitForFunction(()=>calls.some(call=>call[0]==='update'));
    assert.deepEqual(await page.evaluate(()=>calls.map(call=>call[0]).filter(name=>name!=='activity')),['ensureDraftBaseProject','saveRemote','ensure','update']);
    assert.deepEqual(errors,[]);
  }
}));

test('header is the coloured icon then the title, with no subtitle, sub-tabs or preview-link card',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser);
  const head=root.locator('[data-app-header]');
  assert.equal(await head.locator('.cpo-title > i.fas.fa-link').count(),1);
  assert.equal((await head.locator('.cpo-title strong').textContent()).trim(),'Customer Portal');
  const order=await head.locator('.cpo-title').evaluate(node=>[...node.children].map(child=>child.tagName));
  assert.deepEqual(order,['I','STRONG']);
  const iconBg=await head.locator('.cpo-title > i').evaluate(node=>getComputedStyle(node).backgroundColor);
  assert.notEqual(iconBg,'rgba(0, 0, 0, 0)');
  const text=await root.innerText();
  assert.doesNotMatch(text,/Share only the/);
  assert.doesNotMatch(text,/Preview link/);
  assert.equal(await root.locator('p').count(),0,'no exposed paragraph copy');
  assert.equal(await root.locator('[data-cp-subtab],nav,[role="tablist"]').count(),0,'no sub-tabs');
  assert.ok(await head.locator('.cpo-title > i').getAttribute('data-fm-tooltip'));
  assert.deepEqual(errors,[]);
}));

test('customer link shows the link with Copy, Email and Download QR, and a preview button for what the customer sees',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser);
  const field=root.locator('[data-cpo-link]');
  assert.equal(await field.inputValue(),LIVE);
  assert.equal(await field.getAttribute('readonly'),'');
  assert.notEqual(await field.getAttribute('data-fmr-mask'),null,'the private link is masked in session replay');
  const preview=root.getByRole('link',{name:'Preview customer portal'});
  assert.equal(await root.locator('[data-app-header] [data-cpo-preview]').count(),1,'preview sits in the header row');
  assert.equal(await root.locator('[data-cpo-link-card] [data-cpo-preview]').count(),0);
  const headBox=await root.locator('[data-app-header]').boundingBox(),previewBox=await preview.boundingBox();
  assert.ok(previewBox.x+previewBox.width>headBox.x+headBox.width-4,'preview is at the right of the header');
  assert.equal(await preview.getAttribute('href'),PREVIEW);
  // Label, link, Copy, Email and Download QR share one row; the switches are the second.
  const rowTops=await root.locator('[data-cpo-link-card]').evaluate(card=>['.cpo-label','[data-cpo-link]','[data-cpo-copy]','[data-cpo-email]','[data-cpo-qr]'].map(sel=>{const r=card.querySelector(sel).getBoundingClientRect();return Math.round(r.top+r.height/2);}));
  assert.ok(Math.max(...rowTops)-Math.min(...rowTops)<=2,'one row: '+rowTops.join(','));
  const cardHeight=(await root.locator('[data-cpo-link-card]').boundingBox()).height;
  assert.ok(cardHeight<=118,`about two rows (${cardHeight}px)`);
  assert.equal(await field.evaluate(node=>getComputedStyle(node).textOverflow),'ellipsis');
  assert.equal(await preview.getAttribute('target'),'_blank');
  assert.match(await preview.getAttribute('data-fm-tooltip'),/cannot|Nothing can be signed/);
  const email=root.getByRole('link',{name:'Email'});
  const href=await email.getAttribute('href');
  assert.ok(href.startsWith('mailto:pat%40example.com?'),href);
  assert.ok(decodeURIComponent(href).includes(LIVE));
  assert.match(await email.getAttribute('data-fm-tooltip'),/Nothing is sent/);
  await root.getByRole('button',{name:'Copy',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call[0]==='clipboard')),[['clipboard',LIVE]]);
  await page.waitForFunction(()=>document.querySelector('[data-cpo-copy]').classList.contains('is-done'));
  assert.equal(await root.getByRole('button',{name:'Download QR'}).count(),1);
  // Nothing was sent: only the reads the tab makes and the clipboard write.
  assert.deepEqual(await page.evaluate(()=>[...new Set(calls.map(call=>call[0]))].sort()),['activity','clipboard','ensure']);
  assert.deepEqual(errors,[]);
}));

test('media is visible without tabs; selecting and sharing updates tiles in place',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser);
  const tiles=root.locator('[data-cpo-tile]');
  assert.equal(await tiles.count(),3);
  assert.ok(await tiles.nth(0).isVisible());
  assert.equal(await root.locator('.cpo-tile.is-shared').count(),1);
  assert.match(await root.locator('[data-cpo-media-count]').textContent(),/1 of 3 shared/);
  const selbar=root.locator('[data-cpo-selbar]');
  assert.equal(await selbar.evaluate(node=>node.classList.contains('is-open')),false);
  const second=tiles.nth(1);
  await page.evaluate(()=>{window.tileBefore=document.querySelector('[data-cpo-tile="m2"]');});
  await second.click();await tiles.nth(2).click();
  assert.equal(await second.getAttribute('aria-pressed'),'true');
  assert.equal(await selbar.evaluate(node=>node.classList.contains('is-open')),true);
  assert.equal((await root.locator('[data-cpo-share-label]').textContent()).trim(),'Share 2');
  assert.equal(await root.locator('[data-cpo-unshare]').isDisabled(),true);
  await page.evaluate(()=>{window.holdShare=true;});
  await root.locator('[data-cpo-share]').click();
  await page.waitForFunction(()=>document.querySelector('[data-cpo-tile="m2"]').classList.contains('is-pending'));
  await page.evaluate(()=>releaseShare());
  await page.waitForFunction(()=>document.querySelectorAll('.cpo-tile.is-shared').length===3);
  assert.deepEqual(await page.evaluate(()=>calls.find(call=>call[0]==='shareMedia')),['shareMedia',['m2','m3']]);
  assert.equal(await page.evaluate(()=>document.querySelector('[data-cpo-tile="m2"]')===tileBefore),true,'tile kept, so the change animates');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-cpo-tile="m2"]').disabled),false);
  assert.equal(await selbar.evaluate(node=>node.classList.contains('is-open')),false);
  assert.match(await root.locator('[data-cpo-media-count]').textContent(),/3 of 3 shared/);
  await root.locator('[data-cpo-filter="unshared"]').click();
  assert.equal(await tiles.nth(0).isVisible(),false);
  await root.locator('[data-cpo-filter="all"]').click();
  await tiles.nth(0).click();await root.locator('[data-cpo-unshare]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.cpo-tile.is-shared').length===2);
  assert.deepEqual(await page.evaluate(()=>calls.find(call=>call[0]==='unshareMedia')),['unshareMedia',['m1']]);
  assert.deepEqual(errors,[]);
}));

test('history is a narrow right column on desktop and stacks below on a phone',()=>withBrowser(async browser=>{
  {
    const {errors,root}=await setup(browser);
    const main=await root.locator('.cpo-main').boundingBox();
    const history=await root.locator('[data-cpo-history]').boundingBox();
    assert.ok(history.x>main.x+main.width-1,'history sits to the right');
    assert.ok(history.width<=320&&history.width<main.width/2,`narrow column (${history.width}px)`);
    assert.equal(await root.locator('[data-cpo-event]').count(),3);
    assert.match(await root.locator('[data-cpo-history]').innerText(),/Opened the portal/);
    assert.equal(await root.locator('.cpo-tag').count(),1,'guest visit is marked');
    assert.match(await root.locator('[data-cpo-event]').first().getAttribute('data-fm-tooltip'),/203\.0\.113\.9/);
    assert.deepEqual(errors,[]);
  }
  {
    const {page,errors,root}=await setup(browser,{width:390,height:844});
    const main=await root.locator('.cpo-main').boundingBox();
    const history=await root.locator('[data-cpo-history]').boundingBox();
    assert.ok(history.y>=main.y+main.height-1,'history stacks below');
    const overflow=await page.evaluate(()=>{const panel=document.getElementById('rCustomerPortalPanel');return panel.scrollWidth-panel.clientWidth;});
    assert.ok(overflow<=0,`no sideways scroll (${overflow}px)`);
    const field=await root.locator('[data-cpo-link]').boundingBox();
    const copy=await root.locator('[data-cpo-copy]').boundingBox();
    assert.ok(field.width>150,`link field stays readable on a phone (${field.width}px)`);
    assert.ok(copy.y>=field.y+field.height-1,'actions wrap below the link on a phone');
    const preview=await root.locator('[data-cpo-preview]').boundingBox();
    assert.ok(preview.x+preview.width<=390,'header action fits the phone width');
    assert.deepEqual(errors,[]);
  }
  {
    const {root}=await setup(browser,{activity:false});
    assert.equal(await root.locator('[data-cpo-history-empty]').count(),1);
  }
}));

test('every control explains itself in a tooltip',()=>withBrowser(async browser=>{
  const {root}=await setup(browser);
  const missing=await root.evaluate(node=>[...node.querySelectorAll('button,a,label.cpo-switch,.cpo-stat')]
    .filter(el=>!String(el.getAttribute('data-fm-tooltip')||'').trim())
    .map(el=>el.outerHTML.slice(0,90)));
  assert.deepEqual(missing,[]);
  for(const selector of ['[data-cpo-preview]','[data-cpo-copy]','[data-cpo-email]','[data-cpo-qr]','[data-cpo-refresh]','[data-cpo-select-all]','[data-cpo-share]','[data-cpo-unshare]']){
    assert.ok((await root.locator(selector).getAttribute('data-fm-tooltip')).length>10,selector);
  }
  assert.match(await root.locator('label.cpo-switch').first().getAttribute('data-fm-tooltip'),/read-only/);
}));

test('guest links stay reachable: toggle, list, copy and revoke',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser);
  const sharing=root.locator('[data-cpo-sharing]');
  assert.equal(await sharing.isChecked(),true);
  const toggle=root.locator('[data-cpo-guests-toggle]');
  assert.match(await toggle.textContent(),/1 active/);
  assert.equal(await root.locator('[data-cpo-guests]').evaluate(node=>node.classList.contains('is-open')),false);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  await root.locator('[data-cpo-guest-copy="g1"]').click();
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call[0]==='clipboard').pop()),['clipboard','https://portal.test/p/pgl_abc']);
  page.once('dialog',dialog=>dialog.accept());
  await root.locator('[data-cpo-revoke="g1"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-cpo-guest="g1"]'));
  assert.deepEqual(await page.evaluate(()=>calls.find(call=>call[0]==='revokeShare')),['revokeShare','g1']);
  await root.locator('label.cpo-switch').first().click();
  await page.waitForFunction(()=>calls.some(call=>call[0]==='update'));
  assert.deepEqual(await page.evaluate(()=>calls.find(call=>call[0]==='update')[3]),{settings:{sharing:{enabled:false}}});
  await page.waitForFunction(()=>!document.querySelector('[data-cpo-sharing]').checked);
  await root.locator('label.cpo-switch').nth(1).click();
  await page.waitForFunction(()=>calls.filter(call=>call[0]==='update').length===2);
  assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call[0]==='update')[1][3].settings.scheduling),{enabled:true,reschedule:true});
  assert.deepEqual(errors,[]);
}));

test('state changes animate, and reduced motion turns the motion off',()=>withBrowser(async browser=>{
  {
    const {root}=await setup(browser);
    const duration=await root.locator('[data-cpo-selbar]').evaluate(node=>getComputedStyle(node).transitionDuration);
    assert.notEqual(duration,'0s');
  }
  {
    const {root}=await setup(browser,{reducedMotion:'reduce'});
    const durations=await root.evaluate(node=>['[data-cpo-selbar]','.cpo-tile','.cpo-badge','.cpo-track'].map(sel=>getComputedStyle(node.querySelector(sel)).transitionDuration));
    assert.ok(durations.every(value=>value.split(',').every(part=>parseFloat(part)===0)),durations.join(' | '));
    assert.equal(await root.locator('.cpo-enter').count(),0);
  }
}));

test('media is left out when the organization has portal media off',()=>withBrowser(async browser=>{
  const page=(await setup(browser)).page;
  await page.evaluate(()=>{cpHost.customerPortalMediaEnabled=()=>false;Portal.modules.customerPortalProject.render();});
  assert.equal(await page.locator('[data-cpo-media]').isHidden(),true);
  assert.equal(await page.locator('[data-cpo-link]').inputValue(),LIVE);
}));

test('customer rescheduling shows only when its capability is on',()=>withBrowser(async browser=>{
  {
    const {page,errors,root}=await setup(browser,{caps:['customer_portal.guest_links']});
    assert.equal(await root.locator('[data-cpo-rescheduling]').count(),0,'no switch without scheduling.customer_rescheduling');
    assert.equal(await root.locator('[data-cpo-sharing]').count(),1);
    // Turning the capability on shows it without a reload.
    await page.evaluate(()=>{Portal.capabilities.can=key=>key==='scheduling.customer_rescheduling';window.dispatchEvent(new CustomEvent('fm:capabilities:updated'));});
    await root.locator('[data-cpo-rescheduling]').waitFor({state:'attached'});
    assert.deepEqual(errors,[]);
  }
  {
    // Capabilities not loaded yet: fail closed.
    const {root}=await setup(browser,{caps:[]});
    assert.equal(await root.locator('[data-cpo-resched-switch]').count(),0);
  }
}));

test('the guest link switch shows only when its capability is on, and follows it without a reload; existing guest links stay listed',()=>withBrowser(async browser=>{
  {
    const {page,errors,root}=await setup(browser,{caps:['scheduling.customer_rescheduling']});
    assert.equal(await root.locator('[data-cpo-guest-switch],[data-cpo-sharing]').count(),0,'no switch without customer_portal.guest_links');
    assert.match(await root.locator('[data-cpo-guests-toggle]').textContent(),/1 active/,'a link that already exists is still counted');
    assert.equal(await root.locator('[data-cpo-guests] [data-cpo-guest]').count(),1,'and listed');
    assert.equal(await root.locator('[data-cpo-guest] [data-cpo-revoke]').count(),1,'so it can still be revoked');
    assert.equal(await root.locator('[data-cpo-rescheduling]').count(),1,'the other switch stays');
    await page.evaluate(()=>{Portal.capabilities.can=key=>['scheduling.customer_rescheduling','customer_portal.guest_links'].includes(key);window.dispatchEvent(new CustomEvent('fm:capabilities:updated'));});
    await root.locator('[data-cpo-sharing]').waitFor({state:'attached'});
    assert.match(await root.locator('[data-cpo-guests-toggle]').textContent(),/1 active/);
    await page.evaluate(()=>{Portal.capabilities.can=key=>key==='scheduling.customer_rescheduling';window.dispatchEvent(new CustomEvent('fm:capabilities:updated'));});
    await page.waitForFunction(()=>!document.querySelector('[data-cpo-sharing]'));
    assert.equal(await root.locator('[data-cpo-guests-toggle]').count(),1,'turning the feature off hides only the switch');
    assert.equal(await root.locator('[data-cpo-guests] [data-cpo-guest]').count(),1);
    assert.deepEqual(errors,[]);
  }
  {
    const {root}=await setup(browser);
    assert.equal(await root.locator('[data-cpo-sharing]').count(),1,'on: the switch, the pill and the list are there');
    assert.equal(await root.locator('[data-cpo-guests-toggle]').count(),1);
  }
}));

test('there is no cover row: a project with only the generated satellite image is empty, and it is never a tile',()=>withBrowser(async browser=>{
  {
    const {root,errors}=await setup(browser,{photos:0,satellite:true});
    assert.equal(await root.locator('[data-cpo-cover]').count(),0,'no cover row');
    assert.equal(await root.locator('[data-cpo-media-empty]').count(),1,'empty only because there is no media');
    assert.deepEqual(errors,[]);
  }
  {
    const {root}=await setup(browser,{photos:2,satellite:true,topDownInList:true});
    assert.deepEqual(await root.locator('[data-cpo-tile]').evaluateAll(nodes=>nodes.map(node=>node.dataset.cpoTile)),['m1','m2']);
    assert.match(await root.locator('[data-cpo-media-count]').innerText(),/1 of 2 shared/);
    assert.equal(await root.locator('[data-cpo-cover]').count(),0);
  }
}));

test('the saved satellite photo is a normal tile with the Cover pill, shared or hidden like any other',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{photos:2,savedSatellite:true});
  assert.equal(await root.locator('[data-cpo-cover]').count(),0,'no cover row');
  assert.deepEqual(await root.locator('[data-cpo-tile]').evaluateAll(nodes=>nodes.map(node=>node.dataset.cpoTile)),['sat','m1','m2']);
  assert.equal(await root.locator('[data-cpo-tile="sat"] [data-cpo-tile-cover]').innerText(),'Cover');
  assert.equal(await root.locator('[data-cpo-tile-cover]').count(),1);
  assert.match(await root.locator('[data-cpo-media-count]').innerText(),/1 of 3 shared/);
  assert.equal(await root.locator('[data-cpo-tile="sat"]').evaluate(node=>node.classList.contains('is-shared')),false);
  await root.locator('[data-cpo-tile="sat"]').click();
  await root.locator('[data-cpo-share]').click();
  await page.waitForFunction(()=>document.querySelector('[data-cpo-tile="sat"]').classList.contains('is-shared'));
  assert.deepEqual(await page.evaluate(()=>calls.find(call=>call[0]==='shareMedia')),['shareMedia',['sat']]);
  await root.locator('[data-cpo-tile="sat"]').click();
  await root.locator('[data-cpo-unshare]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-cpo-tile="sat"]').classList.contains('is-shared'));
  assert.deepEqual(errors,[]);
}));

test('a chosen cover is a normal tile marked Cover; the satellite photo then has no pill',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{photos:3,cover:'m2',savedSatellite:true});
  assert.equal(await root.locator('[data-cpo-cover]').count(),0);
  assert.equal(await root.locator('[data-cpo-tile="m2"] [data-cpo-tile-cover]').count(),1);
  assert.equal(await root.locator('[data-cpo-tile-cover]').count(),1);
  await root.locator('[data-cpo-tile="m2"]').click();
  await root.locator('[data-cpo-share]').click();
  await page.waitForFunction(()=>document.querySelector('[data-cpo-tile="m2"]').classList.contains('is-shared'));
  assert.deepEqual(errors,[]);
}));

test('opening the tab saves the satellite photo once and lists it as a tile',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{photos:1,serverSatellite:true});
  await page.evaluate(()=>Portal.modules.customerPortalProject.activate({}));
  await root.locator('[data-cpo-tile="sat"]').waitFor();
  assert.equal(await root.locator('[data-cpo-tile="sat"] [data-cpo-tile-cover]').count(),1,'the server named it the cover');
  await page.evaluate(()=>Portal.modules.customerPortalProject.activate({}));
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call[0]==='ensureSatelliteMedia').length),1,'once it is in the library it is not asked for again');
  assert.deepEqual(errors,[]);
}));

test('Download QR makes the PNG in the page: no request leaves for another host',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser);
  const [download]=await Promise.all([page.waitForEvent('download'),root.locator('[data-cpo-qr]').click()]);
  assert.equal(download.suggestedFilename(),'customer-portal-qr.png');
  const file=await download.path();
  const bytes=await readFile(file);
  assert.deepEqual([...bytes.subarray(0,8)],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],'a PNG');
  await page.waitForFunction(()=>document.querySelector('[data-cpo-qr]').classList.contains('is-done'));
  assert.deepEqual(page.offsite,[],'nothing was fetched from another host');
  const source=await readFile(new URL('apps/customer-portal/project.js',libraries),'utf8');
  assert.doesNotMatch(source,/qrserver|chart\.googleapis|quickchart/i);
  // The code is the customer link: the same modules as the encoder the document widgets use.
  const matches=await page.evaluate(async LIVE=>{
    const code=window.PlatformQR.encode(LIVE);
    return code && code.size>=21 && code.modules[0].slice(0,7).every(Boolean) && code.modules[6].slice(0,7).every(Boolean);
  },LIVE);
  assert.equal(matches,true,'finder pattern in the corner');
  assert.deepEqual(errors,[]);
}));

test('on a phone, Preview opens the customer portal preview full screen in a frame, and X closes it',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{width:390,height:844,phone:true});
  const preview=root.locator('[data-cpo-preview]');
  assert.equal((await preview.innerText()).trim(),'Preview','the eye is labelled on a phone');
  const box=await preview.boundingBox();
  assert.ok(box.x+box.width<=390&&box.width>60,`labelled button fits the phone (${box.width}px)`);
  await preview.click();
  const modal=page.locator('[data-cpo-preview-modal]');
  await modal.waitFor();
  assert.equal(page.context().pages().length,1,'no new browser tab');
  assert.equal(await modal.getAttribute('role'),'dialog');
  assert.equal(await modal.getAttribute('aria-modal'),'true');
  const frame=modal.locator('iframe[data-cpo-preview-frame]');
  assert.equal(await frame.getAttribute('src'),PREVIEW,'the same preview address');
  await page.frameLocator('[data-cpo-preview-frame]').locator('h1').waitFor();
  assert.equal(await page.frameLocator('[data-cpo-preview-frame]').locator('h1').innerText(),'Customer portal preview page');
  await page.waitForFunction(()=>{const style=getComputedStyle(document.querySelector('[data-cpo-preview-modal]'));return style.opacity==='1'&&style.transform==='none';});
  const sheet=await modal.boundingBox();
  assert.deepEqual([sheet.x,sheet.y,sheet.width,sheet.height],[0,0,390,844],'full screen');
  const frameBox=await frame.boundingBox();
  assert.ok(frameBox.height>700&&frameBox.width===390,`the preview fills the sheet (${frameBox.width}x${frameBox.height})`);
  assert.notEqual(await modal.evaluate(node=>getComputedStyle(node).transitionDuration),'0s','it animates');
  const close=modal.locator('[data-cpo-preview-close]');
  assert.equal(await close.getAttribute('aria-label'),'Close preview');
  assert.equal(await close.evaluate(node=>node===document.activeElement),true,'focus moves to X');
  const closeBox=await close.boundingBox();
  assert.ok(closeBox.x+closeBox.width>=380&&closeBox.y<=12&&closeBox.width>=40,'X in the top right corner, a full touch target');
  await close.click();
  assert.equal(await modal.evaluate(node=>node.classList.contains('is-open')),false,'animates out');
  await modal.waitFor({state:'detached'});
  assert.equal(await preview.evaluate(node=>node===document.activeElement),true,'focus returns to Preview');
  // Escape closes it too, and it opens again.
  await preview.click();
  await modal.waitFor();
  await page.keyboard.press('Escape');
  await modal.waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>[...new Set(calls.map(call=>call[0]))].sort()),['activity','ensure'],'previewing writes nothing');
  assert.deepEqual(errors,[]);
}));

test('on a computer, Preview is labelled and still opens a new tab',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{width:1600,height:1000});
  const preview=root.locator('[data-cpo-preview]');
  assert.equal((await preview.innerText()).trim(),'Preview');
  assert.equal(await preview.getAttribute('aria-label'),'Preview customer portal');
  assert.equal(await preview.getAttribute('target'),'_blank');
  const [popup]=await Promise.all([page.waitForEvent('popup'),preview.click()]);
  assert.equal(popup.url(),PREVIEW);
  assert.equal(await page.locator('[data-cpo-preview-modal]').count(),0,'no sheet on a computer');
  assert.deepEqual(errors,[]);
}));

test('with both portal options off and no guest links there is no empty options row',()=>withBrowser(async browser=>{
  const {page,errors,root}=await setup(browser,{caps:[]});
  await page.evaluate(async()=>{portalRecord.guest_links=[];await Portal.modules.customerPortalProject.load({silent:true});});
  await page.waitForFunction(()=>!document.querySelector('[data-cpo-guests-toggle]'));
  assert.equal(await root.locator('.cpo-options').count(),0);
  assert.equal(await root.locator('[data-cpo-link]').inputValue(),LIVE);
  assert.deepEqual(errors,[]);
}));