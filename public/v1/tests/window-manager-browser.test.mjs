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
