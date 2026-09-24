import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const source=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const instrumented=source.replace('  P.ExteriorOrder={','  P.test={files,upload,visitGuide,finishGuide,removeGuided,stopCamera,getStream:()=>cameraStream};\n  P.ExteriorOrder={');
async function setup(t,{denied=false,width=390,height=844,native=null}={}){
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height}});
 await page.route('https://capture.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}.r-left{height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;padding:12px;gap:8px}.r-top{height:42px;flex-shrink:0}.r-form{display:flex;flex:1;min-height:0}.r-scroll{flex:1;min-height:0;overflow:auto}button{font:inherit}</style></head><body><div id="rOverlay" class="r-overlay mobile-order mobile-order-photos"><div class="r-left"><div class="r-top">Property address</div><form class="r-form"><div class="r-scroll"><div id="rStepType"><div id="rTypePill"></div></div></div></form></div></div></body></html>'}));
 await page.goto('https://capture.test/');
 await page.evaluate(({denied,native})=>{
  window.cameraCalls=0;const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async opts=>{window.cameraCalls++;if(denied)throw new DOMException('denied','NotAllowedError');return get(opts);};
  window.Portal={cfg:{serverEndpoint:'/upload'},capabilities:{value:()=>true},util:{escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),injectCSS:(id,css)=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);},postAction:async()=>({data:{success:true,base_price:25,options:[{key:'exteriors_standard',amount:25}]}})}};
  window.fetch=async()=>({ok:true,json:async()=>({success:true,media_id:crypto.randomUUID()})});
  if(native){let info=null;const ready=new Promise(resolve=>{window.finishNativeInfo=()=>{info={platform:'android',version:native==='legacy'?'1.0.1':'1.0.2',capabilities:native==='legacy'?['camera']:['camera','liveCamera']};resolve(info);};});window.PhoneFeatures={isNative:()=>true,info:()=>info,ready};if(native==='legacy')window.finishNativeInfo();}
 },{denied,native});
 await page.evaluate(instrumented);
 await page.evaluate(()=>{
  const order=Portal.ExteriorOrder;
  window.context={type:'residential',count:1,pins:[],ordered:false,orderWorkflow:true,mobileOrder:true,addressSelected:true,locationConfirmed:true,refresh:()=>order.sync(context),setMobileOrderPage:step=>{window.lastStep=step;order.setMobilePage(step);}};
  order.sync(context);order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_standard'});order.setMobilePage('photos');
 });
 return page;
}

test('camera stays mounted across captures; newest is primary, extras persist and all eight steps lead to summary',async t=>{
 const page=await setup(t);
 await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 await page.evaluate(()=>window.originalVideo=document.querySelector('video'));
 await page.click('[data-guide-capture]');
 await page.waitForFunction(()=>Portal.test.files.size===1&&[...Portal.test.files.values()].every(f=>f.media_id));
 await page.click('[data-guide-capture]');
 await page.waitForFunction(()=>Portal.test.files.size===2&&[...Portal.test.files.values()].every(f=>f.media_id));
 assert.equal(await page.evaluate(()=>document.querySelector('video')===originalVideo),true);
 assert.equal(await page.evaluate(()=>cameraCalls),1);
 const refs=await page.evaluate(()=>JSON.parse(Portal.ExteriorOrder.payload().exterior_references));
 assert.equal(refs.filter(r=>r.view==='front').length,1);
 assert.equal(refs.find(r=>r.view==='additional').angle,'front');
 await page.click('[data-guide-primary]');
 assert.notEqual(await page.evaluate(()=>JSON.parse(Portal.ExteriorOrder.payload().exterior_references).find(r=>r.view==='front').media_id),refs.find(r=>r.view==='front').media_id);
 await page.click('[data-guide-forward]');
 assert.equal(await page.locator('[data-guide-title]').textContent(),'Front Left of House');
 await page.evaluate(()=>window.liveTrack=Portal.test.getStream().getVideoTracks()[0]);
 for(let i=0;i<7;i++)await page.click('[data-guide-forward]');
 assert.equal(await page.locator('.ext-summary-guide').count(),1);
 assert.equal(await page.evaluate(()=>liveTrack.readyState),'ended');
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotosReady()),false);
 await page.click('[data-view="0:left"]');
 assert.equal(await page.locator('[data-guide-title]').textContent(),'Left of House');
 await page.screenshot({path:process.env.TEMP+'/firstmate-guided-camera.png'});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 assert.equal(overflow,false);
});

