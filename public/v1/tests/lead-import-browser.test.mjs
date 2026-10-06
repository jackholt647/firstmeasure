import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('lead history filters sources, pages outcomes, opens projects and reviews uncertain deliveries on mobile',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],reviews=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://leads.test/**',async route=>{
   const url=new URL(route.request().url());let data;
   if(url.pathname.endsWith('/connections'))data={connections:[{id:'lead-source',name:'Google leads',leadSource:true,enabled:true},{id:'photos',name:'Photos',leadSource:false}]};
   else if(url.pathname.endsWith('/review')){reviews.push(route.request().postDataJSON());data={state:'dismissed'};}
   else if(url.pathname.endsWith('/deliveries'))data={items:url.searchParams.has('after')?[{id:'second',state:'rejected',source_id:'email:default',external_id:'second',updated_at:new Date().toISOString(),attempts:1}]:[{id:'first',state:reviews.length?'dismissed':'uncertain',source_id:'connection:'+('a'.repeat(100)),external_id:'lead-'+('x'.repeat(150)),project_id:'project-1',updated_at:new Date().toISOString(),attempts:2}],next:url.searchParams.has('after')?null:'cursor'};
   else return route.fulfill({contentType:'text/html',body:'<main id="root"></main>'});
   await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://leads.test/');
  await page.evaluate(()=>{window.PlatformAPI={appFlags:{has:()=>true}};window.FirstMateProjectWindows={open:project=>window.openedProject=project.id};});
  await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/settings/connections.js',import.meta.url),'utf8')});
  await page.evaluate(()=>window.FirstMateConnections.mountLeadSources(document.querySelector('#root'),{orgId:'org'}));
  await page.getByRole('button',{name:'Google leads · Active'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Photos'}).count(),0);
  await page.getByRole('button',{name:'Open project'}).click();assert.equal(await page.evaluate(()=>window.openedProject),'project-1');
  await page.getByRole('button',{name:'Load more'}).click();await page.getByText('rejected',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.getByLabel('Outcome').selectOption('dismissed');await page.getByLabel('Review note').fill('Checked the retained project; discard this delivery.');
  await page.getByRole('button',{name:'Save review'}).click();await page.getByText('dismissed',{exact:true}).waitFor();
  assert.equal(reviews[0].decision,'dismissed');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
