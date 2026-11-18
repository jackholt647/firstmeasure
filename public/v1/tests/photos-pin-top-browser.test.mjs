import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-560: a photo pinned to the top of a project's Photos tab leaves its day and is shown first, in one "Pinned"
// group (the latest pinned first), on a desktop and on a phone; the viewer, select all and the selection toolbar
// follow that order. The pin is on the media record (PATCH .../media/:id {pinned}): project.js offers Pin to top /
// Unpin from top in the viewer and the selection toolbar and redraws the gallery in place.
const libraries=new URL('../../libraries/',import.meta.url);
const chromePath=async()=>{for(const file of [process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()].filter(Boolean)){try{await access(file);return file;}catch{}}};

async function feedPage(browser,viewport){
  const page=await browser.newPage({viewport}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://photos.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
    if(pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#888"/></svg>'});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><div id="tab" style="position:absolute;inset:0;display:flex;flex-direction:column"><div id="rPhotoFeedMount" style="height:100%;min-height:0"></div></div>'});
  });
  await page.goto('http://photos.test/');
  await page.evaluate(()=>{
    const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.__APP={userOrgId:'org',userId:'sam'};
    window.Portal={cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(id,css){let el=document.getElementById('css_'+id);if(!el){el=document.createElement('style');el.id='css_'+id;document.head.append(el);}el.textContent=css;}},ui:{showToast(){}}};
    window.PlatformAPI={media:{fileUrl:(org,id)=>'/media/'+id+'.svg',thumbnailUrl:(org,id)=>'/media/'+id+'.svg'}};
    window.opened=[];
    window.FirstMateMarkup={loadMarkup:async()=>[],openPhotoViewer:options=>{window.opened.push([options.photos.map(photo=>photo.media_id),options.index]);return {close(){}};}};
  });
  await page.addScriptTag({url:'/libraries/apps/photos/feed.js'});
  await page.evaluate(()=>{
    // Six photos over three days, newest first; p4 (oldest day) and p1 are pinned, p1 pinned last.
    const day=['2026-11-17T15:00:00Z','2026-11-16T15:00:00Z','2026-11-15T15:00:00Z'];
    const photos=Array.from({length:6},(_,i)=>({id:'p'+i,media_id:'p'+i,src:'/media/p'+i+'.svg',thumb:'/media/p'+i+'.svg',content_type:'image/svg+xml',label:'Roof '+i,uploaded_at:day[Math.floor(i/2)],uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera'}));
    window.pins=new Map([['p4','2026-11-18T01:00:00Z'],['p1','2026-11-18T02:00:00Z']]);
    window.pinAction={id:'pin_top',label:items=>items.every(item=>window.pins.has(item.photo.media_id))?'Unpin from top':'Pin to top',icon:'fa-thumbtack',onClick:async(items,helpers)=>{
      const unpin=items.every(item=>window.pins.has(item.photo.media_id));
      items.forEach(item=>unpin?window.pins.delete(item.photo.media_id):window.pins.set(item.photo.media_id,'2026-11-18T03:00:00Z'));
      helpers.clearSelection();helpers.render();
    }};
    window.handle=window.Portal.PhotoFeed.mountProjectGallery(document.querySelector('#rPhotoFeedMount'),{
      project:{id:'proj',title:'12 Stage Street',photos},photos,title:'',uploadLabel:'Upload',mobileGrid:'dense',enableProjectLinks:false,projectLinkEnabled:false,routeScope:'',
      pinnedAt:item=>window.pins.get(item.photo.media_id)||'',
      selectionActions:[window.pinAction]
    });
  });
  return {page,errors};
}

const tileIds=page=>page.evaluate(()=>[...document.querySelectorAll('#rPhotoFeedMount .pf-thumb')].map(tile=>tile.dataset.photoFeedId.split('::').pop()));
const pinnedIds=page=>page.evaluate(()=>[...document.querySelectorAll('[data-pf-pinned-day] .pf-thumb')].map(tile=>tile.dataset.photoFeedId.split('::').pop()));

test('pinned photos come first in one Pinned group, the latest pinned first, and the viewer follows',async()=>{
  const browser=await chromium.launch({executablePath:await chromePath(),headless:true});
  try{
    const {page,errors}=await feedPage(browser,{width:1200,height:820});
    await page.waitForSelector('#rPhotoFeedMount .pf-thumb');
    assert.deepEqual(await pinnedIds(page),['p1','p4']);
    assert.deepEqual(await tileIds(page),['p1','p4','p0','p2','p3','p5'],'pinned photos leave their days');
    assert.equal(await page.locator('.pf-day').first().getAttribute('data-pf-pinned-day'),'','the Pinned group is the first');
    assert.match(await page.locator('[data-pf-pinned-day] .pf-group-bar').textContent(),/Pinned\s*·\s*2 media items/);
    // The viewer opens on the tapped photo, with the photos in the order shown.
    await page.locator('[data-photo-feed-id$="::p0"]').click();
    assert.deepEqual(await page.evaluate(()=>window.opened.at(-1)),[['p1','p4','p0','p2','p3','p5'],2]);
    // The host pins another photo and redraws in place.
    await page.evaluate(()=>{window.pins.set('p5','2026-11-18T04:00:00Z');window.handle.refresh();});
    assert.deepEqual(await pinnedIds(page),['p5','p1','p4']);
    // The selection toolbar's pin reads the selection: Unpin when everything selected is pinned.
    await page.locator('[data-photo-feed-id$="::p5"]').hover();
    await page.locator('[data-photo-feed-id$="::p5"] .pf-select').click();
    const pin=page.locator('.pf-seldock [data-selection-extra="pin_top"]');
    assert.equal(await pin.getAttribute('data-fm-tooltip'),'Unpin from top');
    await page.locator('[data-photo-feed-id$="::p0"] .pf-select').click();
    assert.equal(await pin.getAttribute('data-fm-tooltip'),'Pin to top');
    await page.locator('[data-photo-feed-id$="::p0"] .pf-select').click();
    await pin.click();
    assert.deepEqual(await pinnedIds(page),['p1','p4']);
    assert.deepEqual(await tileIds(page),['p1','p4','p0','p2','p3','p5']);
    // Nothing pinned: no Pinned group.
    await page.evaluate(()=>{window.pins.clear();window.handle.refresh();});
    assert.equal(await page.locator('[data-pf-pinned-day]').count(),0);
    assert.deepEqual(await tileIds(page),['p0','p1','p2','p3','p4','p5']);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('on a phone the Pinned group has its own heading above the days',async()=>{
  const browser=await chromium.launch({executablePath:await chromePath(),headless:true});
  try{
    const {page,errors}=await feedPage(browser,{width:433,height:582});
    await page.waitForSelector('#rPhotoFeedMount .pf-thumb');
    assert.equal((await page.locator('.pf-day-title').first().textContent()).trim(),'Pinned');
    assert.deepEqual(await pinnedIds(page),['p1','p4']);
    const [pinnedBox,nextBox]=await Promise.all([page.locator('[data-pf-pinned-day]').boundingBox(),page.locator('.pf-day:not([data-pf-pinned-day])').first().boundingBox()]);
    assert.ok(pinnedBox.y+pinnedBox.height<=nextBox.y+1,'above the first day');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('project Photos tab: Pin to top saves the pin on the media record and redraws the gallery',async()=>{
  const browser=await chromium.launch({executablePath:await chromePath(),headless:true});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://photos.test/**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><div id="rPhotoGallery"></div>'});
    });
    await page.goto('http://photos.test/');
    await page.evaluate(()=>{
      window.project={id:'project',custom_field_values:{},photos:[
        {id:'a',media_id:'a',content_type:'image/jpeg',file_name:'Front.jpg'},
        {id:'b',media_id:'b',content_type:'video/mp4',file_name:'Walk.mp4',metadata:{pinned:true,pinned_at:'2026-11-17T00:00:00Z'}},
        {id:'local_c',media_id:'local_c',content_type:'image/png',uploading:true}
      ]};
      window.toasts=[];window.calls=[];window.refreshes=0;window.persists=0;window.failPin=false;
      window.Portal={cfg:{orgId:'org'},ui:{showToast:(...args)=>window.toasts.push(args)},PhotoFeed:{mountProjectGallery:(_el,options)=>{window.gallery=options;return {refresh:()=>{window.refreshes++;}};}}};
      window.projectOrgId=()=>'org';
      window.PlatformAPI={media:{
        list:async()=>({media:[]}),
        setPinned:async(org,id,pinned)=>{if(window.failPin)throw Error('offline_unavailable');window.calls.push([org,id,pinned]);return {ok:true,media:{id,metadata:pinned?{pinned:true,pinned_at:'2026-11-18T05:00:00Z'}:{pinned:false}}};}
      }};
    });
    await page.addScriptTag({url:'/libraries/apps/photos/project.js'});
    await page.evaluate(()=>{
      const host={getProject:()=>window.project,getPhotos:()=>window.project.photos,setPhotos:photos=>{window.project.photos=photos;},persistProject:()=>{window.persists++;return true;}};
      window.Portal.ProjectPhotosTab.mount({panelRoot:document.querySelector('#rPhotoGallery'),host});
      window.Portal.ProjectPhotosTab.render();
    });
    const photo=id=>`window.project.photos.find(p=>p.media_id===${JSON.stringify(id)})`;
    const action=id=>`window.gallery.viewerActions.find(a=>a.id===${JSON.stringify(id)})`;
    const visible=(id,photoId)=>page.evaluate(`${action(id)}.visible({photo:${photo(photoId)}})`);
    const run=(id,photoId)=>page.evaluate(`${action(id)}.onClick({photo:${photo(photoId)},viewer:{refreshActions(){},refreshIndicators(){}}})`);
    const pinnedAt=photoId=>page.evaluate(`window.gallery.pinnedAt({photo:${photo(photoId)}})`);
    // The stored pin orders the gallery; the viewer offers the matching action; an upload in progress has none.
    assert.equal(await pinnedAt('b'),'2026-11-17T00:00:00Z');
    assert.equal(await pinnedAt('a'),'');
    assert.deepEqual([await visible('pin_top','a'),await visible('unpin_top','a')],[true,false]);
    assert.deepEqual([await visible('pin_top','b'),await visible('unpin_top','b')],[false,true],'a video can be pinned too');
    assert.deepEqual([await visible('pin_top','local_c'),await visible('unpin_top','local_c')],[false,false]);
    assert.equal(await page.evaluate(()=>window.gallery.viewerActions[0].id),'pin_top','first in the viewer\'s actions');
    // Pin: one PATCH, the local copy and the gallery follow, the project's photo list is saved.
    await run('pin_top','a');
    assert.deepEqual(await page.evaluate(()=>window.calls),[['org','a',true]]);
    assert.deepEqual(await page.evaluate(()=>window.project.photos.find(p=>p.media_id==='a').metadata),{pinned:true,pinned_at:'2026-11-18T05:00:00Z'});
    assert.equal(await pinnedAt('a'),'2026-11-18T05:00:00Z');
    assert.deepEqual(await page.evaluate(()=>[window.refreshes,window.persists]),[1,1]);
    assert.deepEqual([await visible('pin_top','a'),await visible('unpin_top','a')],[false,true]);
    const indicator=photoId=>page.evaluate(`window.gallery.viewerIndicators.find(i=>i.id==='pinned_top').visible({photo:${photo(photoId)}})`);
    assert.equal(await indicator('a'),true);
    assert.match(await page.evaluate(()=>window.toasts.at(-1)[0]),/Pinned to the top/);
    // Unpin stores pinned:false, so an older copy of the photo cannot bring the pin back.
    await run('unpin_top','b');
    assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['org','b',false]);
    assert.deepEqual(await page.evaluate(()=>window.project.photos.find(p=>p.media_id==='b').metadata),{pinned:false});
    assert.equal(await pinnedAt('b'),'');
    // The selection toolbar: Pin to top unless everything selected is pinned; it pins only what is not.
    const selection=await page.evaluate(()=>window.gallery.selectionActions.map(a=>a.id));
    assert.deepEqual(selection,['pin_top']);
    const items=ids=>`[${ids.map(id=>`{photo:${photo(id)}}`).join(',')}]`;
    assert.equal(await page.evaluate(`window.gallery.selectionActions[0].label(${items(['a'])})`),'Unpin from top');
    assert.equal(await page.evaluate(`window.gallery.selectionActions[0].label(${items(['a','b'])})`),'Pin to top');
    await page.evaluate(`window.gallery.selectionActions[0].onClick(${items(['a','b'])},{})`);
    assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['org','b',true],'a is already pinned');
    assert.equal(await page.evaluate(()=>window.calls.length),3);
    // A refused pin changes nothing and says so.
    await page.evaluate(()=>{window.failPin=true;});
    await run('unpin_top','a');
    assert.equal(await pinnedAt('a'),'2026-11-18T05:00:00Z');
    assert.match(await page.evaluate(()=>window.toasts.at(-1).join(' ')),/Pin not changed/);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
