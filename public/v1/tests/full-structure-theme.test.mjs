import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const app=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
const layout=await readFile(new URL('../../libraries/window-manager/project-layout.js',import.meta.url),'utf8');
const capture=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const layoutCSS=layout.split('s.textContent=`')[1].split('`;')[0];
for(const [width,height,native]of [[390,600,false],[412,915,true],[390,1800,true],[700,500,true]])test(`full structure theme states ${width}x${height}, Android=${native}`,async()=>{
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
 await page.evaluate(()=>document.querySelector('.ext-order').insertAdjacentHTML('beforeend','<div class="theme-fixture"><button class="ext-extra-drop">Additional photos and videos</button><button class="ext-upload-tile">Upload</button><div class="ext-capture-heading"><div class="ext-angle-guide">Mini house background</div></div><div class="ext-summary-tiles"><div class="ext-photo-tile primary"><span class="ext-thumb-primary">Primary</span></div></div></div>'));
 const posterStart=capture.indexOf('  function videoPoster()');
 await page.addScriptTag({content:'const root=document.querySelector(".ext-order"),esc=s=>s;'+capture.slice(posterStart,capture.indexOf('\n  }',posterStart)+4)+';window.testPoster=videoPoster;'});
 for(const [color,rgb] of [['#2563eb','rgb(37, 99, 235)'],['#9333ea','rgb(147, 51, 234)']]){
 await page.evaluate(c=>{document.documentElement.style.setProperty('--primary',c);document.documentElement.style.setProperty('--primary-readable',c);},color);
 assert.equal(await page.locator('[data-video-start]').evaluate(e=>getComputedStyle(e).backgroundColor),rgb);

 assert.equal(await page.locator('.ext-orbit-bob svg>path').first().evaluate(e=>getComputedStyle(e).fill),rgb);
 assert.equal(await page.locator('.ext-orbit-secondary').first().evaluate(e=>getComputedStyle(e).color),rgb);
 for(const selector of ['.ext-extra-drop','.ext-upload-tile'])assert.equal(await page.locator(selector).last().evaluate(e=>getComputedStyle(e).color),rgb);
 const result=await page.evaluate(()=>{
  const primary=getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  const sample=color=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data].slice(0,3);};
  const color=s=>getComputedStyle(document.querySelector(s)).backgroundColor;
  const door=sample(color('.ext-wall.front b')),roof=sample('color-mix(in srgb,'+primary+' 35%,#475467)');
  return {door,roof,mini:sample(color('.theme-fixture .ext-angle-guide')),drop:sample(color('.ext-extra-drop')),primary:sample(primary),poster:decodeURIComponent(testPoster().split(',').slice(1).join(','))};
 });
 assert.ok(result.door.every((v,i)=>v<result.roof[i]),JSON.stringify(result));
 assert.match(result.poster,new RegExp('fill="'+color+'"'));
 // Background tint follows the dominant primary channel, not a fixed green tint.
 const dominant=color==='#2563eb'?2:0;
 assert.ok(result.mini[dominant]>result.mini[1]);assert.ok(result.drop[dominant]>result.drop[1]);
 }

 }finally{await browser.close();}
});
