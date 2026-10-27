import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const source=await readFile(new URL('../../libraries/markup/firstmate-markup.js',import.meta.url),'utf8');
async function fixture(browser,touch=false){
 const page=await browser.newPage({viewport:{width:1000,height:800},hasTouch:touch,isMobile:touch});
 await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1">');
 await page.evaluate(()=>{window.Portal={util:{injectCSS:(id,css)=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);}}};});
 await page.addScriptTag({content:source});
 await page.evaluate(()=>{FirstMateMarkup.openPhotoViewer({photos:[]});document.querySelectorAll('.fm-photo-modal').forEach(node=>node.remove());const root=document.createElement('div');root.className='fm-photo-modal';root.style.cssText='inset:0;display:block';root.innerHTML='<div id="stage" style="position:absolute;left:50px;top:50px;width:800px;height:600px"></div>';document.body.append(root);window.markup=new FirstMateMarkup.PhotoMarkup(document.querySelector('#stage'));markup.setActive(true);markup.tool='text';});
 return page;
}
test('text boxes click wider, drag in either direction, resize independently and retain typed dimensions',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await fixture(browser);
 await page.mouse.click(150,150);
 assert.equal(await page.evaluate(()=>markup.items[0].width),.36);
 await page.keyboard.type('A note');
 assert.equal(await page.evaluate(()=>markup.items[0].text),'A note');
 await page.mouse.move(450,280);await page.mouse.down();await page.mouse.move(650,420,{steps:8});await page.mouse.up();
 let item=await page.evaluate(()=>markup.items[1]);assert.ok(Math.abs(item.width-.25)<.002);assert.ok(Math.abs(item.height-140/600)<.002);
 await page.keyboard.type('Sized note');assert.equal(await page.evaluate(()=>markup.items[1].text),'Sized note');
 const original=await page.evaluate(()=>({...markup.items[1]}));
 await page.locator('.fm-photo-markup-text').nth(1).hover();
 let handle=page.locator('[data-markup-handle="text-size"]').nth(1);let box=await handle.boundingBox();
 await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x+90,box.y-30,{steps:8});await page.mouse.up();
 item=await page.evaluate(()=>markup.items[1]);assert.ok(item.width>original.width+.09);assert.ok(item.height<original.height-.05);assert.equal(item.fontPx,original.fontPx);
 const resized={width:item.width,height:item.height};
 await page.locator('.fm-photo-markup-text').nth(1).click();await page.keyboard.type(' more words');
 assert.deepEqual(await page.evaluate(()=>({width:markup.items[1].width,height:markup.items[1].height})),resized);
 await page.mouse.move(700,600);await page.mouse.down();await page.mouse.move(550,500,{steps:8});await page.mouse.up();
 item=await page.evaluate(()=>markup.items[2]);assert.ok(Math.abs(item.x-.625)<.002);assert.ok(Math.abs(item.width-.1875)<.002);
 }finally{await browser.close();}
});
test('text controls reveal on hover or touch focus, delete is undoable, and Done hides controls',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{for(const touch of [false,true]){
 const page=await fixture(browser,touch);await page.mouse.click(200,200);await page.keyboard.type('Keep or delete');
 const text=page.locator('.fm-photo-markup-text'),remove=page.locator('[data-markup-delete]');
 if(!touch){await page.mouse.move(10,10);assert.equal(await remove.isVisible(),false);await text.hover();}
 else await text.tap();
 assert.ok(await remove.isVisible());await remove.click();assert.equal(await text.count(),0);
 await page.evaluate(()=>markup.undo());assert.equal(await text.count(),1);assert.equal(await text.textContent(),'Keep or delete');
 await page.evaluate(()=>markup.setActive(false));assert.equal(await remove.isVisible(),false);
 await page.close();
 }}finally{await browser.close();}
});

test('hover formatting tag changes text style and size without resizing, with undo',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await fixture(browser);await page.mouse.click(200,200);await page.keyboard.type('Format this');
 await page.mouse.move(10,10);const tag=page.locator('[data-markup-format]');assert.equal(await tag.isVisible(),false);
 await page.locator('.fm-photo-markup-text').hover();assert.ok(await tag.isVisible());
 const before=await page.evaluate(()=>({...markup.items[0]}));
 await tag.getByRole('button',{name:'Bold',exact:true}).click();
 assert.equal(await page.locator('.fm-photo-markup-text').evaluate(el=>getComputedStyle(el).fontWeight),'400');
 await tag.getByRole('button',{name:'Italic',exact:true}).click();
 assert.equal(await page.locator('.fm-photo-markup-text').evaluate(el=>getComputedStyle(el).fontStyle),'italic');
 await tag.getByRole('spinbutton',{name:'Text size'}).fill('32');await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>markup.items[0].fontPx),32);
 assert.deepEqual(await page.evaluate(()=>[markup.items[0].width,markup.items[0].height]),[before.width,before.height]);
 await page.evaluate(()=>markup.undo());assert.equal(await page.evaluate(()=>markup.items[0].fontPx),before.fontPx);
 await page.mouse.move(10,10);assert.equal(await tag.isVisible(),false);
 await page.evaluate(()=>markup.setActive(false));assert.equal(await tag.isVisible(),false);
 }finally{await browser.close();}
});
