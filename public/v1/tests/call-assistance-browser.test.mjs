import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

async function setup(context,{supervisor=false}={}){
  const page=await context.newPage();
  await page.route('https://assistance.test/**',r=>r.fulfill({body:'<style>body{margin:0;font-family:Arial;background:#f5f7fa}.main{height:100vh}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="mainPanels"></div></main>',contentType:'text/html'}));
  await page.goto('https://assistance.test');
  await page.evaluate(({supervisor})=>{
    window.__APP={orgId:'org-test',userId:'user-test'};
    window.Portal={appFlags:{has:()=>true},navigation:{registerSchema(){},registerHandler(){},push(){}}};
    window.callsSent=[];window.requests=[];window.analysisNotes=[];window.failDial=false;
    window.supervision={session:null,permissions:{monitor:supervisor,whisper:supervisor,barge:false,takeover:supervisor}};
    window.detailPermissions={record:!supervisor,recordings:true,analyze:true};
    window.testCall={id:'call-test',customer_name:'Jamie Cooper',customer_number:'+12025550123',state:'ended',mode:'browser',owner_user_id:supervisor?'other-user':'user-test',wrap_up_state:'saved',notes:'Original notes',metadata:{}};
    window.TelnyxWebRTC={TelnyxRTC:class{constructor(){this.handlers={};}on(n,cb){this.handlers[n]=cb;}connect(){this.handlers['telnyx.ready']();}async setAudioSettings(){}disconnect(){}}};
    window.CommsAPI={customer:async(_org,path,data)=>{
      requests.push({path,data});
      if(path==='voice/endpoint/token')return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
      if(path==='voice/endpoint/presence')return {availability:'unavailable'};
      if(path==='voice/status')return {settings:{enabled:true,require_disposition:true,wrap_up_seconds:0,recording_enabled:true,recording_policy_confirmed:true},permissions:{manage:false,record:true,recordings:true,analyze:true}};
      if(path.startsWith('call-scripts'))return {scripts:[]};
      if(path.startsWith('call-lists/queue'))return {columns:[{id:'sales',title:'Inside sales',tasks:[{id:'one',name:'Jamie Cooper',phone:'+12025550123',ready:true},{id:'two',name:'Morgan Lee',phone:'+12025550124',ready:true}]}]};
      if(path==='calls'&&data){callsSent.push(data);if(failDial)throw new Error('Provider status is uncertain');testCall={...testCall,id:'call-'+data.entry_id,entry_id:data.entry_id,owner_user_id:'user-test',state:'connected',wrap_up_state:'draft',metadata:{},notes:''};return {call:testCall};}
      if(path.endsWith('/analysis')){
        if(data){analysisNotes.push({id:'note-'+analysisNotes.length,kind:data.question?'answer':'summary',question:data.question||'',state:'pending',text:'',created_at:new Date().toISOString()});return {note:analysisNotes.at(-1)};}
        return {notes:analysisNotes,available:true};
      }
      if(path.endsWith('/supervision')){supervision={...supervision,session:data?.mode==='leave'?null:{id:'supervisor-session',mode:data?.mode||'monitor',state:'active'}};return {call:testCall,supervision};}
      if(path.endsWith('/draft')){testCall={...testCall,notes:data.notes};return {call:testCall};}
      if(path.endsWith('/wrap-up')){testCall={...testCall,wrap_up_state:'saved',result:{disposition:'answered'}};return {call:testCall};}
      if(path.startsWith('calls/'))return {call:testCall,artifacts:[],permissions:detailPermissions,supervision};
      return {};
    }};
  },{supervisor});
  for(const file of ['window-manager/window-manager.js','apps/comms/communications-ui.js','apps/comms/phone-tray.js','apps/comms/calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
  await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
  return page;
}

test('supervisor controls use target capabilities, own-leg actions, and a takeover confirmation',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await setup(await browser.newContext({viewport:{width:1280,height:900}}),{supervisor:true});
    await page.evaluate(async()=>{testCall.state='connected';await Portal.CustomerPhone.open({call_id:testCall.id});});
    assert.equal(await page.getByRole('button',{name:'Live listen',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Barge',exact:true}).count(),0);
    assert.equal(await page.locator('[data-phone=hangup]').count(),0);
    assert.equal(await page.locator('[data-phone=record]:visible').count(),0);
    await page.getByRole('button',{name:'Live listen',exact:true}).click();
    await page.waitForFunction(()=>supervision.session?.mode==='monitor');
    await page.getByRole('button',{name:'Whisper',exact:true}).click();
    await page.waitForFunction(()=>supervision.session?.mode==='whisper');
    await page.getByRole('button',{name:'Take over',exact:true}).click();
    assert.equal(await page.locator('dialog').count(),1);
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.data?.mode==='takeover').length),0);
    await page.locator('dialog').getByRole('button',{name:'Take over',exact:true}).click();
    await page.waitForFunction(()=>supervision.session?.mode==='takeover');
    await page.getByRole('button',{name:'Leave supervision'}).click();
    assert.equal(await page.evaluate(()=>requests.at(-1).data.mode),'leave');
  }finally{await browser.close();}
});

