import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';

const source=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const instrumented=source.replace('  P.ExteriorOrder={','  P.test={files,upload,assign,go,finishGuide,stopCamera,confirm:()=>{confirmedPins=pinSignature;},getPage:()=>page,getMode:()=>captureMode,getStream:()=>cameraStream};\n  P.ExteriorOrder={');
const views=['front','front-right','right','back-right','back','back-left','left','front-left'];

// State-only harness: no DOM, uploads go through the stubbed fetch.
async function stateHarness(){
 const portal={cfg:{serverEndpoint:'/local-test'},capabilities:{value:key=>key==='firstmeasure.exteriors'},util:{escapeHtml:s=>s,injectCSS(){},postAction:async()=>({data:{success:true,pricing_revision:2,options:[{key:'exteriors_standard',amount:25}]}})}};
 vm.runInNewContext(instrumented,{window:{Portal:portal},document:{getElementById:()=>null,cookie:''},URL,FormData,crypto:{randomUUID},fetch:async()=>({ok:true,json:async()=>({success:true,media_id:randomUUID()})})});
 const context={type:'residential',count:1,pins:[{lat:39,lng:-105}],ordered:false,orderWorkflow:true,refresh:()=>portal.ExteriorOrder.sync(context)};
 const order=portal.ExteriorOrder;order.sync(context);await new Promise(setImmediate);
 order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_standard'});
 return {order,context,t:portal.test};
}

test('an orbital video alone makes a structure orderable and survives a draft round trip',async()=>{
 const {order,t}=await stateHarness();
 assert.equal(t.getMode(),'video','orbital video is the default capture');
 t.confirm();assert.equal(order.mobilePhotosReady(),false);
 const clip=new File(['clip'],'walk.mp4',{type:'video/mp4'});
 await t.upload(clip,'tray:'+randomUUID());
 await t.upload(new File(['extra'],'dormer.jpg',{type:'image/jpeg'}),'tray:'+randomUUID());
 await t.upload(clip,'0:additional-closeup');
 assert.equal([...t.files.keys()].some(key=>key.startsWith('tray:')),false,'nothing waits for an angle while ordering by video');
 const fields=order.payload(),references=JSON.parse(fields.exterior_references);
 assert.equal(fields.exterior_capture_mode,'video');
 assert.deepEqual(references.map(r=>[r.view,r.kind]),[['orbital_video',undefined],['additional',undefined],['additional','video']]);
 assert.equal(order.mobilePhotosReady(),true);t.go(2);assert.equal(order.ready(),true);assert.equal(order.orderBlocker(),'');
 t.files.clear();order.restore(fields);
 assert.equal(t.getMode(),'video');assert.deepEqual(JSON.parse(order.payload().exterior_references),references);
});

test('videos never occupy one of the eight views, and photo orders still need all eight',async()=>{
 const {order,t}=await stateHarness();t.confirm();
 order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_standard',exterior_references:JSON.stringify(views.slice(1).map((view,i)=>({structure:0,view,media_id:'media_'+i})))});
 assert.equal(t.getMode(),'photos','a photo draft resumes in the photo fallback');
 t.confirm();assert.equal(order.mobilePhotosReady(),false,'seven views are not enough');
 await t.upload(new File(['clip'],'walk.mov',{type:'video/quicktime'}),'0:front');
 assert.equal(t.files.has('0:front'),false);
 assert.equal(JSON.parse(order.payload().exterior_references).filter(r=>r.view==='additional'&&r.kind==='video').length,1,'in photo mode a video is supporting media');
 t.files.set('tray:clip',{name:'clip.mp4',media_id:'clip',kind:'video'});t.assign('tray:clip','0:front');
 assert.equal(t.files.has('0:front'),false);
 assert.equal(JSON.parse(order.payload().exterior_references).filter(r=>r.view==='orbital_video').length,1);
 assert.equal(order.mobilePhotosReady(),true,'the structure is now covered by video');
 const oversized=new File(['x'],'huge.mp4',{type:'video/mp4'});Object.defineProperty(oversized,'size',{value:121*1024*1024});
 const before=t.files.size;await t.upload(oversized,'0:video-y');assert.equal(t.files.size,before,'oversized videos are refused before upload');
 await t.upload(new File(['x'],'photo.jpg',{type:'image/jpeg'}),'0:video-z');assert.equal(t.files.has('0:video-z'),false,'a photo cannot be the orbital video');
});

