import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// The project Photos tab's selection toolbar floats over the bottom of the gallery: ticking a photo shows it without
// moving the grid, it has one primary action, the host's portal actions grouped, Delete last, and clearing hides it.
// PHOTOS_SHOT_DIR=<dir> also saves screenshots (with Font Awesome from the CDN).
const libraries=new URL('../../libraries/',import.meta.url);
const shots=process.env.PHOTOS_SHOT_DIR||'';
const svg=(hue)=>`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="hsl(${hue},28%,62%)"/><path d="M0 330L160 190L300 300L420 220L600 340V450H0Z" fill="hsl(${hue},30%,40%)"/></svg>`;

test('ticking a photo floats the selection toolbar in without moving the grid; clearing removes it',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:820}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://photos.test/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
   if(pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:svg(Number(pathname.match(/\d+/)?.[0]||0)*29%360)});
   return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8">${shots?'<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">':''}<style>body{margin:0;font-family:Arial,sans-serif;background:#f8fafc}#tab{position:absolute;inset:24px;display:flex;flex-direction:column}</style><div id="tab"><div id="rPhotoFeedMount" style="height:100%;min-height:0"></div></div>`});
  });
  await page.goto('http://photos.test/');
  await page.evaluate(()=>{
   const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.__APP={userOrgId:'org',userId:'sam'};
   window.Portal={cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(id,css){let el=document.getElementById('css_'+id);if(!el){el=document.createElement('style');el.id='css_'+id;document.head.append(el);}el.textContent=css;}},ui:{showToast(){}}};
   window.PlatformAPI={media:{fileUrl:(org,id)=>'/media/'+id+'.svg',thumbnailUrl:(org,id)=>'/media/'+id+'.svg'}};
  });
  await page.addScriptTag({url:'/libraries/apps/photos/feed.js'});
  await page.evaluate(()=>{
   const uploadedAt='2026-10-25T15:00:00Z';
   const photos=Array.from({length:24},(_,i)=>({id:'p'+i,media_id:'p'+i,src:'/media/p'+i+'.svg',thumb:'/media/p'+i+'.svg',content_type:'image/svg+xml',label:'Roof '+(i+1),uploaded_at:uploadedAt,uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera'}));
   window.shared=[];
   const portalAction=(id,label,icon)=>({id,label,icon,onClick:async(items,helpers)=>{window.shared.push([id,items.length]);helpers.clearSelection();helpers.render();}});
   window.Portal.PhotoFeed.mountProjectGallery(document.querySelector('#rPhotoFeedMount'),{
    project:{id:'proj',title:'12 Stage Street',photos},photos,title:'',uploadLabel:'Upload',enableProjectLinks:false,projectLinkEnabled:false,routeScope:'',
    selectionActions:[portalAction('share_customer_portal','Share to Portal','fa-link'),portalAction('unshare_customer_portal','Remove from Portal','fa-link-slash')]
   });
  });
  const gridTop=()=>page.evaluate(()=>document.querySelector('#rPhotoFeedMount [data-feed-scroll] .pf-day, #rPhotoFeedMount [data-feed-scroll] .pf-group').getBoundingClientRect().top);
  const scrollerTop=()=>page.evaluate(()=>document.querySelector('#rPhotoFeedMount [data-feed-scroll]').getBoundingClientRect().top);
  await page.waitForSelector('#rPhotoFeedMount .pf-thumb');
  // The tour's targets are still there.
  for(const selector of ['[data-photo-feed-upload]','input[type="search"]','[data-local-tags]','.pf-select'])assert.ok(await page.locator('#rPhotoFeedMount '+selector).count(),selector);
  const before={grid:await gridTop(),scroller:await scrollerTop()};
  assert.equal(await page.locator('.pf-seldock').count(),0,'no toolbar until something is selected');

  await page.locator('.pf-thumb').first().hover();
  await page.locator('.pf-thumb').first().locator('.pf-select').click();
  await page.waitForSelector('.pf-seldock.open');
  assert.deepEqual({grid:await gridTop(),scroller:await scrollerTop()},before,'selecting does not move the grid');
  const dock=page.locator('.pf-seldock');
  assert.equal((await dock.locator('[data-selection-count]').textContent()).trim(),'1 selected');
  assert.equal(await dock.getAttribute('role'),'toolbar');
  // Layout: count with clear and select all, the portal pair, one primary (Download), Delete last.
  const order=await dock.evaluate(el=>[...el.querySelectorAll('button')].filter(b=>!b.closest('[data-selection-download-menu]')).map(b=>Object.keys(b.dataset).find(k=>k.startsWith('selection'))+(b.dataset.selectionExtra?':'+b.dataset.selectionExtra:'')));
  assert.deepEqual(order,['selectionClear','selectionAll','selectionExtra:share_customer_portal','selectionExtra:unshare_customer_portal','selectionDownload','selectionDelete']);
  assert.equal(await dock.locator('.pf-seldock-primary').count(),1,'one primary action');
  assert.equal(await dock.locator('.pf-seldock-group [data-selection-extra]').count(),2,'portal actions are grouped');
  for(const [selector,tip] of [['[data-selection-clear]','Clear selection'],['[data-selection-extra="share_customer_portal"]','Share to Portal'],['[data-selection-extra="unshare_customer_portal"]','Remove from Portal'],['[data-selection-delete]','Delete']]){
   assert.equal(await dock.locator(selector).getAttribute('data-fm-tooltip'),tip);
   assert.equal(await dock.locator(selector).getAttribute('aria-label'),tip);
  }
  // It floats inside the tab, centred near the bottom.
  const [dockBox,mountBox]=[await dock.boundingBox(),await page.locator('#rPhotoFeedMount').boundingBox()];
  assert.ok(dockBox.y+dockBox.height<=mountBox.y+mountBox.height-8&&dockBox.y>mountBox.y+mountBox.height-90,'anchored to the bottom of the tab');
  assert.ok(Math.abs((dockBox.x+dockBox.width/2)-(mountBox.x+mountBox.width/2))<2,'centred');
  if(shots){await mkdir(shots,{recursive:true});await page.waitForTimeout(400);await page.screenshot({path:`${shots}/selection-one.png`});}

  // Ticking more updates the toolbar in place, keeps the scroll position and does not replay the entrance.
  const scrolled=await page.locator('[data-feed-scroll]').evaluate(el=>{el.scrollTop=120;return el.scrollTop;});
  assert.ok(scrolled>0,'the gallery scrolls');
  await page.evaluate(()=>{window.dockNode=document.querySelector('.pf-seldock');});
  // A tile wholly in view, so the click itself does not scroll.
  const visible=await page.evaluate(()=>{const box=document.querySelector('[data-feed-scroll]').getBoundingClientRect();return [...document.querySelectorAll('.pf-thumb')].findIndex((tile,index)=>{const r=tile.getBoundingClientRect();return index>0&&r.top>box.top+4&&r.bottom<box.bottom-100;});});
  assert.ok(visible>0);
  await page.locator('.pf-thumb').nth(visible).click();
  assert.equal(await page.locator('[data-feed-scroll]').evaluate(el=>el.scrollTop),scrolled,'ticking does not scroll the gallery');
  assert.equal(await page.evaluate(()=>document.querySelector('.pf-seldock')===window.dockNode),true,'the same toolbar stays');
  assert.equal((await dock.locator('[data-selection-count]').textContent()).trim(),'2 selected');
  await page.locator('[data-selection-download]').click();
  assert.equal(await page.locator('[data-selection-download-menu].visible').count(),1);
  const menu=await page.locator('[data-selection-download-menu]').boundingBox();
  assert.ok(menu.y+menu.height<=(await dock.boundingBox()).y+1,'the download menu opens upwards');
  if(shots)await page.screenshot({path:`${shots}/selection-download-menu.png`});
  await page.locator('[data-selection-download]').click();

  // Select all, then a host action, which clears.
  await page.locator('[data-selection-all]').click();
  assert.equal((await dock.locator('[data-selection-count]').textContent()).trim(),'24 selected');
  assert.equal(await dock.locator('[data-selection-all]').count(),0,'select all goes once everything is selected');
  await page.locator('[data-selection-extra="share_customer_portal"]').click();
  assert.deepEqual(await page.evaluate(()=>window.shared),[['share_customer_portal',24]]);
  await page.waitForSelector('.pf-seldock',{state:'detached'});

  // Clear: the toolbar slides out and is removed; the grid has not moved.
  await page.locator('[data-feed-scroll]').evaluate(el=>{el.scrollTop=0;});
  await page.locator('.pf-thumb').nth(2).hover();
  await page.locator('.pf-thumb').nth(2).locator('.pf-select').click();
  await page.waitForSelector('.pf-seldock.open');
  await page.locator('[data-selection-clear]').click();
  assert.equal(await page.locator('.pf-seldock.open').count(),0);
  await page.waitForSelector('.pf-seldock',{state:'detached'});
  assert.equal(await page.locator('.pf-thumb.selected').count(),0);
  assert.deepEqual({grid:await gridTop(),scroller:await scrollerTop()},before,'clearing does not move the grid');

  // Reduced motion: no transition.
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('.pf-thumb').nth(3).hover();
  await page.locator('.pf-thumb').nth(3).locator('.pf-select').click();
  assert.equal(await page.locator('.pf-seldock').evaluate(el=>getComputedStyle(el).transitionDuration.split(',').every(d=>parseFloat(d)===0)),true);
  await page.locator('[data-selection-clear]').click();
  await page.waitForSelector('.pf-seldock',{state:'detached'});

  if(shots){
   await page.emulateMedia({reducedMotion:'no-preference'});
   await page.setViewportSize({width:420,height:820});
   await page.locator('.pf-thumb').nth(1).hover();
   await page.locator('.pf-thumb').nth(1).locator('.pf-select').click();
   await page.waitForTimeout(400);
   await page.screenshot({path:`${shots}/selection-phone.png`});
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
