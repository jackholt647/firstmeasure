import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
const require=createRequire(import.meta.url);
const publicRoot=path.resolve(import.meta.dirname,'../..');
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('a customer opens a presentation link, chooses, and its sign button takes them to sign',async()=>{
 const deck=require('../../libraries/doc-present/templates/roofing-presentation.js');
 const layout=deck.build();
 // The server's shape for the same sample estimate.
 const serverState=(revision,sample)=>({id:'pres_1',revision,access:'choose',frozen:false,name:'Roof',org:{name:'Summit Roofing',colors:{primary:'#d93025'}},layout,widgetData:{},
  offered:{groups:sample.groups.map(g=>({id:g.id,label:g.title,options:g.options.map(o=>({...o,offered:true}))})),optional:sample.addons,variants:[]},
  pricing:{totals:{subtotal_cents:sample.totals.total_cents,tax_cents:0,total_cents:sample.totals.total_cents},schedule:[{label:'Deposit',amount_cents:sample.totals.deposit_cents,due_rule:'on_signature'}]}});
 let sample=deck.priceSample(deck.sampleState()),revision=3;const calls=[];
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://portal.test/**',async route=>{const url=new URL(route.request().url()),p=url.pathname;
   if(p.startsWith('/v1/document-modules/public/presentations/')){
    assert.ok(p.includes('/tok_abc'),'the token from the fragment addresses the API');
    const body=route.request().postDataJSON?.()||null;calls.push(route.request().method()+' '+p.split('/tok_abc')[1]);
    if(p.endsWith('/inputs')){assert.equal(body.expectedRevision,revision);
     const group=sample.groups.find(g=>g.id===body.value.group_id);group.options.forEach(o=>{o.selected=o.id===body.value.item_id;});sample=deck.priceSample(sample);revision+=1;}
    if(p.endsWith('/submit'))return route.fulfill({contentType:'application/json',body:JSON.stringify({presentation:serverState(revision,sample),signing:{portalUrl:'http://portal.test/sign-here'},signTarget:null})});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({presentation:serverState(revision,sample)})});}
   if(p==='/sign-here')return route.fulfill({contentType:'text/html',body:'<h1 id="sign">Sign</h1>'});
   try{return route.fulfill({contentType:p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.css')?'text/css':'application/javascript; charset=utf-8',body:await readFile(path.join(publicRoot,p))});}catch{return route.fulfill({status:404,body:''});}});
  await page.goto('http://portal.test/customer_portal/presentation.html#tok_abc');
  await page.waitForFunction(()=>window.presentation);await page.evaluate(()=>presentation.ready());
  assert.equal(await page.title(),'Summit Roofing — Roof');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.fmdoc-root')).getPropertyValue('--fm-primary').trim()),'#d93025','the company color');
  await page.evaluate(()=>presentation.goTo(4,'end',{animate:false}));
  const before=sample.totals.total_cents;
  await page.locator('.fmdoc-page[data-fmdp-on] [data-part-assembly="asm_shingles"][data-part-role="option"]').nth(2).click();
  await page.waitForFunction(total=>presentation.state().totals.total_cents!==total,before);
  assert.equal(await page.evaluate(()=>presentation.state().totals.total_cents),sample.totals.total_cents,'the price is the server\'s');
  await page.evaluate(()=>presentation.goTo(9,'end',{animate:false}));
  await page.locator('.fmdoc-page[data-fmdp-on] [data-node-id="sign_accept"]').click();
  await page.waitForSelector('#sign');
  assert.deepEqual(calls,['GET ','PATCH /inputs','POST /submit']);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
