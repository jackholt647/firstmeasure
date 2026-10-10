import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
test('image viewer zooms at the cursor, pans, fits and retains state across visibility changes',async()=>{
 const source=await readFile(new URL('../../libraries/image-viewer/image-viewer.js',import.meta.url),'utf8');
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/viewer.js'?'text/javascript':req.url==='/image.svg'?'image/svg+xml':'text/html');res.end(req.url==='/viewer.js'?source:req.url==='/image.svg'?'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="green"/></svg>':'<div id="root" style="width:600px;height:500px"></div>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async()=>{const {mount}=await import('/viewer.js');window.viewer=mount(document.querySelector('#root'),{url:'/image.svg',alt:'Aerial view'});});
  await page.locator('.fm-image-status').waitFor({state:'detached'});const canvas=page.locator('.fm-image-canvas');const r=await canvas.boundingBox();
  await page.mouse.move(r.x+r.width*.65,r.y+r.height*.65);await page.mouse.wheel(0,-200);await page.waitForTimeout(80);
  const zoomed=await page.evaluate(()=>viewer.serialize());assert.ok(zoomed.zoom>1);assert.ok(zoomed.x<0&&zoomed.y<0);
  await page.mouse.down();await page.mouse.move(r.x+r.width*.65+45,r.y+r.height*.65+35);await page.mouse.up();
  const panned=await page.evaluate(()=>viewer.serialize());assert.ok(panned.x>zoomed.x);assert.ok(panned.y>zoomed.y);
  await page.evaluate(()=>{document.querySelector('#root').hidden=true;viewer.setVisible(false);document.querySelector('#root').hidden=false;viewer.setVisible(true);});assert.deepEqual(await page.evaluate(()=>viewer.serialize()),panned);
  await page.getByRole('button',{name:'Fit image',exact:true}).click();assert.deepEqual(await page.evaluate(()=>viewer.serialize()),{zoom:1,x:0,y:0});
  await canvas.focus();await page.keyboard.press('+');assert.ok((await page.evaluate(()=>viewer.serialize())).zoom>1);await page.keyboard.press('0');assert.equal((await page.evaluate(()=>viewer.serialize())).zoom,1);
  await page.evaluate(()=>viewer.destroy());assert.equal(await page.locator('.fm-image-viewer').count(),0);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
