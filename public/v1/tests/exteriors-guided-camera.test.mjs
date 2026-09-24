import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const source=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const instrumented=source.replace('  P.ExteriorOrder={','  P.test={files,upload,visitGuide,finishGuide,removeGuided,stopCamera,getStream:()=>cameraStream};\n  P.ExteriorOrder={');
async function setup(t,{denied=false,width=390,native=null}={}){
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:844}});
 await page.route('https://capture.test/**',route=>route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}.r-scroll{padding:16px;max-width:500px;margin:auto}button{font:inherit}</style></head><body><div id="rOverlay" class="r-overlay mobile-order mobile-order-photos"><div class="r-scroll"><div id="rStepType"><div id="rTypePill"></div></div></div></div></body></html>'}));
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
 assert.equal(await page.locator('[data-guide-title]').textContent(),'Front Left of the house');
 await page.evaluate(()=>window.liveTrack=Portal.test.getStream().getVideoTracks()[0]);
 for(let i=0;i<7;i++)await page.click('[data-guide-forward]');
 assert.equal(await page.locator('.ext-summary-guide').count(),1);
 assert.equal(await page.evaluate(()=>liveTrack.readyState),'ended');
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotosReady()),false);
 await page.click('[data-view="0:left"]');
 assert.equal(await page.locator('[data-guide-title]').textContent(),'Left of the house');
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
 assert.equal(await page.locator('.ext-shutter-control>span').textContent(),'Take photo');
});

test('older Android app explains the update, hides the empty video and exposes a labelled camera picker',async t=>{
 const page=await setup(t,{native:'legacy'});
 await page.waitForFunction(()=>document.querySelector('.ext-camera-status').textContent.includes('Update FirstMate'));
 assert.equal(await page.evaluate(()=>cameraCalls),0);
 assert.equal(await page.locator('video').evaluate(v=>getComputedStyle(v).visibility),'hidden');
 assert.equal(await page.locator('[data-guide-retry-camera]').isVisible(),false);
 assert.equal(await page.locator('.ext-shutter-control>span').textContent(),'Take photo');
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
 await page.click('[data-guide-summary]');
 assert.equal(await page.locator('.ext-summary-guide').count(),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:process.env.TEMP+'/firstmate-photo-summary.png'});
});
