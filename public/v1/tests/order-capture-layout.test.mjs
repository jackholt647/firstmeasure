import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const app=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
const layout=await readFile(new URL('../../libraries/window-manager/project-layout.js',import.meta.url),'utf8');
const capture=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const layoutCSS=layout.split('s.textContent=`')[1].split('`;')[0];
for(const [width,height,native]of [[390,844,false],[412,915,true],[700,500,true]])test(`modern camera layout ${width}x${height}, Android=${native}`,async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});try{
 const page=await browser.newPage({viewport:{width,height}});
 await page.route('https://capture.test/**',r=>r.fulfill({contentType:'text/html',body:`<html ${native?'data-native-app="android"':''}><style>*{box-sizing:border-box}body{margin:0;font:14px Arial}.r-win{height:100dvh}.r-project-body{container-type:inline-size;container-name:project-body}.r-preview-panel{height:100%;width:100%}.r-tab-main{min-height:360px}.r-form{margin:0}button{font:inherit}</style><div id="rOverlay" class="r-overlay project-layout-prototype mobile-order mobile-order-photos"><div class="r-win"><header style="height:60px;flex:none">Property address</header><div class="r-project-body"><div class="r-project-main-pane"><div class="r-right"><div class="r-preview-panel" data-panel="map"><div class="r-tab-content"><div class="r-overview-details"><form id="rForm" class="r-form"><div class="r-scroll"><section id="rStepCustomer" style="display:none"><div class="r-step-body"><div id="rStepType"><div id="rTypePill"></div></div></div></section></div></form></div><div class="r-tab-main">Map</div></div></div></div></div></div></div></div></html>`}));
 await page.goto('https://capture.test/');await page.addStyleTag({content:layoutCSS});
 await page.evaluate(native=>{
 window.Portal={cfg:{serverEndpoint:'/upload'},capabilities:{value:()=>true},util:{escapeHtml:s=>String(s),injectCSS:(_,css)=>{const s=document.createElement('style');s.textContent=css;document.head.append(s);},postAction:async()=>({data:{success:true,base_price:25,options:[{key:'exteriors_standard',amount:25}]}})}};
 window.PlatformCommerce={credit:n=>'$'+n};if(native)window.PhoneFeatures={isNative:()=>true,ready:Promise.resolve({platform:'android',capabilities:['liveCamera']})};
 },native);
 await page.addScriptTag({content:capture});
 await page.evaluate(()=>{const order=Portal.ExteriorOrder;window.ctx={type:'residential',count:1,pins:[],ordered:false,orderWorkflow:true,mobileOrder:true,addressSelected:true,locationConfirmed:true,refresh:()=>order.sync(ctx),setMobileOrderPage:s=>order.setMobilePage(s)};order.sync(ctx);order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_standard'});order.setMobilePage('photos');});
 assert.equal(await page.locator('.r-overview-details').evaluate(e=>getComputedStyle(e).borderBottomWidth),'0px');
 await page.locator('[data-video-start]').click();await page.waitForFunction(()=>document.querySelector('video')?.videoWidth>0);
 const boxes=await page.evaluate(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};return {camera:rect('.ext-camera'),footer:rect('.ext-guide-footer'),rail:rect('.r-overview-details'),screen:innerHeight};});
 assert.ok(boxes.camera.height>height*.35,JSON.stringify(boxes));assert.ok(boxes.footer.bottom<=height);assert.ok(boxes.footer.bottom>height-40,JSON.stringify(boxes));
 assert.equal(await page.locator('video').isVisible(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await mkdir(new URL('../../../output/order-capture-20261004/',import.meta.url),{recursive:true});await page.screenshot({path:`../../output/order-capture-20261004/camera-${width}.png`});
 }finally{await browser.close();}
});
test('submission locks immediately, coalesces rapid clicks, and unlocks after failure or completion',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();await page.setContent('<div id="rOverlay"><form id="rForm"><button id="rSubmit">Order Report</button></form><button id="rMobileBack">Back</button><button id="rMobileOrder">Order Report</button><button id="rMapCloseX">Close</button></div>');
 const code=app.slice(app.indexOf('  let orderSubmissionPending='),app.indexOf('  async function submitReport(e)'));
 await page.addScriptTag({content:`const hasReportOrdered=()=>false,isScheduleChoice=()=>false,hasSelectedAddons=()=>true;const $=s=>document.querySelector(s);const activeSubmitButton=()=>$('#rSubmit');let calls=0,finish,fail;function submitReport(){calls++;return new Promise((r,j)=>{finish=r;fail=j;});}function updateSubmitLabel(){$('#rSubmit').disabled=false;}function syncMobileOrderPagination(){$('#rMobileOrder').disabled=false;}function setSubmitBusyLabel(b,t){b.disabled=true;b.textContent=t;$('#rMobileOrder').disabled=true;}${code}window.trySubmit=()=>onSubmit({preventDefault(){}});window.getCalls=()=>calls;window.resolveSubmit=()=>finish();window.rejectSubmit=()=>fail(new Error('Network failure'));`});
 await page.evaluate(()=>{window.promise=trySubmit();window.pending=promise.catch(()=>{});window.same=trySubmit();});
 assert.equal(await page.evaluate(()=>promise===same),true);assert.equal(await page.locator('#rMobileBack').isDisabled(),true);assert.equal(await page.locator('#rForm').evaluate(e=>e.inert),true);assert.match(await page.locator('#rSubmit').textContent(),/Ordering/);assert.equal(await page.evaluate(()=>getCalls()),1);
 await page.evaluate(async()=>{rejectSubmit();await pending;});assert.equal(await page.locator('#rMobileBack').isDisabled(),false);assert.equal(await page.locator('#rForm').evaluate(e=>e.inert),false);
 await page.evaluate(()=>{window.pending=trySubmit();trySubmit();});assert.equal(await page.evaluate(()=>getCalls()),2);await page.evaluate(async()=>{resolveSubmit();await pending;});assert.equal(await page.locator('#rMobileBack').isDisabled(),false);
 }finally{await browser.close();}
});