test('AI notes preserve prompt, poll queued analysis, escape content and append without replacing notes',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await setup(await browser.newContext({viewport:{width:1280,height:900}}));
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:testCall.id}));
    await page.getByText('AI notes & questions',{exact:true}).click();
    await page.getByLabel('Instructions',{exact:true}).fill('Focus on customer decisions.');
    await page.getByRole('button',{name:'Generate notes',exact:true}).click();
    await page.waitForFunction(()=>analysisNotes.length===1);
    assert.equal(await page.evaluate(()=>requests.find(r=>r.data?.system_prompt).data.system_prompt),'Focus on customer decisions.');
    await page.evaluate(()=>Object.assign(analysisNotes[0],{state:'ready',text:'<script>unsafe()</script>\nNext step: send estimate.',citations:[{id:'transcript',label:'Call transcript'}]}));
    await page.waitForSelector('[data-phone=analysis-append]');
    assert.equal(await page.locator('.fmcp-ai-note script').count(),0);
    await page.getByRole('button',{name:'Append to call notes',exact:true}).click();
    await page.waitForFunction(()=>testCall.notes.includes('Next step'));
    assert.ok(await page.evaluate(()=>testCall.notes.startsWith('Original notes\n\n')));
    await page.getByLabel('Ask about this call').fill('What is next?');
    await page.getByRole('button',{name:'Ask question',exact:true}).click();
    await page.waitForFunction(()=>analysisNotes.length===2);
    assert.equal(await page.evaluate(()=>analysisNotes[1].question),'What is next?');
    if(process.env.CALL_ASSIST_SCREENSHOTS){await mkdir(process.env.CALL_ASSIST_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.CALL_ASSIST_SCREENSHOTS+'/ai-notes-desktop.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:process.env.CALL_ASSIST_SCREENSHOTS+'/ai-notes-mobile.png'});}
  }finally{await browser.close();}
});

test('auto dialer has cancellable countdown, cross-tab lock, required wrap-up and never repeats an entry',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await setup(context),second=await setup(context);
    await page.clock.install();await page.clock.pauseAt(new Date());
    await page.evaluate(async()=>{Portal.CustomerPhone.state.deviceChecked=true;await Portal.CustomerPhone.startDialer({id:'sales',title:'Inside sales'});});
    await page.waitForSelector('[data-phone=pause-dialer]');
    const conflict=await second.evaluate(async()=>{try{await Portal.CustomerPhone.startDialer({id:'sales'});return '';}catch(error){return error.message;}});
    assert.match(conflict,/another tab/);
    await page.getByRole('button',{name:'Pause automatic dialing'}).click();
    await page.clock.resume();
    await page.waitForTimeout(5200);
    assert.equal(await page.evaluate(()=>callsSent.length),0);
    await page.getByRole('button',{name:'Resume automatic dialing'}).click();
    await page.waitForFunction(()=>callsSent.length===1,{},{timeout:10000});
    assert.equal(await page.evaluate(()=>callsSent[0].entry_id),'one');
    await page.evaluate(()=>{testCall={...testCall,state:'ended',wrap_up_state:'needs_wrap_up'};});
    await page.waitForSelector('[data-phone=wrap]');
    await page.waitForTimeout(5200);
    assert.equal(await page.evaluate(()=>callsSent.length),1);
    await page.getByRole('button',{name:'Save outcome',exact:true}).click();
    await page.waitForFunction(()=>callsSent.length===2,{},{timeout:10000});
    assert.equal(await page.evaluate(()=>callsSent[1].entry_id),'two');
    assert.notEqual(await page.evaluate(()=>callsSent[0].operation_id),await page.evaluate(()=>callsSent[1].operation_id));
    await page.evaluate(()=>{testCall={...testCall,state:'failed',wrap_up_state:'saved'};});
    await page.waitForFunction(()=>!Portal.CustomerPhone.dialer.active);
    assert.match(await page.locator('[data-dialer]').textContent(),/Review this call/);
  }finally{await browser.close();}
});

test('a delayed analysis response cannot populate a different call',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await setup(await browser.newContext());
    await page.evaluate(async()=>{await Portal.CustomerPhone.open({call_id:testCall.id});const original=CommsAPI.customer;CommsAPI.customer=(org,path,data,method)=>path.endsWith('/analysis')?new Promise(resolve=>window.releaseAnalysis=resolve):original(org,path,data,method);});
    await page.getByText('AI notes & questions',{exact:true}).click();
    await page.getByRole('button',{name:'View saved notes',exact:true}).click();
    await page.waitForFunction(()=>typeof releaseAnalysis==='function');
    await page.evaluate(async()=>{testCall={...testCall,id:'another-call',notes:'Another customer'};await Portal.CustomerPhone.open({call_id:testCall.id});releaseAnalysis({available:true,notes:[{id:'old',state:'ready',text:'Previous call private notes'}]});});
    await page.waitForFunction(()=>!Portal.CustomerPhone.state.busy);
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.state.analysis),null);
    assert.equal(await page.getByText('Previous call private notes',{exact:true}).count(),0);
  }finally{await browser.close();}
});

test('transcript viewers can read saved AI notes without generation permission',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await setup(await browser.newContext());
    await page.evaluate(async()=>{detailPermissions={record:false,recordings:true,analysis_read:true,analyze:false};analysisNotes=[{id:'saved',state:'ready',text:'Customer asked for an estimate.'}];await Portal.CustomerPhone.open({call_id:testCall.id});});
    await page.getByText('AI notes & questions',{exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Generate notes',exact:true}).isVisible(),false);
    assert.equal(await page.getByRole('button',{name:'Ask question',exact:true}).isVisible(),false);
    await page.getByRole('button',{name:'View saved notes',exact:true}).click();
    assert.equal(await page.getByText('Customer asked for an estimate.',{exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'Append to call notes',exact:true}).count(),0);
  }finally{await browser.close();}
});