async function setup(t,{denied=false,count=1}={}){
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.route('https://capture.test/upload',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,media_id:randomUUID()})}));
 await page.route('https://capture.test/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial}.r-left{height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;padding:12px;gap:8px}.r-top{height:42px;flex-shrink:0}.r-form{display:flex;flex:1;min-height:0}.r-scroll{flex:1;min-height:0;overflow:auto}button{font:inherit}</style></head><body><div id="rOverlay" class="r-overlay mobile-order mobile-order-photos"><div class="r-left"><div class="r-top">Property address</div><form class="r-form"><div class="r-scroll"><div id="rStepType"><div id="rTypePill"></div></div></div></form></div></div></body></html>'}));
 await page.goto('https://capture.test/');
 await page.evaluate(({denied})=>{
  window.PlatformCommerce={credit:n=>'$'+Number(n||0).toFixed(2)};
  window.cameraCalls=0;const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async opts=>{window.cameraCalls++;window.cameraOptions=opts;if(denied)throw new DOMException('denied','NotAllowedError');return get(opts);};
  window.Portal={cfg:{serverEndpoint:'/upload'},capabilities:{value:()=>true},util:{escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),injectCSS:(id,css)=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);},postAction:async()=>({data:{success:true,base_price:25,options:[{key:'exteriors_standard',amount:25}]}})}};
 },{denied});
 await page.evaluate(instrumented);
 await page.evaluate(count=>{
  const order=Portal.ExteriorOrder;
  window.context={type:'residential',count,pins:[],ordered:false,orderWorkflow:true,mobileOrder:true,addressSelected:true,locationConfirmed:true,refresh:()=>order.sync(context),setMobileOrderPage:step=>order.setMobilePage(step)};
  order.sync(context);order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_standard'});order.setMobilePage('photos');
 },count);
 return page;
}
const uploaded=page=>page.waitForFunction(()=>Portal.test.files.size>0&&[...Portal.test.files.values()].every(f=>f.media_id));

test('the capture step opens on the animated orbit explainer and asks for the camera only after Start',async t=>{
 const page=await setup(t);
 assert.equal(await page.locator('.ext-orbit-intro h3').textContent(),'Record an orbital video');
 assert.equal(await page.locator('.ext-orbit-intro .ext-orbit .ext-orbit-arm .ext-orbit-walker').count(),1);
 assert.ok(await page.evaluate(()=>document.querySelector('.ext-orbit-arm').getAnimations().length>0),'the walker orbits the house');
 assert.equal(await page.locator('.ext-orbit-steps li').count(),3);
 assert.equal(await page.evaluate(()=>cameraCalls),0);
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotoBack()),false,'Back from the explainer leaves the capture step');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.evaluate(()=>document.querySelector('.ext-orbit-arm').getAnimations().length),0,'reduced motion shows a still frame');
});

