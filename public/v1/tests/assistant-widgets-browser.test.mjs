import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('assistant places widgets beside chat, remembers side, and expands inline content without inner scrolling',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://assistant.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.startsWith('/libraries/')){
   const file=path.slice('/libraries/'.length);
   const data=process.env.ASSISTANT_ASSET_ORIGIN?await(await fetch(process.env.ASSISTANT_ASSET_ORIGIN+path+'?verify='+Date.now())).text():await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
   return route.fulfill({contentType:file.endsWith('.json')?'application/json':'application/javascript',body:data});
  }
  return route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font:14px Arial}.main{height:100vh}</style><main class="main"><div id="mainPanels"><section id="tab_assistant" class="active"></section></div></main>'});
 });
 await page.goto('http://assistant.test');
 await page.evaluate(()=>{
  window.__APP={userOrgId:'org'};window.Portal={};const thread={id:'main'};
  window.messages=[{id:'a',role:'assistant',content:'Here are your measurements.',data:{renders:[{type:'platform_widget',title:'Measurements',widget:{id:'scope.measurements',version:'1',target:{scope:'project',organizationId:'org',projectId:'p'}}}]}}];
  window.AssistantAPI={context:async()=>({main_thread:thread,threads:[thread],agents:[],dashboard:[]}),thread:async()=>({thread,messages})};
  window.PlatformAPI={publication:{read:async()=>({status:'ready',value:{rows:Array.from({length:180},(_,i)=>({label:'Measurement '+i,value:i,unit:'ft'}))}})}};
 });
 for(const f of ['platform-widgets/runtime.js','platform-widgets/project-widgets.js','window-manager/window-manager.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({url:'/libraries/'+f});
 await page.evaluate(()=>PlatformAssistant.openFull());
 await page.locator('[data-fma=boardItems]').getByText('Measurement 179',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-fma=msgs] fm-platform-widget').count(),0);
 const positions=()=>page.evaluate(()=>{const r=n=>document.querySelector(n).getBoundingClientRect();const b=r('[data-fma=board]'),c=r('.fma-main'),input=r('[data-fma=composer]'),content=r('[data-fma=content]');return{board:b.x,chat:c.x,center:input.x+input.width/2-(content.x+content.width/2),below:input.y>=b.bottom-1&&input.y>=c.bottom-1};});
 assert.ok((await positions()).board<(await positions()).chat);assert.ok((await positions()).below);assert.ok(Math.abs((await positions()).center)<1);
 await page.getByRole('button',{name:'Move widgets to the right',exact:true}).click();assert.ok((await positions()).board>(await positions()).chat);
 assert.ok(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.includes('boardSide')&&localStorage[k].includes('right'))));
 await page.getByRole('button',{name:'Close widget view',exact:true}).first().click();
 await page.locator('[data-fma=msgs]').getByText('Measurement 179',{exact:true}).waitFor();
 const preview=page.locator('[data-fma=msgs] .fm-widget-preview');
 assert.equal(await preview.evaluate(e=>getComputedStyle(e).overflow),'hidden');
 const before=await preview.evaluate(e=>e.clientHeight);assert.ok(before>=600);
 await page.locator('[data-fma=msgs] .fm-widget-expand').click();
 assert.ok(await preview.evaluate(e=>e.clientHeight)>before);
 assert.equal(await preview.evaluate(e=>e.clientHeight>=e.scrollHeight-1),true);
 await page.getByRole('button',{name:'Open widget view',exact:true}).click();
 await page.setViewportSize({width:480,height:850});
 await page.locator('[data-fma=msgs]').getByText('Measurement 179',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-fma=board]').isVisible(),false);
 assert.ok(await page.locator('[data-fma=msgs] fm-platform-widget').evaluate(e=>e.getBoundingClientRect().height)>600);
 await mkdir(new URL('../../../output/assistant-widget-view-20261002/',import.meta.url),{recursive:true});
 assert.ok(await page.locator('[data-fma=msgs]').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await page.screenshot({path:new URL('../../../output/assistant-widget-view-20261002/inline.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
 await page.setViewportSize({width:1440,height:1000});await page.locator('[data-fma=boardItems]').getByText('Measurement 179',{exact:true}).waitFor();
 await page.screenshot({path:new URL('../../../output/assistant-widget-view-20261002/side.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
 // A compact measurements card is centered without manufacturing overflow.
 await page.evaluate(()=>{PlatformAPI.publication.read=async()=>({status:'ready',value:{rows:Array.from({length:11},(_,i)=>({label:'Measurement '+i,value:i,unit:'ft'}))}});document.querySelector('[data-fma=boardItems] fm-platform-widget').refresh();});
 await page.waitForFunction(()=>document.querySelectorAll('[data-fma=boardItems] .fm-widget-value').length===11);
 const layout=await page.locator('[data-fma=boardItems]').evaluate(e=>{const card=e.querySelector('.fm-widget-card').getBoundingClientRect(),b=e.getBoundingClientRect(),style=getComputedStyle(e);const top=parseFloat(style.paddingTop),bottom=parseFloat(style.paddingBottom);return{overflow:e.scrollHeight-e.clientHeight,ratio:card.width/card.height,center:card.y+card.height/2-(b.y+top+(b.height-top-bottom)/2)};});
 assert.ok(layout.overflow<=1);assert.ok(Math.abs(layout.center)<3);assert.ok(layout.ratio<1.6);
 assert.equal(await page.locator('.fma-board-head').count(),0);
 assert.equal(await page.locator('.fma-head [data-fma=boardSide]').count(),1);
 assert.equal(await page.getByRole('button',{name:'Close widget view',exact:true}).count(),1);
 // Fade only the edge with content beyond the current scroll position.
 await page.locator('[data-fma=msgs]').evaluate(e=>{for(let i=0;i<35;i++){const p=document.createElement('p');p.textContent='A conversation turn '+i;p.style.flexShrink='0';e.append(p);}e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
 const fades=()=>page.locator('[data-fma=msgs]').evaluate(e=>[e.style.getPropertyValue('--fma-fade-top'),e.style.getPropertyValue('--fma-fade-bottom')]);
 assert.deepEqual(await fades(),['0px','28px']);
 await page.locator('[data-fma=msgs]').evaluate(e=>{e.scrollTop=120;e.dispatchEvent(new Event('scroll'));});assert.deepEqual(await fades(),['28px','28px']);
 await page.locator('[data-fma=msgs]').evaluate(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));});assert.deepEqual(await fades(),['28px','0px']);
 await page.waitForTimeout(500);
 await page.screenshot({path:new URL('../../../output/assistant-widget-view-20261002/spacing.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

