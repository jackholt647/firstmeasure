import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('header phone resets floating and minimized placement after close',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://phone.test/**',route=>route.fulfill({body:'<style>body{margin:0;font-family:Arial,sans-serif}.main{height:100vh;position:relative}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="platformPhoneSlot"><button id="platformPhoneBtn">Phone</button></div><div id="mainPanels"></div></main>',contentType:'text/html'}));
    await page.goto('https://phone.test');
    await page.evaluate(()=>{
      window.voiceSettings={enabled:true};window.callActions=[];window.testArtifacts=[];window.sentTones=[];window.tones=[];window.AudioContext=class {
        currentTime=0;state='running';destination={};async close(){}async resume(){}
        createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},disconnect(){}};}
        createOscillator(){return {frequency:{value:0},connect(){},disconnect(){},start(){window.tones.push(this.frequency.value);},stop(){this.onended?.();}};}
      };
      window.__APP={orgId:'org-test',userId:'user-test'};
      window.Portal={appFlags:{has:()=>true},navigation:{registerSchema(){},registerHandler(){},push(){}}};
      window.TelnyxWebRTC={TelnyxRTC:class{constructor(){this.handlers={};window.phoneClient=this;}on(n,cb){this.handlers[n]=cb;}connect(){if(!window.delayReady)this.handlers['telnyx.ready']();}async setAudioSettings(){}disconnect(){}}};
      window.testCall={id:'call-test',customer_name:'Test contact',customer_number:'+12025550123',state:'connected',mode:'browser',owner_user_id:'user-test',wrap_up_state:'draft',metadata:{}};
      window.CommsAPI={customer:async(_org,path,data)=>{
        if(path==='voice/endpoint/token')return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
        if(path==='voice/endpoint/presence')return {availability:'unavailable'};
        if(path==='voice/diagnostics')return {result:{verdict:'blocked',reason:'Allow microphone access and try again.'}};
        if(path==='voice/status')return {settings:{require_disposition:true,allowed_destination_countries:['US','CA'],allowed_country_prefixes:['+1'],...window.voiceSettings},permissions:{manage:true,recordings:true,record:true},numbers:[{phone_number:'+12065550199',label:'Main',status:'active'}],sms_numbers:[{phone_number:'+12065550199'}],default_number:'+12065550199'};
        if(path==='call-scripts')return {scripts:[]};
        if(path==='call-context')return {contacts:[]};
        if(path==='call-lists/queue')return {columns:[]};
        if(path.startsWith('voice/contacts'))return {contacts:[{id:'contact-one',name:'Jane Test',phone:'+12025550124'}]};
        if(path.endsWith('/wrap-up')){window.testCall={...window.testCall,wrap_up_state:'saved',result:{disposition:'answered'}};return {call:window.testCall};}
        if(path.includes('/actions')){window.callActions.push(data.action);if(data.action==='consent')window.testCall={...testCall,metadata:{...testCall.metadata,consent:{state:data.consent}}};if(data.action==='record_start')window.testCall={...testCall,metadata:{...testCall.metadata,capture:{state:'recording'}}};if(data.action==='dtmf')window.sentTones.push(data.digits);if(data.action==='hangup')window.testCall={...window.testCall,state:'ended',wrap_up_state:'needs_wrap_up'};return {call:window.testCall};}
        if(path.endsWith('/artifacts'))return {artifacts:window.testArtifacts};
        if(path.startsWith('calls/'))return {call:window.testCall,artifacts:window.testArtifacts};
        return {};
      },inbox:async()=>({conversations:[{id:'text-one',channel:'sms',contact_name:'Jane Test',contact_address:'+12025550124',last_message:{text:'Hello'}}]}),conversation:async()=>({conversation:{messages:[{id:'message-one',channel:'sms',direction:'inbound',text:'Hello',created_at:new Date().toISOString()}]}}),reply:async(_org,_id,body)=>{window.lastReply=body;return {ok:true};}};
    });
    for(const file of ['window-manager/window-manager.js','apps/comms/communications-ui.js','apps/comms/phone-tray.js','apps/comms/calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
    await page.evaluate(()=>Portal.CustomerPhone.open());
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'docked');

    await page.getByRole('button',{name:'Move phone freely',exact:true}).click();
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'floating');
    await page.getByRole('button',{name:/^Close phone$/i}).click();
    await page.waitForFunction(()=>document.querySelector('.fm-phone-tray').hidden);
    await page.evaluate(()=>Portal.CustomerPhone.open());
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'docked');
    await page.getByRole('button',{name:'Move phone freely',exact:true}).click();
    await page.getByRole('button',{name:/^Minimize phone$/i}).click();
    await page.getByRole('button',{name:/^Close phone$/i}).click();
    await page.waitForFunction(()=>document.querySelector('.fm-phone-tray').hidden);
    await page.evaluate(()=>Portal.CustomerPhone.open());
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'docked');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:/^Close phone$/i}).click();
    await page.waitForFunction(()=>document.querySelector('.fm-phone-tray').hidden);
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(()=>Portal.CustomerPhone.open());
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'docked');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
