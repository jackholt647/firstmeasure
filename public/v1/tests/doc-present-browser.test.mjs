import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

async function open(browser){
 const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://present.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><style>html,body{margin:0;height:100%}#host{width:100vw;height:100vh}</style><div id="host"></div>'});
 });
 await page.goto('http://present.test/');
 for(const file of ['doc-model/firstmate-doc-model.js','doc-markdown/firstmate-markdown.js','doc-renderer/firstmate-doc-renderer.js','doc-present/firstmate-doc-present.js'])await page.addScriptTag({url:'/libraries/'+file});
 await page.evaluate(async()=>{
  const M=FMDocModel,doc=M.createDocument({kind:'document'});doc.settings.paper={size:{w_pt:960,h_pt:540}};
  const text=(id,name,x,y,value)=>M.createNode('text',{id,name,frame:{x,y,w:300,h:60},props:{blocks:[{type:'paragraph',runs:[{text:value}]}]}});
  const box=(id,name,x,y,w,h)=>M.createNode('shape',{id,name,frame:{x,y,w,h},props:{shape:'rect',fill:'#2563eb'}});
  doc.pages=[
   M.createPage('custom',{id:'p1',name:'Welcome',children:[text('t1','Title',60,60,'Welcome'),text('t2','Point one',60,160,'First point'),text('t3','Point two',60,240,'Second point')],
    steps:[{id:'s1',name:'First point',actions:[{node:'t2',effect:'rise'}]},{id:'s2',name:'Second point',actions:[{node:'t3',effect:'fade_in'},{node:'t2',effect:'dim'}]}]}),
   M.createPage('custom',{id:'p2',name:'Anatomy',transition:{type:'fade',duration_ms:200},children:[box('d1','Diagram',280,120,400,300)]}),
   M.createPage('custom',{id:'p3',name:'Shingles',transition:{type:'morph',duration_ms:300},children:[box('d2','Diagram',40,160,300,225),text('t9','Options',600,80,'Choose a shingle')]})
  ];
  window.moves=[];window.player=FMDocPresent.mount(document.querySelector('#host'),{document:doc,onNavigate:at=>moves.push(at.page+':'+at.step)});await player.ready();
 });
 return {page,errors};
}
const hidden=(page,id)=>page.evaluate(id=>document.querySelector(`[data-node-id="${id}"]`).hasAttribute('data-fmdp-hidden'),id);
const settled=(page,id)=>page.waitForFunction(id=>Array.from(document.querySelectorAll('.fmdoc-page[data-fmdp-on]')).map(el=>el.dataset.pageId).join(',')===id,id);
const visiblePage=page=>page.evaluate(()=>Array.from(document.querySelectorAll('.fmdoc-page[data-fmdp-on]')).map(el=>el.dataset.pageId).join(','));

test('a presentation shows one slide, plays steps in order and moves between slides',async()=>{
 const browser=await launch();try{
  const {page,errors}=await open(browser);
  assert.equal(await visiblePage(page),'p1');
  const stage=await page.locator('.fmdp-stage').boundingBox();
  assert.ok(Math.abs(stage.width-1280)<2&&Math.abs(stage.height-720)<2,'the slide fills a 16:9 window');
  assert.equal(await page.locator('.fmdoc-page').count(),3);
  assert.deepEqual([await hidden(page,'t1'),await hidden(page,'t2'),await hidden(page,'t3')],[false,true,true],'entrances start hidden');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual([await hidden(page,'t2'),await hidden(page,'t3')],[false,true]);
  await page.keyboard.press('ArrowRight');
  assert.equal(await hidden(page,'t3'),false);
  assert.equal(await page.evaluate(()=>document.querySelector('[data-node-id="t2"]').hasAttribute('data-fmdp-dim')),true,'a state effect stays');
  await page.keyboard.press('ArrowRight');await settled(page,'p2');
  await page.keyboard.press('ArrowRight');
  // Mid-morph the matched node is between its two places.
  await page.waitForTimeout(60);
  const mid=await page.evaluate(()=>document.querySelector('[data-node-id="d2"]').getBoundingClientRect().left);
  await settled(page,'p3');
  const end=await page.evaluate(()=>document.querySelector('[data-node-id="d2"]').getBoundingClientRect().left);
  assert.ok(mid>end+20,'the matching node travels from its old place: '+mid+' -> '+end);
  assert.equal(await visiblePage(page),'p3');
  await page.keyboard.press('ArrowLeft');await settled(page,'p2');
  await page.keyboard.press('ArrowLeft');await settled(page,'p1');
  assert.deepEqual(await page.evaluate(()=>player.position()),{page:0,step:2,pages:3,steps:2,page_id:'p1'},'going back lands on the finished slide');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await hidden(page,'t3'),true);
  // The bottom bar jumps to any step of any slide; the top bar appears at the top edge.
  assert.equal(await page.locator('.fmdp-seg').count(),3);
  assert.equal(await page.locator('.fmdp-seg').first().locator('i').count(),3);
  await page.mouse.move(640,4);
  await page.waitForFunction(()=>document.querySelector('.fmdp').dataset.controls==='on');
  await page.locator('[data-fmdp="next"]').click();
  assert.deepEqual(await page.evaluate(()=>[player.position().page,player.position().step]),[0,2]);
  await page.evaluate(()=>player.goTo(2,0,{animate:false}));
  assert.equal(await visiblePage(page),'p3');
  assert.equal(await page.evaluate(()=>moves.at(-1)),'2:0');
  if(process.env.PRESENT_SHOT)await page.screenshot({path:process.env.PRESENT_SHOT});
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('step state is computed without a DOM',async()=>{
 const {default:present}=await import('../../libraries/doc-present/firstmate-doc-present.js');
 const page={steps:[{actions:[{node:'a',effect:'fade_in'}]},{actions:[{node:'a',effect:'highlight'},{node:'b',effect:'fade_out'}]},{actions:[{node:'x',effect:'unknown'}]}]};
 assert.equal(present.pageSteps(page).length,2,'a step with no usable action is dropped');
 assert.deepEqual(present.stateAtStep(page,0),{a:{visible:false,highlight:false,dim:false},b:{visible:true,highlight:false,dim:false}});
 assert.deepEqual(present.stateAtStep(page,2),{a:{visible:true,highlight:true,dim:false},b:{visible:false,highlight:false,dim:false}});
 assert.equal(present.pageTransition({transition:{type:'spin'}}).type,'none');
});
