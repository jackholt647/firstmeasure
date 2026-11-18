// FM-588: a project's Texts and Calls offer New text and New call only once texts and calls work (voice/status
// `channels`, comms/setup.ts phoneChannels). Until then they say where setup stands: Continue setup (the
// Communications setup) while texts and calls are not set up or need changes, or pending approval while the
// carriers review the registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

async function fixture(browser,channels,{threads=[],calls=[]}={}){
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://comms-tab.test/**',route=>route.fulfill({contentType:'text/html',body:'<main id="app"></main>'}));
  await page.goto('https://comms-tab.test');
  await page.evaluate(({channels,threads,calls})=>{
    window.__APP={orgId:'org-test',userId:'rep-one'};window.played=[];
    const status={settings:{enabled:true},permissions:{manage:true},channels};
    window.FirstMateEmbeddableApps={registerApp:app=>{window.commsApp=app;}};
    window.FirstMateGuides={play:async(id,options)=>{window.played.push({id,options,start:window.__fmCommsSetupStart});return {status:'completed'};}};
    window.AppChrome={resolve:()=>'history',header:()=>'',tabs:()=>'',settingsTabs:()=>''};
    window.Portal={can:()=>true,navigation:{registerSchema(){},registerHandler(){},read:()=>({}),push(){}},
      CustomerPhone:{status,dialer:{active:false},currentCall:null,refreshStatus:async()=>status,open:async()=>true}};
    const conversations=threads.map((id,i)=>({id,participants:[{address:'+12065550100',name:'Ada'}],message_count:1,last_message_at:new Date().toISOString(),messages:[{id:'m'+i,direction:'inbound',text:'Hello',created_at:new Date().toISOString()}]}));
    window.CommsAPI={
      overview:async()=>({overview:{channels:{}}}),
      sms:{conversation:async()=>({conversations,conversation:conversations[0]||null})},
      customer:async(_org,path)=>path.startsWith('calls')?{calls,next_cursor:null}:path==='voice/status'?status:{}
    };
  },{channels,threads,calls});
  for(const file of ['communications-ui.js','workspace.js','project.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/comms/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{const root=document.querySelector('#app');root.innerHTML=commsApp.panelHtml();Portal.CommsTab.mount({panelRoot:root,projectId:'project-one',orgId:'org-test'});});
  return {page,errors};
}
const open=async(page,view)=>{await page.locator(`[data-co-tab="${view}"]`).click();};

test('texts and calls that are not set up offer Continue setup, not New text or New call',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await fixture(browser,{texts:'setup',calls:'setup'});
    await open(page,'sms');
    await page.locator('[data-co-phone-setup="setup"]').waitFor();
    assert.equal(await page.locator('[data-co-sms-compose]').count(),0,'New text is offered before texts are set up');
    assert.equal(await page.getByText('No text threads yet.').count(),0);
    assert.match(await page.locator('[data-co-phone-setup]').innerText(),/Texts are not set up yet/);
    await page.getByRole('button',{name:'Continue setup'}).click();
    await page.waitForFunction(()=>played.length===1);
    assert.deepEqual(await page.evaluate(()=>played[0]),{id:'comms.setup',options:{replay:true},start:'phone'});

    await open(page,'calls');
    await page.locator('[data-calls-setup="setup"]').waitFor();
    assert.equal(await page.locator('[data-action="new-call"]').count(),0,'New call is offered before calls are set up');
    assert.match(await page.locator('[data-calls-setup]').innerText(),/Calls are not set up yet/);
    await page.locator('[data-calls-setup] [data-action="comms-setup"]').click();
    await page.waitForFunction(()=>played.length===2);
    assert.equal(await page.evaluate(()=>played[1].start),'phone');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('pending approval says to check back later and offers nothing to send',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await fixture(browser,{texts:'pending',calls:'pending'},{threads:['thread-one']});
    await open(page,'sms');
    await page.locator('[data-co-phone-setup="pending"]').waitFor();
    assert.match(await page.locator('[data-co-phone-setup]').innerText(),/pending approval[^]*check back later/);
    assert.equal(await page.locator('[data-co-phone-setup] button').count(),0,'nothing to continue while carriers review it');
    assert.equal(await page.locator('[data-co-sms-compose]').count(),0);
    assert.equal(await page.locator('[data-co-sms-thread]').count(),1,'earlier threads can still be read');
    assert.equal(await page.locator('[data-co-sms-send]').isVisible(),false,'a reply can be sent while texting is pending');
    assert.match(await page.locator('[data-co-sms-off]').innerText(),/once texting is approved/);

    await open(page,'calls');
    await page.locator('[data-calls-setup="pending"]').waitFor();
    assert.match(await page.locator('[data-calls-setup]').innerText(),/Calls are pending approval[^]*check back later/);
    assert.equal(await page.locator('[data-action="new-call"]').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('texts and calls that work keep New text and New call',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await fixture(browser,{texts:'ready',calls:'ready'});
    await open(page,'sms');
    await page.locator('[data-co-sms-compose]').waitFor();
    assert.equal(await page.locator('[data-co-phone-setup]').count(),0);
    await open(page,'calls');
    await page.locator('[data-action="new-call"]').waitFor();
    assert.equal(await page.locator('[data-calls-setup]').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
