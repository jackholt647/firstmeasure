const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('Speed panel collects nested timings, freezes captures, copies JSON, and leaves General intact',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html',body:'<section id="wall-panel"><button id="existing">Existing control</button></section>'}));
 await page.goto('http://localhost/');
 await page.evaluate(()=>{window.WallMode={enabled:true};window.clock=100;Object.defineProperty(performance,'now',{value:()=>window.clock});Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied=text}});});
 await page.addScriptTag({path:'public/measure/internal/editor_scripts/exterior_performance.js'});
 await page.evaluate(()=>ExteriorPerf.mount(document.getElementById('wall-panel')));
 assert.equal(await page.locator('#existing').isVisible(),true);
 assert.equal(await page.evaluate(()=>ExteriorPerf.measure('off',()=>42)),42);
 await page.getByRole('tab',{name:'Speed',exact:true}).click();
 assert.equal(await page.locator('#existing').isVisible(),false);
 const result=await page.evaluate(()=>{
  ExteriorPerf.frame(clock);clock+=16;ExteriorPerf.frame(clock);
  const value=ExteriorPerf.measure('outer',()=>{clock+=5;ExteriorPerf.measure('inner',()=>{clock+=20;});clock+=10;return 7;});
  try{ExteriorPerf.measure('throw',()=>{clock+=2;throw Error('expected');});}catch(e){}
  ExteriorPerf.measure('after throw',()=>{clock+=3;});
  ExteriorPerf.rendered({render:{calls:12,triangles:300},memory:{geometries:9,textures:2}});
  return {value,data:ExteriorPerf.snapshot()};
 });
 assert.equal(result.value,7);const outer=result.data.capture.find(x=>x.name==='outer');assert.equal(outer.total,35);assert.equal(outer.self,15);assert.equal(result.data.capture.find(x=>x.name==='after throw').self,3);assert.equal(result.data.fps,62.5);assert.equal(result.data.drawInfo.triangles,300);
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await page.evaluate(()=>{clock+=10000;ExteriorPerf.measure('paused',()=>{clock+=9;});});
 await page.getByRole('button',{name:'Copy',exact:true}).click();
 const copied=await page.evaluate(()=>JSON.parse(window.copied.split('\n').slice(1).join('\n')));
 assert.equal(copied.capture.some(x=>x.name==='paused'),false);assert.equal(copied.capture.find(x=>x.name==='outer').total,35);assert.equal(copied.rolling.length,4);
 await page.getByRole('button',{name:'Reset',exact:true}).click();assert.equal(await page.evaluate(()=>ExteriorPerf.snapshot().capture.length),0);
 await page.getByRole('button',{name:'Resume',exact:true}).click();
 await page.evaluate(()=>{for(let i=0;i<1000;i++){clock+=16;ExteriorPerf.frame(clock);}ExteriorPerf.measure('old',()=>clock+=2);clock+=6000;});
 assert.equal(await page.evaluate(()=>ExteriorPerf.snapshot().rolling.length),0);
 await page.getByRole('tab',{name:'General',exact:true}).click();assert.equal(await page.locator('#existing').isVisible(),true);assert.equal(await page.evaluate(()=>ExteriorPerf.enabled),false);
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
