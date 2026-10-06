import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('development fullscreen and scope-filtered nested contracts fit desktop and mobile',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://development.test/**',async route=>{const p=new URL(route.request().url()).pathname;
   if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.css')?'text/css':'application/javascript',body:await readFile(new URL('../../libraries/'+p.slice(11),import.meta.url),'utf8')});
   return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px Arial,sans-serif}#platformTopbar{height:50px;display:flex}</style><header id="platformTopbar"><div id="platformAssistantSlot"></div></header>'});
  });
  await page.goto('http://development.test');
  await page.evaluate(()=>{window.PlatformAPI={request:async url=>url.includes('software-layers')?{items:[{id:'projects.profile',layer:'data',origin:'Projects',declarationScope:'global',scopes:['project'],details:{schema:{type:'object',properties:{address:{type:'object',properties:{city:{type:'string'}}}}}}},{id:'custom-fields-project.roof',layer:'data',origin:'Custom fields',declarationScope:'organization',scopes:['project'],details:{schema:{type:'number'}}},{id:'doc.audio',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}},{id:'doc.video',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}},{id:'doc.media.gallery',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}}],projects:[{id:'project',label:'Roof project'}],notes:['Declarations only.']}:{companies:[{id:'roofing',label:'Roofing'}],categories:[{id:'projects',label:'Projects',icon:'fa-house'}]}};});
  await page.evaluate(async()=>{await(await import('/libraries/development-tools/development-tools.js')).mount();});
  await page.getByRole('button',{name:'Development tools',exact:true}).click();await page.getByRole('button',{name:'Software layers',exact:true}).click();await page.getByText('5 of 5 declarations',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Expand development tools',exact:true}).click();assert.ok(await page.locator('.fm-dev-window').evaluate(el=>el.getBoundingClientRect().width>innerWidth-30));
  assert.equal(await page.locator('[data-namespace="doc"]').count(),1);
  assert.equal(await page.getByText('doc.audio',{exact:true}).count(),0);
  await page.locator('[data-namespace="doc"]>summary').click();await page.getByText('doc.audio',{exact:true}).waitFor();
  assert.equal(await page.getByText('doc.media.gallery',{exact:true}).count(),0);
  await page.locator('[data-namespace="doc.media"]>summary').click();await page.getByText('doc.media.gallery',{exact:true}).waitFor();
  await page.locator('[data-namespace="projects"]>summary').click();
  await page.locator('[data-namespace="projects"] .fm-dev-layer-row>summary').click();await page.getByText('schema {2}',{exact:true}).click();await page.getByText('properties {1}',{exact:true}).click();await page.getByText('address {2}',{exact:true}).waitFor();
  const family=await page.locator('body').evaluate(el=>getComputedStyle(el).fontFamily);
  for(const selector of ['.fm-dev-tabs button','[data-layer]','[data-search]','.fm-dev-layer-contract','.fm-dev-json summary','.fm-dev-expand','[data-dev-generate]'])assert.equal(await page.locator(selector).first().evaluate(el=>getComputedStyle(el).fontFamily),family,selector);
  await page.locator('[data-search]').fill('city');assert.equal(await page.locator('.fm-dev-namespace').count(),1);await page.locator('[data-search]').fill('');await page.locator('[data-scope]').selectOption('organization');assert.equal(await page.locator('.fm-dev-namespace').count(),1);
  await page.locator('[data-project]').selectOption('project');await page.getByText('1 of 5 declarations',{exact:true}).waitFor();await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('.fm-dev-window').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
  await page.getByRole('button',{name:'Synthetic data',exact:true}).click();await page.locator('[data-dev-generate]').waitFor({state:'visible'});await page.keyboard.press('Escape');assert.equal(await page.locator('.fm-dev-window').isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

