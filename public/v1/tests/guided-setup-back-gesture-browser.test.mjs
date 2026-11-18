import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// The phone's back control in a setup sheet (FM-554): Android's back and iOS's swipe walk WebView history, so each step
// behind the one on screen is a history entry on the page's own URL (Portal.navigation.steps). A back press is the
// sheet's Back, never a route change, and the entries are gone once the sheet closes.
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
const LIBS=['navigation/portal-navigation.js','guided-experiences/guided-experiences.js','guided-experiences/guided-setup.js'];
const t=(key,text)=>({key,text});
const SETUP={id:'test.back_setup',version:1,kind:'modal',scope:'organization',title:t('gx_tb_title','Back test'),tab:'',replayable:true,
  steps:['One','Two','Three'].map((name,i)=>({id:'s'+i,widget:'pick',title:t('gx_tb_'+i,name),required:true})),
  completion:{action:null,screen:'none',say:[],then:[]},triggers:[],progress:null};

function server(){
  const state={events:[],completes:0};
  async function handle(route){
    const request=route.request(),url=new URL(request.url()),body=request.postDataBuffer()?JSON.parse(request.postDataBuffer().toString('utf8')):null;
    const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...data})});
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await lib(url.pathname.slice(11))});
    if(url.pathname==='/portal/')return route.fulfill({contentType:'text/html',body:PAGE});
    if(url.pathname.endsWith('/experiences'))return json({experiences:[SETUP],reveals:[],faqs:null});
    if(url.pathname.endsWith('/events')){state.events.push(body);return json({recorded:true});}
    if(url.pathname.endsWith('/complete')){state.completes++;return json({result:{}});}
    return route.fulfill({status:404,body:''});
  }
  return {state,handle};
}

const PAGE=`<!doctype html><html><head><style>body{margin:0;font:14px Arial}</style></head><body>
  <button id="start" type="button">Start setup</button>
  <script>window.__APP={userOrgId:'o',platformApiBase:'https://fm.test/v1/platform'};</script>
  ${LIBS.map(file=>`<script src="/libraries/${file}"></script>`).join('')}
  <script>
    window.routeApplies=[];
    Portal.navigation.registerHandler('test',{apply:(route,context)=>{window.routeApplies.push(context.source+':'+(route.tab||''));}});
    FirstMateGuidedSetup.registerWidget('pick',{render(el){el.innerHTML='<p>Pick something</p>';return {valid:()=>true};}});
    document.querySelector('#start').addEventListener('click',()=>{window.played=FirstMateGuides.play('test.back_setup',{replay:true});});
  </script></body></html>`;

const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const title=frame=>frame.evaluate(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent||'');
const at=(tab,text)=>tab.waitForFunction(text=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent===text,text);
const depth=tab=>tab.evaluate(()=>history.state?.fmSteps?.depth??0);
/** Waits for the history to settle (a pending go() lands) at `n` entries above the page. */
const settled=(tab,n)=>tab.waitForFunction(n=>(history.state?.fmSteps?.depth??0)===n,n);

async function open(browser){
  const srv=server(),tab=await browser.newPage({viewport:{width:390,height:800},hasTouch:true,isMobile:true}),errors=[];
  tab.on('pageerror',error=>errors.push(error.message));
  await tab.route('https://fm.test/**',route=>srv.handle(route).catch(()=>route.abort()));
  await tab.goto('https://fm.test/portal/?tab=scheduling');
  return {srv,tab,errors};
}

