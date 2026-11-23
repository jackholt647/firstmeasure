import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Editing a setup live (docs/architecture/guided-experiences.md, "Editing a setup live"): an agent's hot-edit signal
// shows the working spinner beside the X; a changed step module is imported again and the step redrawn in place with
// the state it handed over; when the signal goes away the definition is read again and the step redrawn. No reload.
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
const LIBS=['navigation/portal-navigation.js','guided-experiences/guided-experiences.js','guided-experiences/guided-setup.js'];
const t=(key,text)=>({key,text});
const setup=(title)=>({id:'test.hot_setup',version:1,kind:'modal',scope:'organization',title:t('gx_th_title','Hot test'),tab:'',replayable:true,
  steps:[{id:'flow',widget:'module',module:'/libraries/test/hot-step.js',title:t('gx_th_step',title),required:false}],
  completion:{action:null,screen:'none',say:[],then:[]},triggers:[],progress:null});
// Version 1 counts taps and hands the count over; version 2 shows what it was handed. Each injects its own style.
const MODULE=(version)=>`
  export function mount(el,ctx){
    if(!document.getElementById('hot-step-css')){const s=document.createElement('style');s.id='hot-step-css';s.textContent='.hot-v{color:${version===1?'rgb(1, 1, 1)':'rgb(2, 2, 2)'}}';document.head.append(s);}
    let n=Number(ctx.hot?.n)||0;
    el.innerHTML='<p class="hot-v" data-version="${version}">v${version} n='+n+'</p><button type="button" id="tap">tap</button>';
    el.querySelector('#tap').onclick=()=>{n+=1;el.querySelector('.hot-v').textContent='v${version} n='+n;};
    return {valid:()=>true,hotState:()=>({n})};
  }`;

function server(){
  const state={version:1,title:'First title',signal:null};
  async function handle(route){
    const url=new URL(route.request().url());
    const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...data})});
    if(url.pathname==='/libraries/test/hot-step.js')return route.fulfill({contentType:'text/javascript',body:MODULE(state.version)});
    if(url.pathname==='/libraries/hot-edits/test.hot_setup.json')return state.signal?route.fulfill({contentType:'application/json',body:JSON.stringify(state.signal)}):route.fulfill({status:404,body:''});
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await lib(url.pathname.slice(11))});
    if(url.pathname==='/portal/')return route.fulfill({contentType:'text/html',body:PAGE});
    if(url.pathname.endsWith('/experiences'))return json({experiences:[setup(state.title)],reveals:[],faqs:null});
    if(url.pathname.endsWith('/events'))return json({recorded:true});
    return route.fulfill({status:404,body:''});
  }
  return {state,handle};
}

const PAGE=`<!doctype html><html><head><style>body{margin:0;font:14px Arial}</style></head><body>
  <script>window.__APP={userOrgId:'o',platformApiBase:'https://fm.test/v1/platform'};
    window.reloads=0;window.addEventListener('beforeunload',()=>{window.reloads++;});
    window.live=(files)=>window.dispatchEvent(new CustomEvent('fm:live-assets',{detail:{event:'changed',files}}));</script>
  ${LIBS.map(file=>`<script src="/libraries/${file}"></script>`).join('')}
  <script>window.played=null;setTimeout(()=>{window.played=FirstMateGuides.play('test.hot_setup',{replay:true});},50);</script></body></html>`;

const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('a live edit shows the spinner, swaps the step module in place keeping its state, and reloads the definition when done',async()=>{
  const browser=await launch();
  try{
    const srv=server(),tab=await browser.newPage({viewport:{width:390,height:800}}),errors=[];
    tab.on('pageerror',error=>errors.push(error.message));
    await tab.route('https://fm.test/**',route=>srv.handle(route).catch(()=>route.abort()));
    await tab.goto('https://fm.test/portal/');
    await tab.waitForSelector('.hot-v[data-version="1"]');
    await tab.click('#tap'); await tab.click('#tap');
    assert.equal(await tab.textContent('.hot-v'),'v1 n=2');
    assert.equal(await tab.isHidden('[data-gxs-hot]'),true,'no spinner until an agent starts');

    // An agent starts editing: the spinner shows beside the X.
    srv.state.signal={v:1,experience:'test.hot_setup',state:'working',note:'bigger tiles',at:new Date().toISOString()};
    await tab.evaluate(()=>window.live([{path:'libraries/hot-edits/test.hot_setup.json',sha:'s1'}]));
    await tab.waitForSelector('[data-gxs-hot]:not([hidden])');
    assert.equal(await tab.getAttribute('[data-gxs-hot]','title'),'bigger tiles');

    // The step's module changes on the live layer: the handler swaps it in place, with the state it handed over.
    srv.state.version=2;
    const handled=await tab.evaluate(()=>Promise.all(window.__fmHotHandlers.map(h=>h('libraries/test/hot-step.js','abc'))));
    assert.ok(handled.includes(true),'a setup showing the module takes the change');
    await tab.waitForSelector('.hot-v[data-version="2"]');
    assert.equal(await tab.textContent('.hot-v'),'v2 n=2','the step keeps what it handed over');
    assert.equal(await tab.evaluate(()=>document.querySelectorAll('#hot-step-css').length),1,'the old copy\'s style is replaced, not stacked');
    assert.equal(await tab.evaluate(()=>getComputedStyle(document.querySelector('.hot-v')).color),'rgb(2, 2, 2)');
    assert.equal(await tab.evaluate(()=>document.querySelectorAll('.gxs-step').length),1,'redrawn in place');
    assert.equal(await tab.isVisible('[data-gxs-hot]:not(.gxs-hot-done)'),true,'still working until the agent says done');

    // Done: the signal leaves the layer; the definition (config library data) is read again and the step redrawn.
    srv.state.title='Renamed by the agent'; srv.state.signal=null;
    await tab.evaluate(()=>window.live([{path:'libraries/hot-edits/test.hot_setup.json',sha:null}]));
    await tab.waitForFunction(()=>document.querySelector('.gxs-step h2')?.textContent.includes('Renamed by the agent'));
    assert.equal(await tab.textContent('.hot-v'),'v2 n=2');
    // A module no open setup shows is only dropped from the cache: nothing to redraw, no refresh needed.
    assert.equal((await tab.evaluate(()=>Promise.all(window.__fmHotHandlers.map(h=>h('libraries/test/not-loaded.js','x'))))).includes(true),false);
    assert.equal(await tab.evaluate(()=>window.reloads),0,'the page never reloaded');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
