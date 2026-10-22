import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const app=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
const layout=await readFile(new URL('../../libraries/window-manager/project-layout.js',import.meta.url),'utf8');
const capture=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const layoutCSS=layout.split('s.textContent=`')[1].split('`;')[0];
for(const [width,height,native]of [[390,844,false],[412,915,true],[390,1800,true],[700,500,true],[320,568,false]])test(`orbital intro distribution ${width}x${height}, Android=${native}`,async()=>{
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
 await page.evaluate(()=>{const form=document.querySelector('#rForm');const footer=document.createElement('footer');footer.style.cssText='height:48px;flex:none;background:#eee';footer.textContent='Back / Next';form.append(footer);});
 for(const review of [false,true]){
 if(review)await page.evaluate(()=>{const b=document.createElement('button');b.className='ext-orbit-secondary';b.textContent='Review 1 video';b.dataset.videoReview='';document.querySelector('.ext-orbit-actions').append(b);});
 const geometry=await page.evaluate(()=>{
 const q=s=>document.querySelector(s),r=s=>q(s).getBoundingClientRect();const scroll=q('.r-scroll');
 return {scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,titleGap:r('.ext-video-intro>p').top-r('.ext-video-intro>h3').bottom,videoGap:r('.ext-orbit').top-r('.ext-video-intro>p').bottom,footerGap:r('.ext-orbit-switch').top-r('.ext-orbit-actions').bottom,steps:[...q('.ext-orbit-steps').children].map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),bottom:r('.ext-orbit-switch').bottom,scrollBottom:scroll.getBoundingClientRect().bottom};
 });

 assert.ok(Math.abs(geometry.titleGap-geometry.videoGap)<1);
 assert.ok(geometry.footerGap<=5);
 if(height>=844){assert.ok(geometry.scrollHeight<=geometry.clientHeight+1,'unnecessary scroll '+JSON.stringify(geometry));assert.ok(Math.abs(geometry.bottom-geometry.scrollBottom)<20,'bottom anchored '+JSON.stringify(geometry));}
 assert.ok(Math.abs((geometry.steps[1].top-geometry.steps[0].bottom)-(geometry.steps[2].top-geometry.steps[1].bottom))<1);

 }
 const videoAnchor=await page.evaluate(()=>[document.querySelector('[data-video-start]').getBoundingClientRect().bottom,document.querySelector('.ext-orbit-switch').getBoundingClientRect().bottom]);
 await page.evaluate(()=>document.querySelector('[data-video-review]')?.remove());
 await page.click('[data-mode="photos"]');
 const photo=await page.evaluate(()=>{
 const q=s=>document.querySelector(s),r=s=>q(s).getBoundingClientRect();const scroll=q('.r-scroll');
 const items=[...q('.ext-photo-intro .ext-orbit-steps').children,q('.ext-photo-intro .ext-photo-warning')].map(e=>e.getBoundingClientRect());
 const middle=r('.ext-intro-middle');
 return {scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight,titleGap:r('.ext-photo-intro>p').top-r('.ext-photo-intro>h3').bottom,videoGap:r('.ext-orbit').top-r('.ext-photo-intro>p').bottom,footerGap:r('.ext-orbit-switch').top-r('.ext-orbit-actions').bottom,
  gutters:[items[0].top-middle.top,items[1].top-items[0].bottom,items[2].top-items[1].bottom,middle.bottom-items[2].bottom],start:r('[data-photos-start]').bottom,bottom:r('.ext-orbit-switch').bottom,scrollBottom:scroll.getBoundingClientRect().bottom};
 });
 assert.ok(Math.abs(photo.titleGap-photo.videoGap)<1,JSON.stringify(photo));
 assert.ok(photo.footerGap<=5);
 assert.ok(Math.max(...photo.gutters.slice(1,3))-Math.min(...photo.gutters.slice(1,3))<1,'steps and warning evenly spaced '+JSON.stringify(photo.gutters));
 if(height>=844){assert.ok(photo.scrollHeight<=photo.clientHeight+1,'unnecessary scroll '+JSON.stringify(photo));assert.ok(Math.abs(photo.bottom-photo.scrollBottom)<20,'bottom anchored '+JSON.stringify(photo));
  assert.ok(Math.abs(photo.bottom-videoAnchor[1])<1,'the switch link stays where the video intro had it '+JSON.stringify({photo,videoAnchor}));}
 await page.screenshot({path:process.env.TEMP+`/firstmate-photo-intro-${width}x${height}.png`});
 }finally{await browser.close();}
});