test('native discovery can finish after the photo screen opens without disabling live capture',async t=>{
 const page=await setup(t,{native:'delayed'});
 assert.equal(await page.evaluate(()=>cameraCalls),0);
 assert.equal(await page.locator('video').evaluate(v=>getComputedStyle(v).visibility),'hidden');
 await page.evaluate(()=>{Portal.ExteriorOrder.render();window.finishNativeInfo();});
 await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 assert.equal(await page.evaluate(()=>cameraCalls),1);
 assert.equal(await page.locator('video').evaluate(v=>getComputedStyle(v).visibility),'visible');
 assert.equal(await page.locator('.ext-shutter-control>span').count(),0);
 assert.equal(await page.locator('[data-guide-capture]').getAttribute('aria-label'),'Take photo');
});

test('older Android app explains the update, hides the empty video and exposes a labelled camera picker',async t=>{
 const page=await setup(t,{native:'legacy'});
 await page.waitForFunction(()=>document.querySelector('.ext-camera-status').textContent.includes('Update FirstMate'));
 assert.equal(await page.evaluate(()=>cameraCalls),0);
 assert.equal(await page.locator('video').evaluate(v=>getComputedStyle(v).visibility),'hidden');
 assert.equal(await page.locator('[data-guide-retry-camera]').isVisible(),false);
 assert.equal(await page.locator('.ext-shutter-control>span').count(),0);
 assert.equal(await page.locator('[data-guide-capture]').getAttribute('aria-label'),'Take photo');
 const chosen=page.waitForEvent('filechooser');await page.click('[data-guide-capture]');
 const chooser=await chosen;assert.equal(await chooser.element().getAttribute('capture'),'environment');
 await chooser.setFiles([]);
});

test('denied camera does not reprompt during renders and upload remains available',async t=>{
 const page=await setup(t,{denied:true,width:320});
 await page.waitForFunction(()=>document.querySelector('.ext-camera-status').textContent.includes('Camera access is off'));
 await page.evaluate(()=>{Portal.ExteriorOrder.render();Portal.ExteriorOrder.render();});
 assert.equal(await page.evaluate(()=>cameraCalls),1);
 const chooserPromise=page.waitForEvent('filechooser');await page.click('[data-guide-upload]');
 await (await chooserPromise).setFiles({name:'front.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture')});
 await page.waitForFunction(()=>Portal.test.files.get('0:front')?.media_id);
 assert.equal(await page.evaluate(()=>cameraCalls),1);
 for(let i=0;i<8;i++)await page.click('[data-guide-forward]');
 assert.equal(await page.locator('.ext-summary-guide').count(),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:process.env.TEMP+'/firstmate-photo-summary.png'});
});


test('capture fills the screen, keeps three navigation buttons anchored and uses the normal additional-photo picker',async t=>{
 const page=await setup(t,{width:390,height:844});
 await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 const bottom=await page.locator('.ext-guide-footer').boundingBox();
 const camera=await page.locator('.ext-camera').boundingBox();
 await page.screenshot({path:process.env.TEMP+'/firstmate-capture-layout.png'});
 assert.ok(bottom.y+bottom.height>830 && bottom.y+bottom.height<=844,JSON.stringify({bottom,camera}));
 assert.ok(camera.height>400,JSON.stringify(camera));
 assert.equal(await page.locator('[data-guide-summary],[data-guide-instruction],[role=progressbar],.ext-capture-status').count(),0);
 for(let i=0;i<7;i++){
  await page.click('[data-guide-forward]');const box=await page.locator('.ext-guide-footer').boundingBox();assert.equal(box.y,bottom.y);
 }
 await page.click('[data-guide-capture]');await page.waitForFunction(()=>Portal.test.files.size===1);
 assert.equal((await page.locator('.ext-guide-footer').boundingBox()).y,bottom.y);
 await page.screenshot({path:process.env.TEMP+'/firstmate-capture-layout.png'});
 await page.click('[data-guide-forward]');
 await page.evaluate(()=>document.getAnimations().forEach(a=>a.finish()));
 const remove=await page.locator('.ext-summary-tiles .ext-thumb-remove').first().boundingBox();assert.equal(remove.width,24);assert.equal(remove.height,24);
 const extra=page.locator('[data-extra-upload]');const box=await extra.boundingBox();assert.ok(box.width>350&&box.height>=170);
 assert.equal(await page.locator('[data-extra-camera]').count(),0);
 const chooserPromise=page.waitForEvent('filechooser');await extra.click();const chooser=await chooserPromise;
 assert.equal(await chooser.element().getAttribute('capture'),null);
 assert.equal(chooser.isMultiple(),true);await chooser.setFiles([]);
 await page.screenshot({path:process.env.TEMP+'/firstmate-additional-layout.png'});
 await page.click('[data-view="0:front"]');await page.setViewportSize({width:320,height:640});
 const small=await page.locator('.ext-guide-footer').boundingBox();assert.ok(small.y+small.height<=640&&small.y+small.height>625);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});

