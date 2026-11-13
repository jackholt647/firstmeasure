import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Touch in the document editor (FM-451), on its dev harness
// (libraries/doc-editor/dev-editor.html) on a touch screen (tablet-wide, so the
// harness rails leave a canvas) with real touch
// events: two fingers pinch-zoom and pan around the point between them, one
// finger never drags, and press-and-hold lifts what it then moves.
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const types={js:'application/javascript; charset=utf-8',html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml'};

async function open(browser){
 const context=await browser.newContext({viewport:{width:1100,height:820},hasTouch:true,isMobile:true});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://editor.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  try{return await route.fulfill({contentType:types[pathname.split('.').pop()]||'text/plain',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});}
  catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://editor.test/libraries/doc-editor/dev-editor.html');
 await page.waitForFunction(()=>window.editor&&document.querySelector('.fmde-stage .fmdoc-page'));
 const cdp=await context.newCDPSession(page);
 const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],id)=>({x,y,id,radiusX:2,radiusY:2,force:1}))});
 const gesture=async(from,to,{hold=0,steps=10}={})=>{
  await touch('touchStart',from);
  if(hold)await page.waitForTimeout(hold);
  for(let s=1;s<=steps;s++){const t=s/steps;await touch('touchMove',from.map(([x,y],i)=>[x+(to[i][0]-x)*t,y+(to[i][1]-y)*t]));await page.waitForTimeout(16);}
  await touch('touchEnd',[]);
  await page.waitForTimeout(200);
 };
 return {page,errors,touch,gesture};
}
const pageRect=page=>page.evaluate(()=>{const r=document.querySelector('.fmde-stage .fmdoc-page').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};});
// A top-level element in the middle of the visible canvas, with its frame.
const pickElement=page=>page.evaluate(()=>{
 const canvas=document.querySelector('.fmde-canvas').getBoundingClientRect();
 const doc=editor.getDocument(),frames=new Map();
 for(const p of doc.pages)for(const node of p.children||[])if(node.frame&&node.locked!==true)frames.set(node.id,node.frame);
 for(const el of document.querySelectorAll('.fmde-stage .fmdoc-page [data-node-id]')){
  const id=el.getAttribute('data-node-id'),r=el.getBoundingClientRect();
  if(!frames.has(id)||r.width<24||r.height<14||r.top<canvas.top+10||r.bottom>canvas.bottom-10||r.left<canvas.left||r.right>canvas.right)continue;
  const x=r.left+Math.min(12,r.width/2),y=r.top+Math.min(8,r.height/2);
  if(!el.contains(document.elementFromPoint(x,y))&&!document.elementFromPoint(x,y)?.closest('.fmde-overlay'))continue;
  return {id,x,y};
 }
 return null;
});
const frameOf=(page,id)=>page.evaluate(id=>{let found=null;for(const p of editor.getDocument().pages)for(const node of p.children||[])if(node.id===id)found=node.frame;return found&&{x:found.x,y:found.y};},id);

test('two fingers pinch-zoom around the point between them and pan; one finger does not scroll',async()=>{
 const browser=await launch();try{
  const {page,errors,gesture}=await open(browser);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.fmde-canvas')).touchAction),'none','the canvas takes no native panning on a touch screen');
  const zoom0=await page.evaluate(()=>editor.zoom()),before=await pageRect(page);
  const canvas=await page.locator('.fmde-canvas').boundingBox();
  const mid={x:Math.round(canvas.x+canvas.width/2),y:Math.round(canvas.y+canvas.height/2)};
  const fx=(mid.x-before.left)/before.width,fy=(mid.y-before.top)/before.height;
  await gesture([[mid.x-30,mid.y],[mid.x+30,mid.y]],[[mid.x-90,mid.y],[mid.x+90,mid.y]]);
  const zoom1=await page.evaluate(()=>editor.zoom()),after=await pageRect(page);
  assert.ok(Math.abs(zoom1/zoom0-3)<0.15,`pinching three times wider zooms about 3x (${zoom0} -> ${zoom1})`);
  assert.ok(Math.abs(after.left+fx*after.width-mid.x)<6&&Math.abs(after.top+fy*after.height-mid.y)<6,'the spot between the fingers stays under them');
  const scrolled=await page.evaluate(()=>document.querySelector('.fmde-canvas').scrollTop);
  await gesture([[mid.x-40,mid.y+100],[mid.x+40,mid.y+100]],[[mid.x-40,mid.y-50],[mid.x+40,mid.y-50]]);
  const panned=await page.evaluate(()=>document.querySelector('.fmde-canvas').scrollTop);
  assert.ok(Math.abs(panned-scrolled-150)<6,`two fingers moved up 150px scroll the page 150px (${scrolled} -> ${panned})`);
  assert.equal(await page.evaluate(()=>editor.zoom()),zoom1,'moving without spreading keeps the zoom');
  await gesture([[mid.x+20,mid.y+150]],[[mid.x+20,mid.y-150]]);
  assert.equal(await page.evaluate(()=>document.querySelector('.fmde-canvas').scrollTop),panned,'one finger does not scroll');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('one finger selects without dragging; press and hold lifts the element, then dragging moves it',async()=>{
 const browser=await launch();try{
  const {page,errors,touch,gesture}=await open(browser);
  const pick=await pickElement(page);
  assert.ok(pick,'an element is in view');
  const start=await frameOf(page,pick.id);
  await gesture([[pick.x,pick.y]],[[pick.x+50,pick.y+60]]);
  assert.deepEqual(await frameOf(page,pick.id),start,'a quick one-finger drag moves nothing');
  assert.ok((await page.evaluate(()=>editor.selection())).includes(pick.id),'but the touch selected it');
  await touch('touchStart',[[pick.x,pick.y]]);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(()=>document.querySelector('.fmde-root').classList.contains('fmde-touch-lifted')),true,'held still, it lifts');
  assert.equal(await page.locator('.fmde-lifted-node').count(),1,'and the element shows it is picked up');
  for(let s=1;s<=10;s++){await touch('touchMove',[[pick.x+4*s,pick.y+6*s]]);await page.waitForTimeout(16);}
  await touch('touchEnd',[]);
  await page.waitForTimeout(300);
  const moved=await frameOf(page,pick.id);
  assert.ok(moved.x>start.x+10&&moved.y>start.y+20,`then the drag moves it (${JSON.stringify(start)} -> ${JSON.stringify(moved)})`);
  assert.equal(await page.evaluate(()=>document.querySelector('.fmde-root').classList.contains('fmde-touch-lifted')),false,'and dropping it puts it down');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
