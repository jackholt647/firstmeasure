import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('partners workspace escapes external content, creates scoped grants and posts shared notes',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.route('https://partners.test/**',route=>route.fulfill({contentType:'text/html',body:'<main id="app"></main>'}));
    await page.goto('https://partners.test/');
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.evaluate(()=>{
      window.calls=[];
      const resource={owner_org_id:'other',type:'project',id:'roof'};
      const shared={resource,share_id:'share',revision:1,data:{title:'<img src=x onerror=alert(1)>',description:'Shared roof'},owner:{name:'Owner'},operations:['read','notes.read','notes.create']};
      window.Portal={cfg:{orgId:'local'},apps:{registerPortalApp:definition=>{window.app=definition;}}};
      window.PlatformAPI={request:async(url,options={})=>{
        const path=new URL(url).pathname.split('/local')[1];window.calls.push({path,method:options.method||'GET',body:options.body});
        if(path==='/partners')return {items:[{id:'relationship',recipient_org_id:'other',organization:{name:'Other Org'},connection:{id:'connection',status:'active',revision:1},classification:'partner'}]};
        if(path==='/shared')return {items:[shared]};
        if(path==='/sharing-options')return {items:[{resource:{owner_org_id:'local',type:'project',id:'own'},label:'Our roof'}],fields:['title','description','address'],operations:['read','details.update','photos.read']};
        if(path==='/resources/share-children')return {items:[]};
        if(path==='/shares')return {items:[]};
        if(path==='/resources/read')return shared;
        if(path==='/resources/notes/read')return {items:[{id:'note',text:'<script>alert(2)</script>',author:{name:'Partner'},created_at:'2026-09-30T00:00:00Z'}]};
        if(path==='/resources/notes')return {id:'posted'};
        throw new Error(`Unexpected request ${path}`);
      }};
    });
    await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/partners/app.js',import.meta.url),'utf8')});
    await page.evaluate(()=>window.app.mount(document.querySelector('#app')));
    await page.getByRole('button',{name:'Shared with us',exact:true}).click();
    await page.getByRole('button',{name:'Open',exact:true}).click();
    assert.equal(await page.locator('#app img').count(),0);
    await page.getByRole('button',{name:'Notes',exact:true}).click();
    assert.equal(await page.locator('#app script').count(),0);
    await page.locator('textarea[name=text]').fill('Roof is ready');
    await page.getByRole('button',{name:'Confirm',exact:true}).click();
    await page.waitForFunction(()=>window.calls.some(c=>c.path==='/resources/notes'));
    const posted=await page.evaluate(()=>window.calls.find(c=>c.path==='/resources/notes').body);
    assert.equal(posted.resource.owner_org_id,'other');
    assert.equal(posted.input.text,'Roof is ready');
    assert.ok(posted.input.client_operation_id);
    await page.getByRole('button',{name:'Share resource',exact:true}).click();
    await page.getByRole('button',{name:'Confirm',exact:true}).click();
    await page.locator('select[name=resource]').waitFor();
    await page.getByRole('button',{name:'Confirm',exact:true}).click();
    await page.locator('select[name=partner]').selectOption('other');
    await page.getByRole('button',{name:'Confirm',exact:true}).click();
    await page.waitForFunction(()=>window.calls.some(c=>c.path==='/shares'&&c.method==='POST'));
    const grant=await page.evaluate(()=>window.calls.find(c=>c.path==='/shares'&&c.method==='POST').body);
    assert.deepEqual(grant.operations,['read']);
    assert.equal(grant.include_future,false);
    assert.deepEqual(grant.fields,['title','description']);
    assert.equal(grant.recipient_org_id,'other');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