test('captures appear before encoding or upload; primary selection, scrolling and removal work while pending',async t=>{
 const page=await setup(t);
 await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 await page.evaluate(()=>{
  const encode=HTMLCanvasElement.prototype.toBlob;
  window.encodes=[];window.uploads=[];
  HTMLCanvasElement.prototype.toBlob=function(...args){window.encodes.push(()=>encode.apply(this,args));};
  window.fetch=()=>new Promise(resolve=>window.uploads.push(()=>resolve({ok:true,json:async()=>({success:true,media_id:crypto.randomUUID()})})));
 });
 const before=await page.locator('.ext-shutter-control').boundingBox();
 await page.click('[data-guide-capture]');
 assert.equal(await page.locator('.ext-photo-tile').count(),1);
 assert.equal(await page.locator('[data-guide-capture]').isEnabled(),true);
 assert.equal(await page.evaluate(()=>uploads.length),0,'thumbnail precedes encoding and upload');
 assert.equal(await page.locator('.ext-thumb-busy').isVisible(),true);
 assert.ok(await page.locator('.ext-capture-flight').count()>0);
 await page.evaluate(()=>window.firstTile=document.querySelector('.ext-photo-tile'));
 for(let i=0;i<4;i++)await page.click('[data-guide-capture]');
 assert.equal(await page.locator('.ext-photo-tile').count(),5);
 assert.equal((await page.locator('.ext-shutter-control').boundingBox()).y,before.y);
 const upload=await page.locator('[data-guide-upload]').boundingBox();
 await page.locator('.ext-angle-photos').evaluate(e=>e.scrollLeft=0);
 await page.locator('[data-guide-primary]').first().click();
 assert.equal(await page.locator('.ext-photo-tile.primary').evaluate(e=>e===firstTile),true);
 await page.locator('.ext-angle-photos').evaluate(e=>e.scrollLeft=e.scrollWidth);
 assert.equal((await page.locator('[data-guide-upload]').boundingBox()).x,upload.x);
 assert.equal(await page.locator('.ext-angle-photos').textContent().then(s=>s.includes('Saved')),false);
 await page.locator('[data-guide-remove]').last().click();
 await page.evaluate(()=>encodes.splice(0).forEach(f=>f()));
 await page.waitForFunction(()=>uploads.length===3);
 await page.evaluate(()=>uploads.splice(0).forEach(f=>f()));
 await page.waitForFunction(()=>uploads.length===1);
 await page.evaluate(()=>uploads.splice(0).forEach(f=>f()));
 await page.waitForFunction(()=>[...Portal.test.files.values()].every(f=>f.media_id));
 assert.equal(await page.locator('.ext-photo-tile').count(),4);
 assert.equal(await page.locator('.ext-photo-tile.primary').evaluate(e=>e===firstTile),true);
 assert.equal(await page.locator('.ext-thumb-busy:visible').count(),0);
 for(const tile of await page.locator('.ext-photo-tile').all()){const box=await tile.boundingBox();assert.equal(box.width,box.height);}
 await page.screenshot({path:process.env.TEMP+'/firstmate-instant-thumbnails.png'});
});


test('summary uses four square columns, grouped primary selection, and missing-angle feedback',async t=>{
 const page=await setup(t);
 await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 for(let i=0;i<6;i++)await page.click('[data-guide-capture]');
 await page.waitForFunction(()=>Portal.test.files.size===6&&[...Portal.test.files.values()].every(f=>f.media_id));
 await page.evaluate(()=>{document.getAnimations().forEach(a=>a.finish());Portal.test.finishGuide();});
 const grid=page.locator('[data-summary-tiles="0:front"]');
 assert.equal(await grid.locator('.ext-photo-tile').count(),6);
 const boxes=await grid.locator('.ext-photo-tile').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
 assert.equal(boxes[0].y,boxes[3].y);assert.ok(boxes[4].y>boxes[0].y);assert.equal(boxes[0].w,boxes[0].h);
 await grid.locator('[data-guide-primary]').first().click();
 assert.equal(await grid.locator('.ext-photo-tile').first().getAttribute('class'),'ext-photo-tile primary');
 await page.evaluate(()=>Portal.ExteriorOrder.explainMissingPhotos());
 assert.match(await page.locator('.ext-photo-toast').textContent(),/Missing 7 angles/);
 await page.screenshot({path:process.env.TEMP+'/firstmate-summary-grid.png'});
});