test('recording pauses, resumes and stops into segments that upload as the orbital video',async t=>{
 const page=await setup(t);
 await page.click('[data-video-start]');
 await page.waitForFunction(()=>document.querySelector('.ext-rec video')?.videoWidth>0);
 assert.equal(await page.evaluate(()=>cameraOptions.audio),false,'no microphone prompt');
 assert.equal(await page.locator('[data-rec-toggle]').getAttribute('aria-label'),'Start recording');
 await page.click('[data-rec-toggle]');
 assert.equal(await page.locator('[data-rec-toggle]').getAttribute('aria-label'),'Stop recording');
 assert.equal(await page.locator('[data-rec-badge]').isVisible(),true);
 await page.waitForFunction(()=>document.querySelector('[data-rec-time]').textContent==='0:02');
 await page.click('[data-rec-back]');
 assert.equal(await page.locator('[data-rec-title]').textContent(),'Paused');
 assert.equal(await page.locator('[data-rec-back]').textContent(),'Resume');
 const held=await page.locator('[data-rec-time]').textContent();await page.waitForTimeout(1300);
 assert.equal(await page.locator('[data-rec-time]').textContent(),held,'the clock stops while paused');
 await page.click('[data-rec-back]');await page.waitForTimeout(1500);
 await page.click('[data-rec-toggle]');
 await uploaded(page);
 assert.equal(await page.locator('.ext-rec .ext-photo-tile.is-video').count(),1);
 assert.equal(await page.locator('[data-rec-forward]').textContent(),'Review');
 await page.click('[data-rec-toggle]');await page.waitForTimeout(3000);await page.click('[data-rec-toggle]');
 await page.waitForFunction(()=>Portal.test.files.size===2&&[...Portal.test.files.values()].every(f=>f.media_id));
 const segments=await page.evaluate(()=>[...Portal.test.files.values()].map(f=>({kind:f.kind,type:f.type,duration:f.duration,size:f.file.size})));
 assert.ok(segments.every(s=>s.kind==='video'&&/^video\/(mp4|webm)$/.test(s.type)&&s.size>0));
 assert.ok(segments[0].duration>=3&&segments[0].duration<4.6,'paused time is not counted: '+segments[0].duration);
 await page.evaluate(()=>window.liveTrack=Portal.test.getStream().getVideoTracks()[0]);
 await page.click('[data-rec-forward]');
 assert.equal(await page.evaluate(()=>liveTrack.readyState),'ended','the camera is released on the summary');
 assert.equal(await page.locator('[data-video-tiles="0"] .ext-photo-tile').count(),2);
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotoSummary()&&Portal.ExteriorOrder.mobilePhotosReady()),true);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(Portal.ExteriorOrder.payload().exterior_references).map(r=>r.view)),['orbital_video','orbital_video']);
 await page.locator('[data-video-tiles="0"] [data-guide-primary]').first().click();
 assert.equal(await page.locator('.ext-video-preview video').count(),1,'a segment can be played back');
 await page.click('.ext-video-preview button');assert.equal(await page.locator('.ext-video-preview').count(),0);
 const chooserPromise=page.waitForEvent('filechooser');await page.click('[data-extra-upload]');const chooser=await chooserPromise;
 assert.match(await chooser.element().getAttribute('accept'),/image\/jpeg.*video\/mp4/);await chooser.setFiles([]);
 await page.evaluate(()=>Portal.ExteriorOrder.setMobilePage('final'));
 assert.match(await page.locator('section[aria-label="Photos"]').textContent(),/Orbital video2 segments/);
 assert.equal(await page.locator('section[aria-label="Photos"] .ext-review-view').count(),0,'no empty eight-view grid on a video order');
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.ready()),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});

test('leaving mid-recording keeps the segment, and Back steps summary, recorder, explainer',async t=>{
 const page=await setup(t);
 await page.click('[data-video-start]');
 await page.waitForFunction(()=>document.querySelector('.ext-rec video')?.videoWidth>0);
 await page.click('[data-rec-toggle]');await page.waitForTimeout(3000);
 await page.evaluate(()=>Portal.test.stopCamera());
 await uploaded(page);
 assert.equal(await page.evaluate(()=>Portal.test.files.size),1);
 await page.evaluate(()=>Portal.test.finishGuide());
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotoBack()),true);
 assert.equal(await page.locator('.ext-rec').count(),1);
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotoBack()),true);
 assert.equal(await page.locator('[data-video-start]').textContent(),'Record another segment');
 assert.equal(await page.locator('[data-video-review]').count(),1);
});

test('a tap that starts and immediately stops saves nothing and says why',async t=>{
 const page=await setup(t);
 await page.click('[data-video-start]');
 await page.waitForFunction(()=>document.querySelector('.ext-rec video')?.videoWidth>0);
 await page.click('[data-rec-toggle]');await page.click('[data-rec-toggle]');
 await page.waitForSelector('.ext-photo-toast');
 assert.match(await page.locator('.ext-photo-toast').textContent(),/too short to save/);
 assert.equal(await page.evaluate(()=>Portal.test.files.size),0);
 assert.equal(await page.locator('[data-rec-toggle]').getAttribute('aria-label'),'Start recording');
});

