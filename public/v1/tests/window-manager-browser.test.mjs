import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('window docking, swaps, edge previews and project fullscreen restriction',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1400,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<style>body{margin:0}main{position:relative;width:1400px;height:900px}#panels{height:100%}</style><main><div id="panels"></div></main>');
 await page.addScriptTag({content:await readFile(new URL('../../libraries/window-manager/window-manager.js',import.meta.url),'utf8')});
 await page.evaluate(()=>{window.make=(id)=>{const el=document.createElement('section');el.id=id;const header=document.createElement('header');header.textContent=id;header.style.height='48px';el.append(header);document.querySelector('main').append(el);return FirstMateWindows.attach({element:el,header,host:document.querySelector('main'),contentTarget:document.querySelector('#panels'),presentationModes:true,allowFullscreen:false,width:500,height:400,dockWidth:440,topInset:()=>50});};window.a=make('a');});
 const settled=()=>page.waitForTimeout(500);
 const rect=async(id)=>page.locator('#'+id).boundingBox();
 assert.equal(await page.locator('[data-window-action=fullscreen]').count(),0);
 await page.evaluate(()=>a.setMode('fullscreen'));assert.equal(await page.evaluate(()=>a.state.mode),'floating');
 await page.click('#a [data-window-action=place]');await settled();assert.equal((await rect('a')).x,960);
 await page.click('#a [data-window-action=place]');await settled();assert.equal((await rect('a')).x,0);
 assert.equal(await page.locator('#panels').evaluate(e=>e.getBoundingClientRect().x),440);
 await page.click('#a [data-window-action=place]',{button:'right'});
 assert.equal(await page.locator('.fm-window-menu hr').count(),1);
 await page.getByRole('menuitem',{name:'Dock top right',exact:true}).click();await settled();assert.equal((await rect('a')).height,425);
 await page.evaluate(()=>a.dock('right'));await settled();
 await page.locator('#a [data-resize=w]').dblclick();await settled();
 assert.equal((await rect('a')).x,0);assert.equal(Math.round((await rect('a')).width),960);
 await page.evaluate(()=>{a.dock('right');window.b=make('b');b.dock('right');});await settled();
 const beforeA=await rect('a'),beforeB=await rect('b');
 await page.locator('#a [data-resize=w]').dblclick();await settled();
 assert.equal(Math.round((await rect('a')).x),Math.round(beforeB.x));assert.equal(Math.round((await rect('b')).x),Math.round(beforeA.x));
 await page.evaluate(()=>{b.destroy();a.setMode('floating');});await settled();
 let r=await rect('a');await page.mouse.move(r.x+30,r.y+20);await page.mouse.down();await page.mouse.move(1395,400,{steps:5});
 assert.equal(await page.locator('.fm-window-preview').count(),1);assert.equal(await page.evaluate(()=>a.state.mode),'floating');
 await page.mouse.move(1395,60,{steps:3});await page.mouse.up();await settled();assert.equal(await page.evaluate(()=>a.state.dockSide),'top-right');
 await page.evaluate(()=>a.setMode('floating'));await settled();r=await rect('a');await page.mouse.move(r.x+30,r.y+20);await page.mouse.down();await page.mouse.move(5,400,{steps:4});assert.equal(await page.locator('.fm-window-preview').count(),1);await page.mouse.move(700,400,{steps:4});assert.equal(await page.locator('.fm-window-preview').count(),0);await page.mouse.up();assert.equal(await page.evaluate(()=>a.state.mode),'floating');
 for(const side of ['left','right','top-left','top-right','bottom-left','bottom-right','top','bottom']){await page.evaluate(side=>a.dock(side),side);await settled();const box=await rect('a');assert.ok(box.x>=0 && box.y>=50 && box.x+box.width<=1401 && box.y+box.height<=901,side);}
 await page.evaluate(()=>a.setMode('minimized'));await settled();await page.evaluate(()=>a.restore());assert.equal(await page.evaluate(()=>a.state.mode),'docked');
 assert.notEqual(await page.locator('#a').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
 await page.evaluate(()=>a.destroy());assert.equal(await page.locator('#panels').evaluate(e=>e.style.marginLeft),'');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});


test('docked header detaches under the pointer and expanded windows return to a usable float',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800}});
  await page.setContent('<style>body{margin:0}main{position:absolute;left:100px;width:1000px;height:800px}header{height:48px}</style><main><div id="panels"></div><section id="project"><header>Project</header></section></main>');
  await page.addScriptTag({content:await readFile(new URL('../../libraries/window-manager/window-manager.js',import.meta.url),'utf8')});
  await page.evaluate(()=>window.project=FirstMateWindows.attach({element:document.querySelector('#project'),header:document.querySelector('header'),host:document.querySelector('main'),contentTarget:document.querySelector('#panels'),mode:'full',presentationModes:true,width:1200,height:800,topInset:()=>40}));
  const settled=()=>page.waitForTimeout(500),rect=()=>page.locator('#project').boundingBox();
  await page.click('[data-window-action=floating]');await settled();let r=await rect();assert.equal(r.width,720);assert.equal(r.height,456);assert.ok(r.x>100 && r.y>40);
  await page.evaluate(()=>project.setMode('fullscreen'));await settled();await page.click('[data-window-action=floating]');await settled();assert.equal((await rect()).height,456);
  for(const side of ['right','left','top-right','bottom-left','top','bottom']){
   await page.evaluate(side=>project.dock(side),side);await settled();r=await rect();const x=r.x+Math.min(r.width*.3,120),y=r.y+20;
   await page.mouse.move(x,y);await page.mouse.down();assert.equal(await page.evaluate(()=>project.state.mode),'docked');
   await page.mouse.move(x,y);assert.equal(await page.evaluate(()=>project.state.mode),'docked');
   await page.mouse.move(620,220,{steps:4});assert.equal(await page.evaluate(()=>project.state.mode),'floating');
   const moved=await rect();assert.ok(620>=moved.x && 620<=moved.x+moved.width && Math.abs(moved.y+20-220)<1,'Detached header stays beneath pointer');
   await page.mouse.move(650,250,{steps:3});const follow=await rect();assert.ok(Math.abs(follow.y-moved.y-30)<1,'Dragging continues after detach');await page.mouse.up();assert.equal(await page.evaluate(()=>project.state.mode),'floating');
  }
  await page.evaluate(()=>project.dock('right'));await settled();r=await rect();await page.mouse.move(r.x+120,r.y+20);await page.mouse.down();await page.mouse.up();assert.equal(await page.evaluate(()=>project.state.mode),'docked');
  await page.evaluate(()=>project.destroy());
 }finally{await browser.close();}
});
