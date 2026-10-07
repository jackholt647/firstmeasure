import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('the line item attach popover shows the media library inside itself and saves the pick',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://attach.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
   if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:pathname.endsWith('.json')?'application/json':'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
   if(pathname.startsWith('/media/'))return route.fulfill({contentType:'image/png',body:png});
   return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><style>body{margin:16px;font-family:Arial}</style><button id="anchor" style="margin-left:700px">Attach</button>'});
  });
  await page.goto('http://attach.test/');
  await page.evaluate(()=>{
   const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.__APP={userOrgId:'org'};
   window.Portal={cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(id,css){let el=document.getElementById('css_'+id);if(!el){el=document.createElement('style');el.id='css_'+id;document.head.append(el);}el.textContent=css;}},ui:{showToast(){}}};
   window.PlatformAPI={media:{fileUrl:(org,id,variant)=>'/media/'+id+'/'+variant,thumbnailUrl:(org,id)=>'/media/'+id+'/thumb'}};
  });
  for(const file of ['platform-widgets/runtime.js','apps/photos/feed.js','platform-widgets/picker-widgets.js','doc-workflow/firstmate-doc-workflow.js'])await page.addScriptTag({url:'/libraries/'+file});
  await page.evaluate(async()=>{
   await FirstMateWidgets.ready;window.saved=[];
   const items=[{id:'m1',content_type:'image/png',label:'Front'},{id:'m2',content_type:'image/png',label:'Rear'}];
   const mount=(host,options)=>FirstMateWidgets.mount(host,{id:'media.picker',version:'1',config:{multiple:false,kind:'image_video',prompt:'Choose a photo'}},{surface:'project',target:{scope:'project',organizationId:'org',projectId:'p'},data:{'media.picker':{items}},
    onSelect:(value,detail)=>{if(detail.confirmed&&value?.media_ids?.[0])options.onPick({media_id:value.media_ids[0]});}});
   FMDocWorkflow.openMediaAttach({anchor:document.querySelector('#anchor'),item:{id:'line'},services:{media:{url:id=>'/media/'+id+'/thumb',mount}},onSave:patch=>saved.push(patch)});
  });
  await page.click('.fmdw-attach-thumb');
  await page.waitForSelector('.fmdw-attach-pop.library .fm-widget img');
  assert.equal(await page.locator('.fmdw-attach-pop').count(),1,'the library is inside the one popover');
  const box=await page.locator('.fmdw-attach-pop').boundingBox();
  assert.ok(box.x>=0&&box.x+box.width<=1100&&box.y>=0&&box.y+box.height<=800,'the wider popover stays inside the window');
  if(process.env.ATTACH_SHOT)await page.screenshot({path:process.env.ATTACH_SHOT});
  // A click outside the library does not throw away the popover; Escape returns to the form.
  await page.mouse.click(20,700);
  assert.equal(await page.locator('.fmdw-attach-pop.library').count(),1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.fmdw-attach-pop.library').count(),0);
  assert.equal(await page.locator('.fmdw-attach-pop [data-fmdw-attach-save]').count(),1);
  await page.click('.fmdw-attach-thumb');
  await page.locator('.fmdw-attach-pop.library .fm-widget img').first().click();
  await page.locator('.fmdw-attach-pop.library .fm-widget button:not([disabled])',{hasText:/select/i}).last().click();
  await page.waitForSelector('.fmdw-attach-pop:not(.library) .fmdw-attach-thumb img');
  await page.click('[data-fmdw-attach-save]');
  assert.deepEqual(await page.evaluate(()=>saved),[{media:[{media_id:'m1',variant:'display'}],video:null,display:'inline'}]);
  assert.equal(await page.locator('.fmdw-attach-pop').count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
