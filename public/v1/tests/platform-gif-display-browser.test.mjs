import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const publicRoot=new URL('../../',import.meta.url);
test('Platform GIF display and drafts work without Channels or an app API',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'}),page=await browser.newPage();
 try{
  await page.route('http://gif-widget.test/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.startsWith('/libraries/')||path.startsWith('/images/'))return route.fulfill({contentType:path.endsWith('.png')?'image/png':'text/javascript; charset=utf-8',body:process.env.DEV_ASSETS?Buffer.from(await(await fetch('https://dev.1m8.ai'+path+'?shared-gif='+Date.now())).arrayBuffer()):await readFile(new URL(path.slice(1),publicRoot))});return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:20px;font-family:Arial"><div id="host" style="width:240px"></div></body></html>'});});
  await page.route('https://media.giphy.com/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="112"><rect width="200" height="112" fill="#5c6983"/></svg>'}));
  await page.goto('http://gif-widget.test/');await page.addScriptTag({url:'/libraries/platform-widgets/gifs.js'});
  await page.evaluate(()=>{window.gif={id:'id/?',url:'https://media.giphy.com/media/fixture/giphy.gif',title:'<script>unsafe</script>',width:200,height:112};window.handle=FirstMateGifWidgets.mount(document.querySelector('#host'),{gif});});
  assert.equal(await page.evaluate(()=>typeof FirstMateChannels),'undefined');assert.equal(await page.evaluate(()=>typeof ChannelsAPI),'undefined');
  await page.locator('figcaption img').evaluate(image=>image.decode());assert.equal(await page.locator('figcaption img').getAttribute('alt'),'Powered by GIPHY');assert.equal(await page.locator('figcaption img').evaluate(image=>image.getBoundingClientRect().width),35);
  const overlay=await page.locator('figure').evaluate(node=>{const image=node.querySelector('a>img').getBoundingClientRect(),caption=node.querySelector('figcaption').getBoundingClientRect();return {right:image.right-caption.right,bottom:image.bottom-caption.bottom};});assert.equal(overlay.right,3);assert.equal(overlay.bottom,3);
  assert.equal(await page.locator('figure a').getAttribute('href'),'https://giphy.com/gifs/id%2F%3F');assert.equal(await page.locator('figure script').count(),0);assert.equal(await page.locator('figure a>img').getAttribute('alt'),'<script>unsafe</script>');
  assert.equal(await page.evaluate(()=>['javascript:alert(1)','http://media.giphy.com/media/a','https://evil.test/media/a','https://media.giphy.com.evil.test/media/a'].every(url=>FirstMateGifWidgets.createCard({...gif,url})===null)),true);
  await page.evaluate(()=>{handle.update(null);window.removed=0;FirstMateGifWidgets.renderDraft(document.querySelector('#host'),gif,()=>{removed++;handle.update(null);});});await page.getByRole('button',{name:'Remove GIF'}).click();assert.equal(await page.evaluate(()=>removed),1);assert.equal(await page.locator('#host figure').count(),0);
  await page.evaluate(()=>{handle.update(gif);handle.destroy();handle.update(gif);});assert.equal(await page.locator('#host figure').count(),0);assert.equal(await page.locator('#fm-gif-widget-styles').count(),1);
 }finally{await browser.close();}
});
