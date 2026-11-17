import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-536: nobody turns the phone on or off. It connects when a call needs it, and disconnects after a call once
// it has sat idle for two minutes, unless the person chose to take incoming calls.
test('phone disconnects when idle, stays connected for a call or while taking incoming calls',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install();
    await page.route('https://idle.test/**',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));
    await page.goto('https://idle.test');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org',userId:'user'};window.requests=[];window.clients=[];window.Portal={};
      window.CommsAPI={customer:async(_org,path,body)=>{
        requests.push({path,body});
        if(path==='voice/status')return {settings:{enabled:true},permissions:{manage:true}};
        if(path==='voice/endpoint/token')return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
        if(path==='voice/endpoint/presence')return {availability:body.registered&&body.availability==='available'?'available':'unavailable'};
        if(path==='calls')return {call:{id:'call-one',state:'dialing',mode:'browser',direction:'outbound',owner_user_id:'user',customer_number:body.customer_number,metadata:{device_id:body.device_id}}};
        if(path==='calls/call-one')return {call:window.serverCall||{id:'call-one',state:'dialing',mode:'browser',direction:'outbound',owner_user_id:'user',metadata:{}}};
        return {calls:[],scripts:[]};
      }};
      window.TelnyxWebRTC={TelnyxRTC:class{
        constructor(){this.handlers={};clients.push(this);}
        on(name,cb){(this.handlers[name]||=[]).push(cb);}
        async setAudioSettings(){}connect(){queueMicrotask(()=>{for(const cb of this.handlers['telnyx.ready']||[])cb();});}disconnect(){this.stopped=true;}
      }};
    });
    for(const f of ['communications-ui.js','calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/comms/'+f,import.meta.url),'utf8')});
    const disconnects=()=>page.evaluate(()=>requests.filter(r=>r.path==='voice/endpoint/disconnect').length);
    // Opening the phone gets the connection ready; left idle, it disconnects by itself.
    await page.evaluate(()=>Portal.CustomerPhone.open({customer_number:'+12069415049'}));
    await page.waitForFunction(()=>Portal.CustomerPhone.connected);
    await page.clock.runFor(119_000);
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.connected),true);
    await page.clock.runFor(2_000);
    await page.waitForFunction(()=>!Portal.CustomerPhone.connected);
    assert.equal(await disconnects(),1);
    // Start call connects again on its own, and a live call is never disconnected for being idle.
    await page.locator('[data-phone=start]').click();
    await page.waitForFunction(()=>Portal.CustomerPhone.connected&&Portal.CustomerPhone.currentCall?.id==='call-one');
    assert.equal(await page.evaluate(()=>clients.length),2);
    await page.clock.runFor(5*60_000);
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.connected),true);
    assert.equal(await disconnects(),1);
    // When the call ends the idle countdown starts.
    await page.evaluate(()=>{window.serverCall={id:'call-one',state:'ended',mode:'browser',direction:'outbound',owner_user_id:'user',wrap_up_state:'saved',metadata:{}};});
    await page.clock.runFor(3_000);
    await page.waitForFunction(()=>Portal.CustomerPhone.currentCall?.state==='ended');
    await page.clock.runFor(121_000);
    await page.waitForFunction(()=>!Portal.CustomerPhone.connected);
    assert.equal(await disconnects(),2);
    // Taking incoming calls keeps the phone connected and tells the server this phone is available.
    await page.evaluate(()=>Portal.CustomerPhone.availability(true));
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.connected&&Portal.CustomerPhone.takingCalls),true);
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.path==='voice/endpoint/presence').at(-1).body.availability),'available');
    await page.clock.runFor(10*60_000);
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.connected),true);
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.path==='voice/endpoint/presence').at(-1).body.availability),'available');
    await page.evaluate(()=>Portal.CustomerPhone.availability(false));
    await page.clock.runFor(121_000);
    await page.waitForFunction(()=>!Portal.CustomerPhone.connected);
    assert.equal(await disconnects(),3);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
