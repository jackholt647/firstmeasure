import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('required outcomes remain open and first browser call offers actionable readiness checks', async () => {
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://calls.test/**',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
    await page.goto('https://calls.test/');
    await page.setContent('<style>.minimized .fmcp-body,.minimized .fmcp-footer{display:none}</style>');
    await page.evaluate(() => {
      window.__APP={userOrgId:'org',userId:'user'};window.requests=[];window.closeCount=0;window.verdict='blocked';
      window.fixtureCall={id:'external',owner_user_id:'user',mode:'external',state:'created',wrap_up_state:'pending',customer_name:'Test',customer_number:'+12069415049',notes:'',revision:1,metadata:{}};
      window.CommsAPI={customer:async (_org,path,body) => {
        window.requests.push({path,body});
        if(path==='voice/status')return {settings:{enabled:true,require_disposition:true},permissions:{manage:true,recordings:true}};
        if(path==='voice/endpoint/token')return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
        if(path==='voice/endpoint/presence')return {availability:'unavailable'};
        if(path==='voice/diagnostics/start'){
          window.client.handlers['telnyx.notification']({type:'callUpdate',call:{state:'active',hangup:async()=>{},peer:{instance:{connectionState:'connected',getStats:async()=>new Map([['pair',{type:'candidate-pair',state:'succeeded',currentRoundTripTime:.02}],['audio',{type:'inbound-rtp',kind:'audio',jitter:.001,packetsReceived:100,packetsLost:0}]])}}}});
          return {call_id:'check'};
        }
        if(path==='voice/diagnostics')return {result:{verdict:window.providerFailure?'blocked':window.verdict,reason:window.providerFailure?'The phone provider could not connect the test call. Check Phone setup.':window.verdict==='ready'?'Microphone and network checks passed.':'Allow microphone access and run checks again.',metrics:body.metrics}};
        if(path==='calls/check')return {call:{state:window.providerFailure?'failed':'connected'}};
        if(path.startsWith('calls?'))return {calls:[]};
        if(path==='calls'){
          if(window.expireCheck){window.expireCheck=false;const error=new Error('Run the microphone and network check before your first call on this device.');error.code='device_check_required';throw error;}
          window.fixtureCall={...window.fixtureCall,id:'browser',mode:body.mode,state:'connected',wrap_up_state:'pending'};return {call:window.fixtureCall};
        }
        if(path.endsWith('/draft')){window.fixtureCall={...window.fixtureCall,notes:body.notes,revision:2};return {call:window.fixtureCall};}
        if(path.endsWith('/wrap-up')){window.fixtureCall={...window.fixtureCall,wrap_up_state:'saved',state:'ended',result:{disposition:body.disposition}};return {call:window.fixtureCall};}
        if(path.endsWith('/actions')){if(body.action==='hangup'&&path.includes('browser'))window.fixtureCall={...window.fixtureCall,state:'ended'};return {call:window.fixtureCall};}
        return {call:window.fixtureCall,scripts:[]};
      }};
      window.Portal={navigation:{backOrClose:()=>window.closeCount++}};
      window.TelnyxWebRTC={TelnyxRTC:class {
        constructor(){this.handlers={};window.client=this;}
        on(event,cb){this.handlers[event]=cb;}
        connect(){this.handlers['telnyx.ready']();}
        async setAudioSettings(){} disconnect(){}
      }};
      Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{
        if(window.pauseMicrophone)await new Promise(resolve=>window.releaseMicrophone=resolve);
        if(window.verdict==='blocked'){const e=new Error('Denied');e.name='NotAllowedError';throw e;}
        return {getAudioTracks:()=>[{readyState:'live'}],getTracks:()=>[{stop(){}}]};
      }}});
    });
    for(const file of ['communications-ui.js','calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL(`../../libraries/apps/comms/${file}`,import.meta.url),'utf8')});
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'external'}));
    await page.locator('[name=notes]').fill('Keep these call notes');
    await page.locator('[name=disposition]').selectOption('callback');
    await page.locator('[data-phone=minimize]').click();
    await page.locator('[data-phone=close]').click();
    assert.equal(await page.locator('.fmcp').evaluate(el=>el.classList.contains('minimized')),false);
    assert.equal(await page.locator('[name=notes]').inputValue(),'Keep these call notes');
    assert.equal(await page.locator('[name=disposition]').inputValue(),'callback');
    assert.equal(await page.evaluate(()=>document.activeElement.name),'disposition');
    assert.match(await page.locator('.fmcp-body').textContent(),/Choose the call outcome/);
    assert.equal(await page.evaluate(()=>window.closeCount),0);
    await page.locator('[data-phone=wrap]').click();
    await page.waitForFunction(()=>Portal.CustomerPhone.currentCall.wrap_up_state==='saved');
    await page.locator('[data-phone=close]').click();
    await page.waitForFunction(()=>document.querySelector('.fmcp').hidden);
    assert.equal(await page.evaluate(()=>window.fixtureCall.notes),'Keep these call notes');
    await page.evaluate(async()=>{await Portal.CustomerPhone.connect();await Portal.CustomerPhone.open({customer_name:'My phone',customer_number:'+12069415049',purpose:'Voice test'});});
    await page.locator('[data-phone=start]').click();
    await page.waitForSelector('[data-phone=diagnose]');
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path==='calls').length),0);
    await page.evaluate(()=>window.pauseMicrophone=true);
    await page.locator('[data-phone=diagnose]').click();
    await page.waitForFunction(()=>typeof window.releaseMicrophone==='function');
    assert.equal(await page.locator('[data-check-step="0"]').textContent(),'Passed');
    assert.equal(await page.locator('[data-check-step="1"]').textContent(),'Checking…');
    assert.match(await page.locator('[data-check-progress]').textContent(),/click Allow/);
    await page.evaluate(()=>{window.pauseMicrophone=false;window.releaseMicrophone();});
    await page.waitForFunction(()=>!document.querySelector('[data-phone=diagnose]').disabled);
    assert.match(await page.locator('.fmcp-body').textContent(),/Allow microphone access/);
    assert.match(await page.locator('dialog[open]').textContent(),/Allow microphone access/);
    assert.equal(await page.locator('[data-check-step="1"]').textContent(),'Blocked');
    await page.locator('dialog[open] [data-close]').first().click();
    assert.equal(await page.locator('[name=purpose]').inputValue(),'Voice test');
    await page.evaluate(()=>{window.verdict='ready';const now=Date.now.bind(Date);let tick=0;Date.now=()=>now()+(tick+=3000);});
    await page.locator('[data-phone=diagnose]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-phone=diagnose]'));
    assert.match(await page.locator('dialog[open]').textContent(),/Microphone and network checks passed/);
    assert.match(await page.locator('dialog[open]').textContent(),/Latency: 20 ms/);
    await page.locator('dialog[open] [data-close]').first().click();
    assert.match(await page.locator('.fmcp-body').textContent(),/Click Start call when you are ready/);
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path==='calls').length),0);
    await page.evaluate(()=>window.expireCheck=true);
    await page.locator('[data-phone=start]').click();
    await page.waitForSelector('[data-phone=diagnose]');
    await page.locator('[data-phone=diagnose]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-phone=diagnose]'));
    await page.locator('dialog[open] [data-close]').first().click();
    await page.locator('[data-phone=start]').click();
    await page.waitForFunction(()=>Portal.CustomerPhone.currentCall?.id==='browser');
    await page.locator('[data-phone=minimize]').click();await page.locator('[data-phone=close]').click();
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.currentCall.state),'connected');
    await page.locator('[data-phone=minimize]').click();await page.locator('[data-phone=hangup]').click();
    await page.waitForSelector('[name=disposition]');
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.currentCall.state),'ended');
    await page.evaluate(()=>{window.providerFailure=true;window.verdict='ready';});
    await page.evaluate(()=>{window.checkPromise=Portal.CustomerPhone.diagnose();});
    await page.waitForFunction(()=>document.querySelector('[data-check-retry]')&&!document.querySelector('[data-check-retry]').disabled);
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path==='voice/diagnostics').at(-1).body.provider_verdict),'blocked');
    assert.equal(await page.locator('[data-check-step="2"]').textContent(),'Blocked');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});


