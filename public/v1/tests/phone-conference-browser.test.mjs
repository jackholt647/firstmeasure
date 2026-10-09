import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {join} from 'node:path';

async function asset(file){
  if(process.env.PHONE_CONFERENCE_ASSET_ROOT){
    try{return await readFile(join(process.env.PHONE_CONFERENCE_ASSET_ROOT,file),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
}

test('active calls invite teammates and contacts, show participants, and give guests leave-only controls',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://conference.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font-family:Arial,sans-serif}.main{height:100vh;position:relative}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="mainPanels"></div></main>'}));
    await page.goto('https://conference.test');
    await page.evaluate(()=>{
      window.__APP={orgId:'org',userId:'host'};window.actions=[];window.participants=[];
      window.call={id:'conference',owner_user_id:'host',branch_id:'default',mode:'browser',state:'connected',direction:'outbound',customer_name:'Avery Customer',customer_number:'+12065550101',business_number:'+12065550100',notes:'',metadata:{conference_id:'room'}};
      window.Portal={appFlags:{has:()=>true},modules:{},navigation:{registerSchema(){},registerHandler(){},push(){},read(){return {};},backOrClose(){}},modals:{register:()=>({unregister(){}})}};
      window.CommsAPI={customer:async(_org,path,body)=>{
        if(path==='voice/status')return {settings:{enabled:true,require_disposition:false},permissions:{manage:false},numbers:[]};
        if(path==='voice/endpoint/token')return {token:'test',expires_at:new Date(Date.now()+3600000).toISOString()};
        if(path==='voice/endpoint/presence')return {availability:'busy'};
        if(path==='voice/center')return {agents:[{user_id:'jordan',name:'Jordan Teammate',branch_id:'default',availability:'available'}]};
        if(path.startsWith('voice/contacts'))return {contacts:[{id:'contact',name:'Morgan External',phone:'+12065550102'}]};
        if(path==='calls/conference/actions'){
          window.actions.push(body);
          if(body.action==='add_participant')window.participants.push({id:`p${window.participants.length}`,name:body.target_name||'Jordan Teammate',phone:body.target_phone||'',user_id:body.target_user_id||'',state:'ringing'});
          if(body.action==='remove_participant')window.participants.find(p=>p.id===body.participant_id).state='removed';
          if(body.action==='hangup'&&window.__APP.userId!=='host')window.participants.find(p=>p.user_id===window.__APP.userId).state='left';
          return {call:structuredClone(window.call),participants:structuredClone(window.participants)};
        }
        if(path==='calls/conference')return {call:structuredClone(window.call),participants:structuredClone(window.participants)};
        if(path.startsWith('calls?'))return {calls:[]};
        return {scripts:[]};
      }};
      window.TelnyxWebRTC={TelnyxRTC:class{constructor(){this.handlers={};}on(name,handler){this.handlers[name]=handler;}connect(){this.handlers['telnyx.ready']?.();}async setAudioSettings(){}disconnect(){}}};
    });
    for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','apps/comms/communications-ui.js','apps/comms/phone-tray.js','apps/comms/calling-runtime.js'])await page.addScriptTag({content:await asset(file)});
    await page.addStyleTag({content:await asset('apps/comms/communications.css')});
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'conference'}));
    await page.getByRole('button',{name:'Add person',exact:true}).click();
    await page.getByLabel('Available teammate').selectOption('jordan');
    await page.getByRole('button',{name:'Call and add'}).click();
    await page.getByRole('region',{name:'Call participants'}).getByText('Jordan Teammate').waitFor();
    assert.equal(await page.evaluate(()=>window.actions[0].target_user_id),'jordan');
    await page.getByRole('button',{name:'Add person',exact:true}).click();
    await page.getByRole('radio',{name:'Phone number',exact:true}).check();
    await page.getByLabel('Number or contact',{exact:true}).fill('Morgan');
    await page.locator('[data-invite-results] button').click();
    await page.getByRole('button',{name:'Call and add'}).click();
    await page.getByRole('region',{name:'Call participants'}).getByText('Morgan External').waitFor();
    assert.equal(await page.evaluate(()=>window.actions.at(-1).target_phone),'+12065550102');
    await page.evaluate(()=>{window.participants.forEach(p=>p.state='connected');});
    await page.getByRole('region',{name:'Call participants'}).getByText('On call',{exact:true}).last().waitFor();
    if(process.env.PHONE_CONFERENCE_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_CONFERENCE_SCREENSHOTS+'/conference-desktop.png'});
    await page.getByRole('button',{name:'Remove Morgan External from call'}).click();
    await page.getByText('Removed',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.call.state),'connected');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Add person',exact:true}).click();
    if(process.env.PHONE_CONFERENCE_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_CONFERENCE_SCREENSHOTS+'/conference-mobile.png'});
    const bounds=await page.locator('dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.evaluate(()=>{window.__APP.userId='jordan';Portal.CustomerPhone.state.detail.participants=structuredClone(window.participants);Portal.CustomerPhone.state.sdkCall={state:'active',muteAudio(){},unmuteAudio(){},async hangup(){}};});
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'conference'}));
    assert.equal(await page.getByRole('button',{name:'Add person',exact:true}).count(),0);
    await page.getByRole('button',{name:'Leave call',exact:true}).click();
    await page.waitForFunction(()=>Portal.CustomerPhone.currentCall===null);
    assert.equal(await page.evaluate(()=>window.call.state),'connected');assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
