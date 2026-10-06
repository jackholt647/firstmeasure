import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('desktop header reserves a second row only for rendered navigation',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.setContent('<section id="window"><header><div id="identity">New Report</div><nav id="tabs" class="single-tab"><button>Map</button></nav><nav class="fm-project-tray-tabs"></nav></header></section>');
  await page.addScriptTag({content:await readFile(new URL('../../libraries/window-manager/window-shell.js',import.meta.url),'utf8')});
  await page.evaluate(()=>FirstMateWindowShell.mount({element:document.querySelector('section'),header:document.querySelector('header'),identity:document.querySelector('#identity'),tabs:document.querySelector('#tabs'),headerRows:2}));
  const height=()=>page.locator('header').evaluate(e=>e.clientHeight);
  assert.equal(await height(),36);
  await page.locator('#tabs').evaluate(e=>e.classList.remove('single-tab'));
  assert.equal(await height(),68,'even one rendered tab keeps the second row');
  await page.locator('#tabs').evaluate(e=>e.hidden=true);
  assert.equal(await height(),36);
  await page.locator('.fm-project-tray-tabs').evaluate(e=>e.innerHTML='<button>Notes</button>');
  assert.equal(await height(),66,'visible tray navigation also needs its row');
  await page.locator('.fm-project-tray-tabs').evaluate(e=>e.replaceChildren());
  await page.locator('#tabs').evaluate(e=>{e.hidden=false;e.replaceChildren();});
  assert.equal(await height(),36,'an empty navigation container reserves no space');
  await page.locator('header').evaluate(e=>e.dataset.windowMobile='true');
  assert.equal(await height(),60,'mobile keeps its touch-sized identity row');
 }finally{await browser.close();}
});
