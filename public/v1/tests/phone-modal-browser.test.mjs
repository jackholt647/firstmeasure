import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('phone modal combines call, text, voicemail, and searchable history',async()=>{
  assert.match(await readFile(new URL('../../portal/index.php',import.meta.url),'utf8'),/libraries\/apps\/comms\/phone-modal\.js/);
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://phone-modal.test/**',route=>route.fulfill({body:'<style>body{margin:0;font-family:Arial,sans-serif}.main{height:100vh;position:relative}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="platformPhoneSlot"><button id="platformPhoneBtn">Phone</button></div><div id="mainPanels"></div></main>',contentType:'text/html'}));
    await page.route('https://phone-modal.test/libraries/apps/comms/phone-modal.js*',async route=>route.fulfill({body:await readFile(new URL('../../libraries/apps/comms/phone-modal.js',import.meta.url),'utf8'),contentType:'text/javascript'}));
    await page.goto('https://phone-modal.test');
    await page.evaluate(()=>{
      window.__APP={orgId:'org-test',userId:'user-test'};
      const now=new Date().toISOString();
      window.callUnread=1;window.textUnread=1;window.fixtureCalls=[
        {id:'call-jane',organization_id:'org-test',customer_name:'Jane Test',customer_number:'+12025550124',business_number:'+12065550199',contact_id:'contact-jane',project_id:'project-jane',owner_user_id:'user-test',direction:'inbound',mode:'browser',state:'ended',wrap_up_state:'saved',created_at:now,connected_at:now,ended_at:now,notes:'Asked about the roof estimate.',result:{disposition:'answered',next_action:'callback'}},
        {id:'call-erik',organization_id:'org-test',customer_name:'Erik Demo',customer_number:'+12025550125',business_number:'+12065550199',contact_id:'contact-erik',project_id:'project-erik',owner_user_id:'user-test',direction:'outbound',mode:'browser',state:'no_answer',wrap_up_state:'needs_wrap_up',created_at:now,notes:'Left a message.',result:{}},
        {id:'call-missed',organization_id:'org-test',customer_name:'Missed Caller',customer_number:'+12025550126',business_number:'+12065550199',owner_user_id:'user-test',direction:'inbound',mode:'browser',state:'no_answer',wrap_up_state:'saved',created_at:now,notes:'',result:{}}
      ];
      window.fixtureVoicemail={id:'call-jane',contact_id:'contact-jane',project_id:'project-jane',name:'Jane Test',phone:'+12025550124',business_number:'+12065550199',created_at:now,audio_artifact_id:'audio-jane',audio_state:'ready',expires_at:new Date(Date.now()+86400000).toISOString(),transcript:'Please call about the roof estimate.',transcript_state:'ready',sample:true,read_at:'',archived_at:''};
      window.Portal={appFlags:{has:()=>true},modules:{},navigation:{registerSchema(){},registerHandler(){},push(){},read(){return {};},backOrClose(){}},modals:{register:()=>({unregister(){}})}};
      window.PlatformAPI={contacts:{settings:async()=>({settings:{tags:[]}})},media:{upload:async()=>({media:{id:'image-one'}}),fileUrl:(_org,id)=>`/media/${id}`}};
      window.TelnyxWebRTC={TelnyxRTC:class{constructor(){this.handlers={};}on(name,handler){this.handlers[name]=handler;}connect(){this.handlers['telnyx.ready']?.();}async setAudioSettings(){}disconnect(){}}};
      window.CommsAPI={customer:async(_org,path,body)=>{
        if(path==='voice/status')return {settings:{enabled:true,require_disposition:false,allowed_destination_countries:['US'],allowed_country_prefixes:['+1']},permissions:{manage:true},numbers:[{phone_number:'+12065550199',label:'Company main',status:'active'}],sms_numbers:[{phone_number:'+12065550199'}],default_number:'+12065550199'};
        if(path==='voice/endpoint/token')return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
        if(path==='voice/endpoint/presence')return {availability:'unavailable'};
        if(path==='call-scripts?published=true')return {scripts:[]};
        if(path.startsWith('calls?')){const query=new URLSearchParams(path.slice(6));let calls=window.fixtureCalls.filter(call=>query.get('active')!=='true'||!['ended','no_answer','busy','failed','canceled'].includes(call.state)).filter(call=>!query.get('direction')||call.direction===query.get('direction')).filter(call=>!query.get('state')||call.state===query.get('state')).filter(call=>!query.get('wrap_up_state')||call.wrap_up_state===query.get('wrap_up_state')).filter(call=>!query.get('query')||`${call.customer_name} ${call.customer_number} ${call.notes}`.toLowerCase().includes(query.get('query').toLowerCase()));return {calls,total:calls.length,next_cursor:null};}
        if(path==='voice/voicemails')return {voicemails:[window.fixtureVoicemail],transcription_enabled:true};
        if(path==='voice/voicemails/call-jane'){if(body.read!==undefined)window.fixtureVoicemail.read_at=body.read?new Date().toISOString():'';if(body.archived!==undefined)window.fixtureVoicemail.archived_at=body.archived?new Date().toISOString():'';return {state:{read_at:window.fixtureVoicemail.read_at,archived_at:window.fixtureVoicemail.archived_at}};}
        if(path.startsWith('voice/contacts'))return {contacts:[{id:'contact-jane',project_id:'project-jane',name:'Jane Test',phone:'+12025550124'}]};
        if(path==='calls/call-jane')return {call:window.fixtureCalls[0],events:[{type:'communication.call.connected',created_at:new Date().toISOString()}]};
        if(path==='calls/call-erik')return {call:window.fixtureCalls[1],events:[]};
        if(path==='calls/call-missed')return {call:window.fixtureCalls[2],events:[]};
        if(path==='calls/call-jane/artifacts')return {artifacts:[{id:'audio-jane',kind:'recording',state:'ready',expires_at:new Date(Date.now()+86400000).toISOString()},{id:'transcript-jane',kind:'transcript',state:'ready',data:{text:'Please call about the roof estimate.'}}]};
        if(path==='calls/call-erik/artifacts')return {artifacts:[]};
        if(path==='calls/call-missed/artifacts')return {artifacts:[]};
        if(path==='conversation-workflow'){if(body.kind==='call'&&body.source_id==='call-missed')window.callUnread=0;if(body.kind==='conversation')window.textUnread=0;return {ok:true};}
        return {};
      },customerUrl:(_org,path)=>`https://phone-modal.test/v1/comms/organizations/org-test/${path}`,inbox:async(_org,params)=>({conversations:params.channel==='call'?[{id:'call-missed',unread_count:window.callUnread,last_message:{direction:'inbound',status:'no_answer'}}]:[{id:'thread-jane',channel:'sms',contact_name:'Jane Test',contact_address:'+12025550124',project_id:'project-jane',unread_count:window.textUnread,last_message:{text:'Hi from Jane',created_at:new Date().toISOString()}}]}),conversation:async()=>({conversation:{messages:[{id:'message-one',channel:'sms',direction:'inbound',text:'Hi from Jane',created_at:new Date().toISOString()}]}}),reply:async(_org,_id,body)=>{window.lastReply=body;return {ok:true};},sms:{send:async(_org,project,body)=>{window.lastNewText={project,body};return {message:{conversation_id:'thread-jane'}};}}};
    });
    await page.evaluate(()=>CommsAPI.sms.groups={list:async()=>({items:[]})});
    for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','apps/comms/communications-ui.js','channels-ui/channels-ui.js','apps/comms/phone-tray.js','apps/comms/calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
    await page.evaluate(()=>Portal.CustomerPhone.open());
    await page.getByRole('button',{name:'Open phone workspace'}).click();
    await page.waitForFunction(()=>typeof Portal.PhoneModal?.open==='function');
    assert.equal(await page.evaluate(()=>typeof Portal.PhoneModal?.open),'function');
    const modal=page.locator('.fmpm-window');await modal.waitFor();
    assert.equal(await modal.getAttribute('data-window'),'modal');
    assert.equal(await modal.locator('.fmpm-call .fmcp').count(),1);
    await page.waitForFunction(()=>[...document.querySelectorAll('.fmpm-window .fmpm-badge')].filter(b=>!b.hidden).length===3);
    assert.equal(await modal.locator('.fmpm-layout.call-view').count(),1);
    await modal.locator('[data-recent=call-missed]').click();
    await modal.locator('.fmpm-detail-head strong').filter({hasText:'Missed Caller'}).waitFor();
    await page.waitForFunction(()=>document.querySelector('[data-tray-tab=call] .fmpm-badge').hidden);
    if(process.env.PHONE_MODAL_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_MODAL_SCREENSHOTS+'/call.png'});
    await page.getByRole('tab',{name:'History'}).click();
    await modal.locator('.fmpm-detail-body p').filter({hasText:'Asked about the roof estimate.'}).first().waitFor();
    assert.equal(await modal.locator('.fmpm-detail-body audio').count(),1);
    if(process.env.PHONE_MODAL_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_MODAL_SCREENSHOTS+'/history.png'});
    await modal.locator('[name=direction]').selectOption('outbound');
    await page.waitForFunction(()=>document.querySelectorAll('[data-history]').length===1);
    assert.match(await modal.locator('[data-history]').first().textContent(),/Erik Demo/);
    await modal.locator('[name=direction]').selectOption('');
    await modal.locator('[name=query]').fill('Jane');
    await page.waitForFunction(()=>document.querySelectorAll('[data-history]').length===1&&document.querySelector('[data-history]').textContent.includes('Jane Test'));
    await page.getByRole('tab',{name:'Text'}).click();
    await modal.locator('.fm-text-body').filter({hasText:'Hi from Jane'}).waitFor();
    await modal.locator('.fmpm-compose textarea').fill('Thanks, Jane');
    await modal.locator('[data-send-text]').click();
    await page.waitForFunction(()=>window.lastReply?.text==='Thanks, Jane');
    assert.equal(await page.evaluate(()=>window.lastReply.business_number),'+12065550199');
    await page.getByRole('tab',{name:'Voicemail'}).click();
    await page.getByText('Please call about the roof estimate.',{exact:true}).last().waitFor();
    await modal.locator('[data-voicemail-archive]').click();
    await modal.locator('[data-voicemail-filter]').selectOption('archived');
    await page.waitForFunction(()=>document.querySelectorAll('[data-voicemail]').length===1);
    await modal.locator('.fmpm-detail [data-voicemail-archive]').waitFor();
    assert.match(await modal.locator('.fmpm-detail').last().textContent(),/Please call about the roof estimate/);
    if(process.env.PHONE_MODAL_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_MODAL_SCREENSHOTS+'/desktop.png'});
    await modal.locator('[data-window-action=close]').click();
    assert.equal(await page.locator('.fm-phone-tray:not(.fmpm-call) .fmcp').count(),1);
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>Portal.PhoneModal.open('text'));
    await page.waitForFunction(()=>document.querySelector('.fmpm-window')?.getAttribute('data-window')==='fullscreen');
    if(process.env.PHONE_MODAL_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_MODAL_SCREENSHOTS+'/mobile.png'});
    const bounds=await modal.boundingBox();assert.ok(bounds.width<=390&&bounds.x>=0,JSON.stringify(bounds));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
