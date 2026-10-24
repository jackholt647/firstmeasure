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

async function setup(browser,{width=1280,height=860,reducedMotion='no-preference',photos=3,activity=true}={}){
  const page=await browser.newPage({viewport:{width,height},reducedMotion});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://cp.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
    if(pathname.startsWith('/img/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#9ab"/></svg>'});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body style="margin:0;font-family:Arial"><div id="stage" style="height:100vh"><div id="panel" style="height:100%"></div></div></body></html>'});
  });
  await page.goto('http://cp.test/');
  await page.evaluate(({LIVE,PREVIEW,photos,activity})=>{
    const now=Date.now();
    window.calls=[];window.toasts=[];
    window.Portal={util:{},ui:{showToast:(...args)=>toasts.push(args)},modules:{}};
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
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{calls.push(['clipboard',text]);}}});
    window.mediaList=Array.from({length:photos},(_,index)=>({id:'m'+(index+1),label:'Photo '+(index+1),thumb:'/img/'+(index+1)+'.svg'}));
    window.cpHost={
      getProject:()=>({id:'p1',contacts:[{id:'c1',primary:true,name:'Pat',email:'pat@example.com'}]}),
      getPhotos:()=>mediaList,
      projectOrgId:()=>'org1',
      customerPortalEnabled:()=>true,
      customerPortalMediaEnabled:()=>true
    };
  },{LIVE,PREVIEW,photos,activity});
  await page.addScriptTag({url:'/libraries/apps/customer-portal/project.js'});
  await page.evaluate(async()=>{
    const app=Portal.modules.customerPortalProject;
    const panel=document.getElementById('panel');
    panel.innerHTML='<div class="cpo-panel" id="rCustomerPortalPanel"></div>';
    app.mount({panelRoot:panel,host:cpHost,projectWorkspace:cpHost});
    await app.load({silent:true});
  });
  const root=page.locator('#rCustomerPortalPanel');
  await root.locator('[data-cpo-tile]').first().waitFor().catch(()=>{});
  return {page,errors,root};
}

async function withBrowser(fn){
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{await fn(browser);}finally{await browser.close();}
}

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
  assert.equal(await preview.getAttribute('href'),PREVIEW);
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
    assert.ok(field.width>250,'link field takes the row on a phone');
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
