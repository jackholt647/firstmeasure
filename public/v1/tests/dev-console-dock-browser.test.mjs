import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// Docking (libraries/dev-console/dock.js): with the dev console on a desktop page, the page behaves as a window
// narrower by the console, folded strip included: fixed layers, vw lengths, width media queries, matchMedia,
// innerWidth, modal dialogs and frames all end where the console starts. Phones are not docked.
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
const PAGE=`<!doctype html><meta charset="utf-8"><style>
 body{margin:0;overflow:hidden;font:14px Arial}
 #pinned{position:fixed;top:0;right:0;width:60px;height:40px;background:red}
 #wide{position:fixed;left:0;top:50px;width:100vw;height:20px;background:blue}
 #frame{position:fixed;inset:80px 0 0 0;width:100%;height:300px;border:0}
 @media (max-width:1000px){#pinned{background:green}}
 @media (width <= 700px){#wide{height:44px}}
</style><div id="pinned"></div><div id="wide"></div><iframe id="frame" srcdoc="<p>frame</p>"></iframe><main>App</main>
<script>window.early=matchMedia('(max-width: 1000px)');window.resizes=0;addEventListener('resize',()=>window.resizes++);</script>`;

async function page(browser,width){
 const tab=await browser.newPage({viewport:{width,height:800}}),errors=[];tab.on('pageerror',e=>errors.push(e.message));
 await tab.route('http://dock.test/**',async route=>{const p=new URL(route.request().url()).pathname,json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...data})});
  if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.css')?'text/css':'application/javascript',body:await lib(p.replace(/^\/libraries\//,''))});
  if(p==='/v1/signup-sandbox/development/console')return json({sections:{guided:false}});
  return route.fulfill({contentType:'text/html',body:PAGE});
 });
 await tab.goto('http://dock.test/');
 await tab.evaluate(async()=>{await(await import('/libraries/dev-console/dev-console.js')).mount();});
 await tab.waitForSelector('.fm-dc-strip');
 return {tab,errors};
}
const measure=tab=>tab.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect();const d=document.querySelector('dialog[open]');return{inner:innerWidth,client:document.documentElement.clientWidth,body:box('body').right,pinned:box('#pinned').right,pinnedColor:getComputedStyle(document.querySelector('#pinned')).backgroundColor,wide:box('#wide').width,wideHeight:box('#wide').height,frame:box('#frame').right,frameInner:document.querySelector('#frame').contentWindow.innerWidth,early:window.early.matches,fresh:matchMedia('(max-width: 1000px)').matches,resizes:window.resizes,dialog:d?Math.round(box('dialog[open]').left+box('dialog[open]').width/2):null};});

test('dev console docking: the page is a narrower window, folded, open and expanded, and a phone is not docked',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const {tab,errors}=await page(browser,1280);
  // Folded: the strip takes its 20 px.
  let m=await measure(tab);
  assert.deepEqual([m.inner,m.client,m.body,m.pinned,m.wide,m.frame,m.frameInner],[1260,1260,1260,1260,1260,1260,1260],JSON.stringify(m));
  assert.equal(m.early,false);
  const strip=await tab.locator('.fm-dc-strip').boundingBox();
  assert.equal(Math.round(strip.x),1260,'the strip sits beside the page, not over it');
  // Open: everything ends at the console; media queries and matchMedia (also a list made before) see the rest.
  await tab.click('.fm-dc-strip');await tab.waitForTimeout(300);
  m=await measure(tab);
  const tray=await tab.locator('.fm-dc').boundingBox();
  assert.equal(Math.round(tray.x),880);
  assert.deepEqual([m.inner,m.body,m.pinned,m.wide,m.frame,m.frameInner],[880,880,880,880,880,880],JSON.stringify(m));
  assert.equal(m.pinnedColor,'rgb(0, 128, 0)','(max-width:1000px) applies at 880');
  assert.equal(m.wideHeight,20,'(width <= 700px) does not');
  assert.ok(m.early&&m.fresh,'matchMedia answers for the remaining width');
  assert.ok(m.resizes>=2,'a resize event on each change');
  // A modal dialog (top layer) is centred in the page, clear of the console.
  await tab.evaluate(()=>{const d=document.createElement('dialog');d.textContent='Modal';d.style.width='200px';document.body.append(d);d.showModal();});
  assert.equal((await measure(tab)).dialog,440);
  await tab.evaluate(()=>document.querySelector('dialog[open]').close());
  // Expanded: the page gets narrow enough for its narrow layout.
  await tab.click('.fm-dc-expand');await tab.waitForTimeout(300);
  m=await measure(tab);
  assert.ok(m.inner<=512&&m.body===m.inner&&m.pinned===m.inner,JSON.stringify(m));
  assert.equal(m.wideHeight,44,'(width <= 700px) applies when expanded');
  await tab.click('.fm-dc-expand');await tab.click('.fm-dc-fold');await tab.waitForTimeout(300);
  assert.equal((await measure(tab)).inner,1260,'folded again');
  assert.deepEqual(errors,[]);
  // A phone: the console covers the page as before; nothing is docked.
  const phone=await page(browser,390);
  await phone.tab.click('.fm-dc-strip');await phone.tab.waitForTimeout(300);
  m=await measure(phone.tab);
  assert.deepEqual([m.inner,m.body,m.pinned],[390,390,390],JSON.stringify(m));
  assert.equal(await phone.tab.evaluate(()=>document.documentElement.classList.contains('fm-dc-docked')),false);
  assert.deepEqual(phone.errors,[]);
 }finally{await browser.close();}
});
