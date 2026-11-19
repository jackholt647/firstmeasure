import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// What drives setup (libraries/dev-console/sections/setup-drivers.js, GP-30): a guided setup's pages are folded under
// its title until opened; a folded page's lines end at the title, one line per question; "Open all" opens every setup.
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
const page=(id,title,requires=[])=>({id,title,requires,apps:[],apps_on:true,next:null,branches:[]});
const DATA={ok:true,
 company:{shown:'actual',actual:{company_type:'roofing_contractor',label:'Roofing contractor',industry:'roofing',industry_sets:[],services:[]},as_shown:{company_type:'roofing_contractor',label:'Roofing contractor',industry:'roofing',industry_sets:[],services:[]},
  types:[{id:'roofing_contractor',label:'Roofing contractor',industry:'roofing',industry_sets:[]}],sets:[],facts:['organization.company_type']},
 context:{assistant:true,finished:[]},
 questions:[{id:'company.type',title:'What kind of company are you?',scope:'organization',requires:[],depth:0,answered:true,may_answer:true,sets:['organization.company_type']},
  {id:'company.services',title:'What kind of work do you do?',scope:'organization',requires:['company.type'],depth:1,answered:false,may_answer:true,sets:[]}],
 setups:[{id:'documents.setup',title:'Set up your documents',kind:'modal',scope:'organization',group:'setup',apps:{capabilities:[],permissions:[]},requires:[],triggers:[{kind:'manual',on:'',when:null}],then:[],offered:true,apps_on:true,fits:true,when:null,
  variants:[{id:'default',weight:1,when:null,chosen:true,share:1,steps:['kind','presentation','prices'],content:[]}],
  pages:[page('kind','What do you want to make?'),page('presentation','How do you present a proposal?',['company.services']),page('prices','What do you charge?',['company.services'])]},
  {id:'equipment.setup',title:'Set up equipment',kind:'modal',scope:'organization',group:'setup',apps:{capabilities:[],permissions:[]},requires:[],triggers:[{kind:'manual',on:'',when:null}],then:[],offered:true,apps_on:true,fits:true,when:null,
  variants:[{id:'default',weight:1,when:null,chosen:true,share:1,steps:['add'],content:[]}],pages:[page('add','Add your equipment')]}],
 matrix:{columns:[],rows:[]}};

async function open(browser,{width,phone}){
 const tab=await browser.newPage({viewport:{width,height:800}}),errors=[];tab.on('pageerror',e=>errors.push(e.message));
 await tab.route('http://map.test/**',async route=>{const p=new URL(route.request().url()).pathname;
  if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.css')?'text/css':'application/javascript',body:await lib(p.replace(/^\/libraries\//,''))});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/libraries/dev-console/dev-console.css"><main>App</main>'});
 });
 await tab.goto('http://map.test/');
 await tab.evaluate(async([data,phone])=>{const esc=v=>String(v??'').replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
  (await import('/libraries/dev-console/sections/setup-drivers.js')).openDrivers({api:async()=>data,T:(_key,text)=>text,esc,phone:()=>phone});},[DATA,phone]);
 await tab.waitForSelector('[data-map-canvas] path[data-edge]',{state:'attached'});
 return {tab,errors};
}
// Each "asked first" line: where it ends, and the node it ends at.
const asks=tab=>tab.evaluate(()=>{const canvas=document.querySelector('[data-map-canvas]').getBoundingClientRect();
 return [...document.querySelectorAll('path[data-edge=asks]')].map(path=>{const end=path.getAttribute('d').split(' ').pop().split(',').map(Number);
  const at=[...document.querySelectorAll('[data-map-node]')].find(el=>{const r=el.getBoundingClientRect();return r.width&&Math.abs(r.left-canvas.left-end[0])<1&&Math.abs(r.top+r.height/2-canvas.top-end[1])<1;});
  return at?.dataset.mapNode||'nowhere';}).sort();});
const state=tab=>tab.evaluate(()=>[...document.querySelectorAll('.fm-dc-map-card[data-open]')].map(card=>({open:card.dataset.open,expanded:card.querySelector('[data-map-fold]').getAttribute('aria-expanded'),
 count:card.querySelector('[data-map-fold] small').textContent,pages:[...card.querySelectorAll('.fm-dc-map-p')].filter(el=>el.getClientRects().length).length})));

test('what drives setup: setups are folded by default, lines go to the title, and they open one by one or all at once',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  for(const view of [{width:1400,phone:false},{width:390,phone:true}]){
   const {tab,errors}=await open(browser,view);
   const at=`(${view.width} px)`;
   assert.deepEqual(await state(tab),[{open:'false',expanded:'false',count:'3',pages:0},{open:'false',expanded:'false',count:'1',pages:0}],`folded by default ${at}`);
   assert.deepEqual(await asks(tab),['s:documents.setup'],`two folded pages asked after one question: one line, to the title ${at}`);
   // Open one: its pages show and each draws its own line.
   await tab.click('[data-map-fold="documents.setup"]');
   assert.deepEqual((await state(tab)).map(card=>card.pages),[3,0],at);
   assert.equal(await tab.getAttribute('[data-map-fold="documents.setup"]','aria-expanded'),'true');
   assert.deepEqual(await asks(tab),['p:documents.setup:presentation','p:documents.setup:prices'],`opened pages are drawn to ${at}`);
   assert.equal(await tab.locator('.fm-dc-map-tip').isHidden(),true,'the fold is not a node: no tip');
   // A page can be tapped for its detail; folding it away lets go.
   await tab.click('[data-map-node="p:documents.setup:prices"]');
   assert.equal(await tab.locator('.fm-dc-map-tip').isVisible(),true);
   await tab.click('[data-map-fold="documents.setup"]');
   assert.equal(await tab.locator('.fm-dc-map-tip').isHidden(),true);
   assert.equal(await tab.evaluate(()=>document.querySelector('[data-map-canvas]').dataset.focus),undefined,'nothing stays lit for a page that folded away');
   // Open all, then fold all.
   await tab.click('[data-map-fold-all]');
   assert.deepEqual((await state(tab)).map(card=>card.pages),[3,1],at);
   assert.equal(await tab.getAttribute('[data-map-fold-all]','aria-pressed'),'true');
   await tab.click('[data-map-fold-all]');
   assert.deepEqual((await state(tab)).map(card=>card.pages),[0,0],at);
   // What is open stays open when the diagram is drawn again (another view, another kind of company).
   await tab.click('[data-map-fold="equipment.setup"]');
   await tab.click('[data-map-view="matrix"]');
   assert.equal(await tab.locator('[data-map-fold-all]').isHidden(),true,'nothing to fold in the matrix');
   await tab.click('[data-map-view="diagram"]');
   await tab.waitForSelector('[data-map-canvas] path[data-edge]',{state:'attached'});
   assert.deepEqual((await state(tab)).map(card=>card.open),['false','true'],at);
   await tab.click('[data-map-fold="equipment.setup"]');
   assert.deepEqual(errors,[]);
   await tab.close();
  }
 }finally{await browser.close();}
});
