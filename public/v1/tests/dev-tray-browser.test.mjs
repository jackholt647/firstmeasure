import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// The dev tray (libraries/dev-console/quick-tray.js): on a phone there is no edge strip; a shake (the app's event, or
// devicemotion in a browser) opens a tray over the bottom half; it signs in to Tracker once, lists the workspace's
// issues, files the next issue to Ready in General platform work with a screenshot of the page without the tray,
// closes on Go, and opens the full dev console from its header. A desktop keeps the strip.
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url));
const PAGE=`<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px Arial;background:#e8f0ff}main{padding:20px}</style><main><h1>Projects</h1><p>Underneath</p></main>
<div id="mobilePlatformMoreMenu"></div>`;
const NOW=new Date().toISOString();
const ISSUES=[
 {id:'i1',key:'FM-1',title:'Ready thing',status:{name:'Ready',category:'unstarted',color:'#2e90fa'},updated_at:NOW},
 {id:'i2',key:'FM-2',title:'',status:{name:'In progress',category:'started',color:'#f79009'},updated_at:NOW,agent:{live:true}},
 {id:'i3',key:'FM-3',title:'Needs Jack',status:{name:'Ready',category:'unstarted',color:'#2e90fa'},updated_at:NOW,needs_input:{}}
];

async function page(browser,{width=390,height=844,app=true}={}){
 const tab=await browser.newPage({viewport:{width,height},hasTouch:width<700}),errors=[],tracker=[];
 tab.on('pageerror',e=>errors.push(e.message));
 await tab.route('http://tray.test/**',async route=>{const p=new URL(route.request().url()).pathname;
  if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.css')?'text/css':'application/javascript',body:await lib(p.replace(/^\/libraries\//,''))});
  if(p==='/v1/signup-sandbox/development/console')return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,sections:{guided:false}})});
  return route.fulfill({contentType:'text/html',body:PAGE});
 });
 await tab.route('https://tracker.1m8.ai/**',async route=>{
  const r=route.request(),url=new URL(r.url()),p=url.pathname.replace('/api/v1',''),json=(status,body)=>route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(body)});
  tracker.push({method:r.method(),path:p+url.search,headers:r.headers(),body:r.method()==='POST'?r.postDataBuffer():null});
  if(p==='/auth/login')return JSON.parse(r.postData()).password==='pw'?json(200,{token:'fts_t',user:{name:'Jack',email:'jack@test'}}):json(401,{error:'Wrong email or password'});
  if(p==='/projects')return json(200,[{id:'w-other',name:'Exteriors',kind:'workspace'},{id:'w-gpw',name:'General platform work',kind:'workspace'}]);
  if(p==='/issues'&&r.method()==='GET')return json(200,ISSUES);
  if(p==='/uploads')return json(201,{url:'https://tracker.1m8.ai/uploads/shot.jpg'});
  if(p==='/issues')return json(201,{id:'i9',key:'FM-9',...JSON.parse(r.postData()),status:{name:'Ready',category:'unstarted'},updated_at:NOW});
  if(p==='/issues/FM-1')return json(200,{...ISSUES[0],description:'Steps here\n\n![Screenshot](https://tracker.1m8.ai/uploads/x.jpg)'});
  if(p==='/issues/FM-1/comments')return json(200,[{body:'Fixed on dev',author:{name:'Agent · FM-1'},created_at:NOW}]);
  return json(404,{error:'nope'});
 });
 await tab.goto('http://tray.test/');
 if(app)await tab.evaluate(()=>{
  // The FirstMate app: the bridge reports shake and screenshot. The screenshot records whether the tray was showing.
  document.documentElement.dataset.nativeApp='android';
  window.shots=[];
  window.PhoneFeatures={ready:Promise.resolve({}),supports:n=>n==='shake'||n==='screenshot',info:()=>({platform:'android',version:'1.0.9'}),haptic:async()=>{},
   screenshot:async()=>{const t=document.querySelector('.fm-qt'),b=document.querySelector('.fm-qt-backdrop');window.shots.push({tray:getComputedStyle(t).visibility,backdrop:getComputedStyle(b).visibility});return new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'});}};
 });
 await tab.evaluate(async()=>{await(await import('/libraries/dev-console/dev-console.js')).mount();});
 await tab.waitForFunction(()=>window.FirstMateDevConsole&&document.querySelector('.fm-qt'));
 return {tab,errors,tracker};
}
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('dev tray in the app: shake, sign in, see issues, screenshot without the tray, Go to Ready, open the full menu',async()=>{
 const browser=await launch();
 try{
  const {tab,errors,tracker}=await page(browser);
  assert.equal(await tab.locator('.fm-dc-strip').isVisible(),false,'no edge tab on a phone');
  assert.equal(await tab.locator('.fm-qt').isVisible(),false,'closed until a shake');
  await tab.evaluate(()=>window.dispatchEvent(new CustomEvent('fm:native:shake')));
  await tab.waitForTimeout(300);
  const box=await tab.locator('.fm-qt').boundingBox();
  assert.ok(Math.round(box.width)===390&&Math.abs(box.y+box.height-844)<=1,'across the bottom '+JSON.stringify(box));
  assert.ok(box.height>=380&&box.height<=500,'about half the screen: '+box.height);
  const go=await tab.locator('.fm-qt-go').first().boundingBox(),text=await tab.locator('.fm-qt-text').boundingBox();
  assert.ok(text.width>=box.width*0.65,'the box takes most of the width');
  assert.ok(Math.abs((go.y)-(text.y))<=1&&go.x>text.x+text.width,'Go beside the box');
  const menu=await tab.locator('.fm-qt-menu').boundingBox();
  assert.ok(menu.x+menu.width>=box.width-12&&menu.y<box.y+50&&menu.width<=36,'a small menu button in the top right');
  // Signed out: Go asks to sign in; the sign-in sits where the list goes.
  await tab.fill('.fm-qt-text','Map pin is offset');
  await tab.click('.fm-qt-compose .fm-qt-go');
  assert.match(await tab.locator('.fm-qt-error').innerText(),/Sign in to Tracker/);
  await tab.fill('.fm-qt-signin [name=tracker-email]','jack@test');await tab.fill('.fm-qt-signin [name=tracker-password]','bad');
  await tab.click('.fm-qt-signin button');
  await tab.locator('.fm-qt-error',{hasText:'Wrong email or password'}).waitFor();
  await tab.fill('.fm-qt-signin [name=tracker-password]','pw');await tab.click('.fm-qt-signin button');
  await tab.locator('.fm-qt-group h3',{hasText:'In progress'}).waitFor();
  assert.deepEqual((await tab.locator('.fm-qt-group h3').allInnerTexts()).map(s=>s.replace(/\s+/g,' ')),['IN PROGRESS 1','READY 2'],'grouped, in progress first');
  assert.equal(await tab.locator('.fm-qt-target select').inputValue(),'w-gpw','General platform work by default');
  assert.equal(await tab.locator('[data-qt-issue="FM-2"] em').innerText(),'Titling…');
  assert.equal(await tab.locator('[data-qt-issue="FM-2"] .fm-qt-agent').count(),1);
  assert.equal(await tab.locator('[data-qt-issue="FM-3"] .fm-qt-badge').innerText(),'Needs input');
  const auth=tracker.find(c=>c.path.startsWith('/issues?'));
  assert.equal(auth.headers.authorization,'Bearer fts_t');assert.equal(auth.headers.cookie,undefined);
  assert.equal(auth.path,'/issues?project=w-gpw&status=open');
  // An issue opens in place with its description and the latest comment.
  await tab.click('[data-qt-issue="FM-1"]');
  await tab.locator('.fm-qt-detail .fm-qt-comment',{hasText:'Fixed on dev'}).waitFor();
  assert.equal(await tab.locator('.fm-qt-detail img.fm-qt-img').getAttribute('src'),'https://tracker.1m8.ai/uploads/x.jpg');
  // Screenshot: taken from the app with the tray and its backdrop hidden, then shown as a thumbnail.
  await tab.click('.fm-qt-shot');
  await tab.locator('.fm-qt-thumb img').waitFor();
  assert.deepEqual(await tab.evaluate(()=>window.shots),[{tray:'hidden',backdrop:'hidden'}]);
  assert.equal(await tab.locator('.fm-qt').evaluate(el=>getComputedStyle(el).visibility),'visible','shown again');
  // Go: upload, then the issue, straight to Ready in General platform work; the tray closes.
  await tab.click('.fm-qt-compose .fm-qt-go');
  await tab.locator('.fm-dc-toast',{hasText:'Filed FM-9'}).waitFor();
  await tab.waitForTimeout(250);
  assert.equal(await tab.locator('.fm-qt').isVisible(),false,'closed on Go');
  const upload=tracker.find(c=>c.path==='/uploads');
  assert.equal(upload.headers['content-type'],'image/jpeg');assert.equal(upload.headers['x-filename'],undefined);
  const created=JSON.parse(tracker.filter(c=>c.method==='POST'&&c.path==='/issues').at(-1).body.toString());
  assert.equal(created.project,'w-gpw');assert.equal(created.status,'Ready');assert.equal(created.title,'Map pin is offset');
  assert.match(created.description,/^!\[Screenshot\]\(https:\/\/tracker\.1m8\.ai\/uploads\/shot\.jpg\)\n\n_Filed from the dev tray\. Page: \/ · Screen: 390×844 · App: FirstMate android 1\.0\.9_$/);
  // Opened again: empty box, no screenshot, other workspace can be chosen; the menu button opens the full console.
  await tab.evaluate(()=>window.dispatchEvent(new CustomEvent('fm:native:shake')));
  await tab.waitForTimeout(1700);
  await tab.evaluate(()=>window.dispatchEvent(new CustomEvent('fm:native:shake')));
  await tab.locator('.fm-qt.fm-qt-in').waitFor();
  assert.equal(await tab.locator('.fm-qt-text').inputValue(),'');
  assert.equal(await tab.locator('.fm-qt-thumb').isVisible(),false);
  await tab.selectOption('.fm-qt-target select','w-other');
  await tab.waitForFunction(()=>true);
  await tab.click('.fm-qt-menu');
  await tab.locator('.fm-dc').waitFor({state:'visible'});
  await tab.waitForTimeout(250);
  assert.equal(await tab.locator('.fm-qt').isVisible(),false);
  const full=await tab.locator('.fm-dc').boundingBox();
  assert.ok(Math.round(full.width)===390&&Math.round(full.height)===844,'the full menu, across the phone');
  // The More sheet has both entries.
  assert.deepEqual(await tab.locator('#mobilePlatformMoreMenu .ptb-more-item').allInnerTexts(),['Dev tray','Dev console']);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('dev tray in a phone browser: devicemotion opens it, the screenshot is drawn from the page; a desktop keeps the strip',async()=>{
 const browser=await launch();
 try{
  const {tab,errors,tracker}=await page(browser,{app:false});
  assert.equal(await tab.locator('.fm-dc-strip').isVisible(),false);
  // Ordinary handling: a bump and its rebound.
  await tab.evaluate(()=>{for(const [t,x] of [[0,30],[40,-18],[80,0]]){const e=new Event('devicemotion');Object.defineProperty(e,'acceleration',{value:{x,y:0,z:0}});Object.defineProperty(e,'timeStamp',{value:1000+t});window.dispatchEvent(e);}});
  await tab.waitForTimeout(250);
  assert.equal(await tab.locator('.fm-qt').isVisible(),false,'a bump does not open it');
  await tab.evaluate(()=>{for(let t=0;t<=600;t+=16){const e=new Event('devicemotion');Object.defineProperty(e,'acceleration',{value:{x:25*Math.sin(2*Math.PI*4*t/1000),y:0,z:0}});Object.defineProperty(e,'timeStamp',{value:5000+t});window.dispatchEvent(e);}});
  await tab.locator('.fm-qt.fm-qt-in').waitFor();
  await tab.fill('.fm-qt-signin [name=tracker-email]','jack@test');await tab.fill('.fm-qt-signin [name=tracker-password]','pw');await tab.click('.fm-qt-signin button');
  await tab.locator('.fm-qt-group').first().waitFor();
  await tab.click('.fm-qt-shot');
  await tab.locator('.fm-qt-thumb img').waitFor({timeout:15000});
  const size=await tab.evaluate(async()=>{const img=document.querySelector('.fm-qt-thumb img');await img.decode();return [img.naturalWidth,img.naturalHeight];});
  assert.ok(size[0]>=390&&size[1]>=844,'the whole screen: '+size);
  // The drawn page has the page's colour at the bottom, where the tray is: the tray is not in it.
  const bottom=await tab.evaluate(async()=>{const img=document.querySelector('.fm-qt-thumb img'),c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const g=c.getContext('2d');g.drawImage(img,0,0);return [...g.getImageData(10,img.naturalHeight-20,1,1).data].slice(0,3);});
  assert.ok(Math.abs(bottom[0]-0xe8)<8&&Math.abs(bottom[2]-0xff)<8,'page colour under the tray: '+bottom);
  await tab.fill('.fm-qt-text','Long note\nwith two lines');
  await tab.click('.fm-qt-compose .fm-qt-go');
  await tab.locator('.fm-dc-toast',{hasText:'Filed FM-9'}).waitFor();
  const created=JSON.parse(tracker.filter(c=>c.method==='POST'&&c.path==='/issues').at(-1).body.toString());
  assert.equal('title' in created,false,'a long note is titled by Tracker');
  assert.match(created.description,/^Long note\nwith two lines\n\n!\[Screenshot\]/);
  assert.deepEqual(errors,[]);
  // A desktop: the strip as before, no tray until asked.
  const desk=await page(browser,{width:1280,height:800,app:false});
  assert.equal(await desk.tab.locator('.fm-dc-strip').isVisible(),true);
  assert.equal(await desk.tab.locator('.fm-qt').isVisible(),false);
  assert.deepEqual(desk.errors,[]);
 }finally{await browser.close();}
});
