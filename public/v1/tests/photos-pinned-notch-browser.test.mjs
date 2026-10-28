import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// One project's gallery (its Photos tab) does not repeat the project's address: each day is one thin bar
// ("Today · 3 media items") and who uploaded an item is on its tile ("System" for media a writer made). The pinned
// tiles (the cover) sit in the top-left corner of the first day, whose outline runs around them: an L when that day's
// photos run under them, else a box beside them. A gallery of several projects keeps its project headers (FM-292).
const libraries=new URL('../../libraries/',import.meta.url);
const svg=(hue)=>`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="hsl(${hue},28%,62%)"/></svg>`;

async function gallery(page,{count,projects=1,pinned=true,system=false}){
 await page.evaluate(({count,projects,pinned,system})=>{
  const mount=document.querySelector('#rPhotoFeedMount');
  mount.innerHTML='';
  const today=new Date().toISOString();
  const photo=(i,project)=>({id:project+'_'+i,media_id:project+'_'+i,src:'/media/'+i+'.svg',thumb:'/media/'+i+'.svg',content_type:'image/svg+xml',uploaded_at:today,
   ...(system&&i===0?{source:'satellite_top_down',metadata:{source:'satellite_top_down'}}:{uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera'})});
  const list=Array.from({length:projects},(_,p)=>({id:'proj'+p,title:p+' Stage Street',address:p+' Stage Street, Austin, TX',photos:Array.from({length:count},(_,i)=>photo(i,'proj'+p))}));
  window.Portal.PhotoFeed.mountProjectGallery(mount,{
   project:list[0],photos:list[0].photos,...(projects>1?{projects:list}:{}),title:'',uploadLabel:'Upload',enableProjectLinks:false,projectLinkEnabled:false,routeScope:'',
   pinnedTiles:pinned?()=>({html:'<section data-pinned-photos data-notch-columns="1"><div class="cover-tile" style="height:100%;background:#d4a017;border-radius:8px">Cover photo</div></section>',columns:1}):undefined
  });
 },{count,projects,pinned,system});
 await page.waitForSelector('#rPhotoFeedMount .pf-thumb');
 await page.waitForTimeout(50);
}

test('one project: thin day bars, no address, the cover pinned into a notch in the first day',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://photos.test/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
   if(pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:svg(Number(pathname.match(/\d+/)?.[0]||0)*29%360)});
   return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:Arial,sans-serif;background:#f8fafc}#tab{position:absolute;inset:24px;display:flex;flex-direction:column}</style><div id="tab"><div id="rPhotoFeedMount" style="height:100%;min-height:0"></div></div>'});
  });
  await page.goto('http://photos.test/');
  await page.evaluate(()=>{
   const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.__APP={userOrgId:'org',userId:'sam'};
   window.Portal={cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(id,css){let el=document.getElementById('css_'+id);if(!el){el=document.createElement('style');el.id='css_'+id;document.head.append(el);}el.textContent=css;}},ui:{showToast(){}}};
   window.PlatformAPI={media:{fileUrl:(org,id)=>'/media/'+id+'.svg',thumbnailUrl:(org,id)=>'/media/'+id+'.svg'}};
  });
  await page.addScriptTag({url:'/libraries/apps/photos/feed.js'});

  // Many photos: the day runs under the cover, so its outline is an L with a rounded inner corner.
  await gallery(page,{count:14,system:true});
  assert.equal(await page.locator('.pf-day-heading').count(),0,'no separate day heading');
  assert.equal(await page.locator('.pf-project-link, .pf-uploaders').count(),0,'no address or uploader list on the group');
  assert.match((await page.locator('.pf-group-bar').first().textContent()).replace(/\s+/g,' ').trim(),/^Today ?· ?14 media items$/);
  const layout=await page.evaluate(()=>{
   const box=el=>el.getBoundingClientRect();
   const notch=box(document.querySelector('[data-pf-notch]')),bar=box(document.querySelector('.pf-group-bar')),group=box(document.querySelector('[data-pf-notched]'));
   const tiles=[...document.querySelectorAll('[data-pf-notched] .pf-thumb')].map(box);
   return {notch,bar,group,first:tiles[0],under:tiles.find(t=>t.top>=notch.bottom&&t.left<notch.right),d:document.querySelector('[data-pf-notch-path]').getAttribute('d')};
  });
  assert.ok(layout.notch.left-layout.group.left<20&&layout.notch.top-layout.group.top<20,'the cover is in the top-left corner');
  assert.ok(layout.bar.left>=layout.notch.right&&Math.abs(layout.bar.top-layout.notch.top)<12,'the day bar starts to the right of the cover');
  assert.ok(layout.bar.height<=32,`the day bar is thin (${layout.bar.height}px)`);
  assert.ok(layout.first.left>=layout.notch.right&&layout.first.top<layout.notch.bottom,'the first photos sit beside the cover');
  assert.ok(layout.under,'later photos run under the cover');
  assert.match(layout.d,/A10 10 0 0 0 /,'the outline turns in around the cover (a concave corner)');
  assert.match(await page.locator('.pf-thumb-meta').first().textContent(),/^System/,'media a writer made says System');

  // Few photos: a box beside the cover, nothing under it.
  await gallery(page,{count:2});
  const few=await page.evaluate(()=>({d:document.querySelector('[data-pf-notch-path]').getAttribute('d'),notch:document.querySelector('[data-pf-notch]').getBoundingClientRect().right-document.querySelector('[data-pf-notched]').getBoundingClientRect().left}));
  assert.doesNotMatch(few.d,/ 0 0 0 /,'no inner corner');
  assert.ok(Number(few.d.match(/^M([\d.]+)/)[1])>few.notch,'the box starts right of the cover');

  // No pinned tiles: a plain group with the thin bar.
  await gallery(page,{count:3,pinned:false});
  assert.equal(await page.locator('[data-pf-notched]').count(),0);
  assert.equal(await page.locator('.pf-group-bar').count(),1);

  // Several projects: each group keeps its project header and uploaders; the pinned tiles sit above the gallery.
  await gallery(page,{count:3,projects:2});
  assert.equal(await page.locator('.pf-group-bar').count(),0);
  assert.equal(await page.locator('.pf-day-heading').count(),1);
  assert.equal(await page.locator('.pf-uploaders').count(),2);
  assert.equal(await page.locator('.pf-pinned-intro [data-pinned-photos]').count(),1);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