test('back walks the setup steps, the first step asks to leave, and closing leaves no entries behind',async()=>{
  const browser=await launch();
  try{
    const {tab,errors}=await open(browser);
    const before=await tab.evaluate(()=>history.length);
    await tab.click('#start');
    await at(tab,'One');
    // The first step has one entry: back from it leaves the setup, not the page.
    await settled(tab,1);
    await tab.click('[data-gxs=next]');
    await at(tab,'Two');
    await tab.waitForTimeout(300);
    await tab.click('[data-gxs=next]');
    await at(tab,'Three');
    await settled(tab,3);
    assert.equal(await tab.evaluate(()=>history.length),before+3);

    // The phone's back: the previous step, on the same URL, with no route applied.
    await tab.evaluate(()=>history.back());
    await at(tab,'Two');
    await settled(tab,2);
    assert.equal(await tab.evaluate(()=>location.search),'?tab=scheduling');
    // The sheet's own Back takes its entry off too, so the next back press is the step before.
    await tab.waitForTimeout(300);
    await tab.click('[data-gxs=back]');
    await at(tab,'One');
    await settled(tab,1);
    // Forward is not a way through a setup: it lands back where the sheet is.
    await tab.evaluate(()=>history.forward());
    await tab.waitForTimeout(300);
    await settled(tab,1);
    assert.equal(await title(tab),'One');

    // Back on the first step asks, as the X does; Keep going puts the entry back.
    await tab.evaluate(()=>history.back());
    await tab.waitForSelector('.gxs-ask');
    assert.equal(await title(tab),'One');
    await tab.click('.gxs-ask-box [data-gxs=keep]');
    await settled(tab,1);
    await tab.waitForSelector('.gxs-ask',{state:'detached'});
    // A back press with the question open is Keep going.
    await tab.click('[data-gxs=close]');
    await tab.waitForSelector('.gxs-ask');
    await tab.evaluate(()=>history.back());
    await tab.waitForSelector('.gxs-ask',{state:'detached'});
    assert.equal(await title(tab),'One');
    await tab.waitForTimeout(200);

    // Through to the last step and finished: every entry comes off before the setup's promise settles.
    await tab.click('[data-gxs=next]');
    await at(tab,'Two');
    await tab.waitForTimeout(300);
    await tab.click('[data-gxs=next]');
    await at(tab,'Three');
    await settled(tab,3);
    await tab.waitForTimeout(300);
    await tab.click('[data-gxs=next]');
    const outcome=await tab.evaluate(()=>window.played);
    assert.equal(outcome.status,'completed');
    assert.equal(await tab.evaluate(()=>document.querySelectorAll('.gxs').length),0);
    assert.equal(await depth(tab),0,'back on the page it opened on');
    assert.equal(await tab.evaluate(()=>!!history.state?.fmNavigation),true,'the page’s own entry, as it was');
    assert.deepEqual(await tab.evaluate(()=>window.routeApplies.filter(entry=>entry.startsWith('popstate'))),[],'no step pop re-applied the route');

    // An ordinary route entry still routes on back.
    await tab.evaluate(()=>Portal.navigation.push({tab:'crm'}));
    await tab.evaluate(()=>history.back());
    await tab.waitForFunction(()=>window.routeApplies.includes('popstate:scheduling'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('skipping the setup from a later step takes all its entries off',async()=>{
  const browser=await launch();
  try{
    const {tab,srv,errors}=await open(browser);
    await tab.click('#start');
    await at(tab,'One');
    await tab.click('[data-gxs=next]');
    await at(tab,'Two');
    await settled(tab,2);
    await tab.click('[data-gxs=close]');
    await tab.click('.gxs-ask-box [data-gxs=dismiss]');
    const outcome=await tab.evaluate(()=>window.played);
    assert.equal(outcome.status,'dismissed');
    assert.equal(await depth(tab),0);
    assert.ok(srv.state.events.some(event=>event.type==='dismiss'));
    // Back now leaves through the page's own history: nothing of the setup is left to step through.
    assert.equal(await tab.evaluate(()=>history.state?.fmSteps),undefined);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('steps(): a sheet over a sheet, and route entries pushed meanwhile carry no step mark',async()=>{
  const browser=await launch();
  try{
    const {tab,errors}=await open(browser);
    await tab.click('#start');
    await at(tab,'One');
    await tab.evaluate(()=>{
      window.innerBacks=[];
      window.inner=Portal.navigation.steps({onBack:count=>{window.innerBacks.push(count);window.inner.depth(0);}});
    });
    await tab.mouse.click(5,5);
    await tab.evaluate(()=>window.inner.depth(2));
    await settled(tab,2);
    // The newest sheet answers first.
    await tab.evaluate(()=>history.back());
    await tab.waitForFunction(()=>window.innerBacks.length===1);
    assert.equal(await title(tab),'One','the setup underneath did not move');
    await tab.evaluate(()=>window.inner.release());
    await settled(tab,1);
    // A route entry made while the setup is open is not one of its steps.
    await tab.evaluate(()=>Portal.navigation.push({tab:'crm'},{source:'test'}));
    assert.equal(await tab.evaluate(()=>history.state?.fmSteps),undefined);
    await tab.evaluate(()=>history.back());
    await tab.waitForFunction(()=>window.routeApplies.includes('popstate:scheduling'));
    assert.equal(await title(tab),'One');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
