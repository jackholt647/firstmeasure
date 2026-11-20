import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// GP-127: a Feed or gallery tile loads the smallest rendition that fills it at the screen's density (counted up
// to 2x), measured once the tile is laid out and before a lazy image starts loading: a photo filling a whole
// column gets thumb_640 instead of a stretched 320, a small tile keeps 320 or drops to 160, a photo cropped to
// cover a tile is re-checked once its shape is known, and only a tile far past 640 takes the screen-sized copy
// (display_*), else the original. A marked-up photo stays on its markup thumbnails. A redrawn tile starts from
// the size already chosen, so it is not fetched twice.
const libraries=new URL('../../libraries/',import.meta.url);
const chromePath=async()=>{for(const file of [process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()].filter(Boolean)){try{await access(file);return file;}catch{}}};

// A rendition is an SVG of its real size: thumb_N fits inside N x N, display_2400 inside 2400, the original is 4000.
function rendition(pathname){
  const [,id,variant]=pathname.match(/^\/media\/([^/]+)\/([^/.]+)/)||[];
  const longest=variant==='original'?4000:Number(variant.match(/\d+/)?.[0])||320;
  const [w,h]=id.includes('portrait')?[longest*3/4,longest]:[longest,longest*3/4];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#888"/></svg>`;
}

async function tilePage(browser,{width=433,dpr=3}={}){
  const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:dpr}),errors=[],requested=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://thumbs.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
    if(pathname.startsWith('/media/')){requested.push(pathname.slice('/media/'.length).replace('.svg',''));return route.fulfill({contentType:'image/svg+xml',body:rendition(pathname)});}
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:0}.pf-thumb{display:block;position:relative;padding:0;border:0;overflow:hidden}.pf-thumb img{width:100%;height:100%;object-fit:cover;display:block}</style><div id="tiles"></div>'});
  });
  await page.goto('http://thumbs.test/');
  await page.evaluate(()=>{
    const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.__APP={userOrgId:'org',userId:'sam'};
    window.Portal={cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(){}},ui:{showToast(){}}};
    window.PlatformAPI={media:{
      fileUrl:(org,id,variant='original')=>`/media/${id}/${variant}.svg`,
      variantUrl:(org,id,variant)=>`/media/${id}/${variant}.svg`,
      thumbnailUrl:(org,id,size=320)=>`/media/${id}/thumb_${size}.svg`,
      markupThumbnailUrl:(org,id,size=320)=>`/media/${id}/thumb_${size}_markup.svg`
    }};
    // Tiles of a given CSS size, each showing one photo through the Feed's own helpers.
    window.showTiles=(tiles)=>{
      const root=document.querySelector('#tiles');
      root.innerHTML=tiles.map(([id,w,h,variants])=>`<button type="button" class="pf-thumb" style="width:${w}px;height:${h}px">${window.Portal.PhotoFeed.mediaThumbHtml({id,photo:{id,media_id:id,variants,content_type:'image/jpeg'}})}</button>`).join('');
      window.Portal.PhotoFeed.bindThumbLoading(root);
    };
    window.shown=()=>Object.fromEntries([...document.querySelectorAll('#tiles img')].map(img=>[img.dataset.thumbMediaId,img.getAttribute('src').replace(/^\/media\/[^/]+\/|\.svg$/g,'')]));
  });
  await page.addScriptTag({url:'/libraries/apps/photos/feed.js'});
  return {page,errors,requested};
}
const THUMBS=['original','thumb_160','thumb_320','thumb_640'];
const settle=page=>page.waitForFunction(()=>[...document.querySelectorAll('#tiles img')].every(img=>img.complete&&img.naturalWidth)).then(()=>page.waitForTimeout(150));

test('a tile loads the smallest rendition that fills it at the screen density',async()=>{
  const browser=await chromium.launch({executablePath:await chromePath(),headless:true});
  try{
    // A 3x phone 433 px wide: the single-photo card fills the column; grid tiles are a quarter of it.
    let {page,errors,requested}=await tilePage(browser,{dpr:3});
    await page.evaluate(THUMBS=>window.showTiles([['wide',403,302,THUMBS],['small',100,75,THUMBS],['portrait_tile',197,146,THUMBS],['unlisted',403,302,undefined]]),THUMBS);
    await settle(page);
    assert.deepEqual(await page.evaluate(()=>window.shown()),{wide:'thumb_640',small:'thumb_320',portrait_tile:'thumb_640',unlisted:'thumb_640'});
    assert.ok(!requested.includes('wide/thumb_320'),`the column-wide tile never loads the 320 thumbnail first: ${requested}`);
    // Drawn again (a Feed refresh): the tile starts from the size it was given, not from 320 again.
    const before=requested.length;
    await page.evaluate(THUMBS=>window.showTiles([['wide',403,302,THUMBS]]),THUMBS);
    assert.equal(await page.locator('#tiles img').getAttribute('src'),'/media/wide/thumb_640.svg');
    await settle(page);
    assert.deepEqual(requested.slice(before).filter(name=>name.startsWith('wide/')&&name!=='wide/thumb_640'),[]);
    assert.deepEqual(errors,[]);
    await page.close();

    // The reporter's phone (about 1.84x): grid tiles stay on 320 unless the photo is portrait, which is re-checked
    // once it has loaded and its shape is known.
    ({page,errors,requested}=await tilePage(browser,{dpr:1.84}));
    await page.evaluate(THUMBS=>window.showTiles([['wide',403,302,THUMBS],['landscape',197,146,THUMBS],['portrait',197,146,THUMBS]]),THUMBS);
    await page.waitForFunction(()=>window.shown().portrait==='thumb_640');
    await settle(page);
    assert.deepEqual(await page.evaluate(()=>window.shown()),{wide:'thumb_640',landscape:'thumb_320',portrait:'thumb_640'});
    assert.deepEqual(errors,[]);
    await page.close();

    // A 1x screen: a small tile takes 160 before anything loads.
    ({page,errors,requested}=await tilePage(browser,{dpr:1}));
    await page.evaluate(THUMBS=>window.showTiles([['small',100,75,THUMBS]]),THUMBS);
    await settle(page);
    assert.deepEqual(await page.evaluate(()=>window.shown()),{small:'thumb_160'});
    assert.deepEqual(requested,['small/thumb_160']);
    await page.close();

    // A 2x desktop: a 700 px wide single photo is past what 640 can fill, so the screen-sized copy (else the
    // original); a marked-up photo stays on its largest markup thumbnail; a growing tile trades up.
    ({page,errors,requested}=await tilePage(browser,{width:1200,dpr:2}));
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('fm:media-markup-saved',{detail:{mediaId:'marked',revision:'2',hasMarkup:true}})));
    await page.evaluate(THUMBS=>window.showTiles([['display',700,390,[...THUMBS,'display_2400']],['original_only',700,390,THUMBS],['marked',700,390,THUMBS],['grows',100,75,THUMBS]]),THUMBS);
    await settle(page);
    assert.deepEqual(await page.evaluate(()=>window.shown()),{display:'display_2400',original_only:'original',marked:'thumb_640_markup',grows:'thumb_320'});
    await page.evaluate(()=>{document.querySelector('[data-thumb-media-id="grows"]').closest('.pf-thumb').style.cssText='width:400px;height:300px';});
    await page.waitForFunction(()=>window.shown().grows==='thumb_640');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