test('without a live camera the record button opens the device video camera and uploads still work',async t=>{
 const page=await setup(t,{denied:true});
 await page.click('[data-video-start]');
 await page.waitForFunction(()=>document.querySelector('.ext-camera-status').textContent.includes('Camera access is off'));
 assert.match(await page.locator('.ext-camera-status').textContent(),/upload your videos/);
 let chooserPromise=page.waitForEvent('filechooser');await page.click('[data-rec-toggle]');let chooser=await chooserPromise;
 assert.equal(await chooser.element().getAttribute('capture'),'environment');assert.equal(await chooser.element().getAttribute('accept'),'video/*');await chooser.setFiles([]);
 chooserPromise=page.waitForEvent('filechooser');await page.click('[data-rec-upload]');chooser=await chooserPromise;
 assert.equal(await chooser.element().getAttribute('capture'),null);
 await chooser.setFiles({name:'walk.mp4',mimeType:'video/mp4',buffer:Buffer.from('fixture')});
 await uploaded(page);
 assert.equal(await page.evaluate(()=>[...Portal.test.files.keys()][0].startsWith('0:video-')),true);
 assert.equal(await page.evaluate(()=>cameraCalls),1,'a denied camera is not re-prompted');
});

test('the photo fallback explains the risk first, then runs the eight guided angles, and can return to video',async t=>{
 const page=await setup(t);
 await page.click('[data-mode="photos"]');
 assert.equal(await page.locator('.ext-orbit-intro h3').textContent(),'Order from photos');
 assert.match(await page.locator('.ext-photo-warning').textContent(),/may have to reject the project/);
 assert.equal(await page.locator('.ext-orbit-eight .ext-orbit-dot').count(),8);
 assert.equal(await page.evaluate(()=>cameraCalls),0);
 await page.click('[data-photos-start]');
 await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 assert.equal(await page.locator('[data-guide-title]').textContent(),'Front of House');
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.payload().exterior_capture_mode),'photos');
 await page.click('[data-guide-back]');
 assert.equal(await page.locator('[data-photos-start]').count(),1,'Back from the first angle returns to the explanation');
 await page.click('[data-mode="video"]');
 assert.equal(await page.locator('.ext-orbit-intro h3').textContent(),'Record an orbital video');
 await page.evaluate(()=>Portal.ExteriorOrder.explainMissingPhotos());
 assert.match(await page.locator('.ext-photo-toast').textContent(),/Add an orbital video/);
});

test('each structure is recorded separately',async t=>{
 const page=await setup(t,{count:2});
 await page.click('[data-video-start]');
 await page.waitForFunction(()=>document.querySelector('.ext-rec video')?.videoWidth>0);
 assert.match(await page.locator('[data-rec-step]').textContent(),/House 1 of 2/);
 await page.click('[data-rec-toggle]');await page.waitForTimeout(3000);await page.click('[data-rec-toggle]');
 await uploaded(page);
 assert.equal(await page.locator('[data-rec-forward]').textContent(),'Next house');
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotosReady()),false);
 await page.click('[data-rec-forward]');
 assert.match(await page.locator('[data-rec-step]').textContent(),/House 2 of 2/);
 assert.equal(await page.locator('.ext-rec .ext-photo-tile').count(),0);
 await page.click('[data-rec-toggle]');await page.waitForTimeout(3000);await page.click('[data-rec-toggle]');
 await page.waitForFunction(()=>Portal.test.files.size===2&&[...Portal.test.files.values()].every(f=>f.media_id));
 await page.click('[data-rec-forward]');
 assert.equal(await page.locator('[data-video-tiles]').count(),2);
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.mobilePhotosReady()),true);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(Portal.ExteriorOrder.payload().exterior_references).map(r=>r.structure)),[0,1]);
});
