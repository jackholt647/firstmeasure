// Real-browser regression checks with an isolated in-memory API and fake devices.
// Does not log in, send messages, invite users, or change production data.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const publicRoot = path.resolve('..');
const output = path.resolve('../../output/channels-workspace');
await mkdir(output, {recursive:true});
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (name === '/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial"><main class="main" style="position:relative;height:100vh"><div id="app" style="height:100vh"></div></main></body></html>'); return; }
  const filename = path.resolve(publicRoot, '.' + name);
  if (!filename.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  try { const data = await readFile(filename); response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream'); response.end(data); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log('Starting isolated browser', origin);
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport:{width:1366,height:768}});
page.setDefaultTimeout(15000);
console.log('Browser ready');
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin);
  await page.evaluate(() => {
    window.invitedUsers = []; window.leftCalls = []; window.createdConversations = []; window.sent = []; window.scheduled = []; window.uploaded = [];
    const me = {id:'owner', name:'Morgan Lee'};
    const invitee = {id:'invitee',name:'Livia',email:'livia@example.test'};
    const other = {id:'guest', name:'Jordan Ellis',email:'jordan@example.test',title:'Project manager',department:'Operations',time_zone:'America/Los_Angeles',phone:'+1 555 0100',bio:'Helping the team deliver great projects.'};
    const agent = {id:'agent_assistant', name:'FirstMate'};
    const channel = {id:'general', type:'public', name:'general', message_seq:42, display_name:'Team room', members:[me,other,invitee], member_count:3, can_manage:true, unread:{last_read_seq:0}, settings:{}, permissions:{}, is_member:true};
    const messages = [{id:'message1', channel_id:'general', seq:1, text:'Ready for the **project review**?\n\n- Review the plan\n- Confirm next steps', author:other, created_at:new Date().toISOString(), can_edit:true, can_delete:true, reactions:[]}];
    window.sidebarPreferences = {send_mode:'enter'}; window.sidebarReads = []; window.splitOpened = null;
    window.testMessages = messages; window.testChannel = channel; window.createdHuddles = 0;
    let huddle;
    window.__APP = {userId:me.id, userOrgId:'test-org', userName:me.name};
    window.Portal = {currentUser:me, ui:{showToast:(title, detail) => window.lastToast = title + ': ' + detail}, appFlags:{current:()=>true, has:()=>true}};
    window.ChannelsAPI = {
      channels:{setNotifyLevel:async(_org,_id,userId,level)=>{channel.members.find(person=>person.id===userId).notify_level=level;return {}},list:async()=>({channels:[channel]}), get:async()=>({channel}), create:async(_org,input)=>{window.createdConversations.push(input);return {channel:{...channel,id:'assistant-new',type:'dm',display_name:input.name,members:[me,agent]}}}},
      messages:{get:async(_org,id)=>({message:messages.find(item=>item.id===id)}),list:async(_org,_channel,options={})=>({channel,messages:messages.filter(item=>!item.parent_id && (!options.before || item.seq<options.before)).slice(-(options.limit || 60))}),post:async(_org,_channel,input)=>{window.sent.push(input);const message={...messages[0],...input,id:'sent'+window.sent.length,author:me,seq:window.sent.length+1};if(input.forwarded_message_id){const original=messages.find(item=>item.id===input.forwarded_message_id);message.metadata={forwarded:{...original,message_id:original.id,channel_name:'Team room'}};message.attachments=input.forward_include_attachments?original.attachments:[];}messages.push(message);return {message}},edit:async(_org,id,input)=>({message:{...messages[0],...input,id}}),thread:async(_org,id)=>({root:messages.find(item=>item.id===id),replies:messages.filter(item=>item.parent_id===id)})},
      preferences:{collaboration:async()=>({preferences:{...window.sidebarPreferences}}),updateCollaboration:async(_org,patch)=>{Object.assign(window.sidebarPreferences,patch);return {preferences:{...window.sidebarPreferences}}}},
      directory:{list:async()=>({users:[me,other,agent]})},
      readState:{markRead:async(_org,id,seq)=>{window.sidebarReads.push({id,seq});return {}}},
      drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},
      scheduled:{list:async()=>({scheduled_messages:window.scheduled}),remove:async(_org,id)=>{window.scheduled=window.scheduled.filter(item=>item.id!==id);return {}},create:async(_org,input)=>{const item={...input,id:'scheduled'+(window.scheduled.length+1),state:'scheduled',sender_user_id:me.id};window.scheduled.push(item);return {scheduled_message:item}}},
      uploads:{send:async(_org,file,channelId)=>{window.uploaded.push({size:file.size,type:file.type,channelId});return {attachment:{id:'clip1',file_name:file.name}}}},
      huddles:{invite:async(_org,_id,ids)=>{window.invitedUsers.push(...ids);return {invited_user_ids:ids}},create:async()=>{window.createdHuddles++;huddle={id:'call1',channel_id:channel.id,started_by:me.id,state:'active',started_at:new Date().toISOString(),settings:{recording_enabled:false},participants:[{...me,user_id:me.id,display_name:me.name,microphone_enabled:true},{...other,user_id:other.id,display_name:other.name,microphone_enabled:false}]};return {huddle}},join:async()=>({huddle}),get:async()=>({huddle}),mediaState:async(_org,_id,patch)=>{Object.assign(huddle.participants[0],patch);return {huddle}},signals:async()=>({signals:[],cursor:0}),signal:async()=>({}),leave:async()=>{window.leftCalls.push('call1');return {}},end:async()=>({})}
    };
    window.PlatformAssistant = {openChannelConversation:async options => {window.recapOptions=options;}};
    window.testOptions = {onOpenChannel:(id,options)=>window.splitOpened={id,options},orgId:'test-org',currentUser:me,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:true,typing:false,audioNotes:false,channelCreate:false,channelSettings:true,recording:false}};
    // A real camera stream stands in for the display picker in unattended tests.
    navigator.mediaDevices.getDisplayMedia = async () => { window.displayStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true}); return window.displayStream; };
  });
  await page.addScriptTag({url:origin+'/libraries/navigation/portal-navigation.js'});
  await page.addScriptTag({url:origin+'/libraries/calls-runtime/livekit-client.umd.js'});
  await page.addScriptTag({url:origin+'/libraries/window-manager/window-manager.js'});
  await page.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
  await page.addScriptTag({url:origin+'/libraries/platform-tags/platform-tags.js'});
  await page.evaluate(() => window.instance = FirstMateChannels.create(document.querySelector('#app'), window.testOptions));
  console.log('Channels mounted');
  await page.evaluate(()=>instance.setChannel('general'));
  await page.getByRole('button',{name:'Ask FirstMate for a recap',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.recapOptions),{orgId:'test-org',channelId:'general'});
  assert.equal(await page.evaluate(()=>window.sent.length),0);
  console.log('PASS channel recap opens private assistant without posting to the channel');
  await page.evaluate(() => {
    testChannel.type='dm';testMessages[0].reactions=[{emoji:'🔥',count:2,user_ids:['guest','owner'],users:[{id:'guest',name:'Jordan Ellis'},{id:'owner',name:'Morgan Lee'}]}];
    window.PlatformRealtime={watchPresence:(_org,_scope,callback)=>{window.statusRoster=callback;return ()=>{};},subscribe:()=>()=>{}};
    const mount=document.createElement('div');mount.id='status-check';mount.style='position:fixed;inset:0;z-index:99999;background:white';document.body.append(mount);
    window.statusInstance=FirstMateChannels.create(mount,{...testOptions,realtime:true});
  });
  const statusRoot=page.locator('#status-check');
  await statusRoot.locator('.fm-ch-msg').first().waitFor();
  await page.evaluate(()=>statusRoster([{user_id:'guest',status:'active'}]));
  const dot=statusRoot.locator('.fm-ch-side-row .fm-ch-presence-dot');
  assert.equal(await dot.getAttribute('aria-label'),'Active');
  assert.equal(await dot.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(22, 163, 74)');
  assert.equal(await statusRoot.locator('.fm-ch-msg [data-online-user]').count(),0);
  await statusRoot.locator('.fm-ch-msg-author').first().click();
  assert.equal(await page.locator('.fm-ch-profile-card [data-online-user]').getAttribute('aria-label'),'Active');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>statusRoster([{user_id:'guest',status:'away'}]));
  assert.equal(await dot.getAttribute('aria-label'),'Away');
  assert.equal(await dot.evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(152, 162, 179)');
  await statusRoot.locator('.fm-ch-reaction').hover();
  assert.equal(await statusRoot.locator('.fm-ch-reaction').getAttribute('title'),'Jordan Ellis, Morgan Lee reacted with 🔥');
  await page.evaluate(()=>statusRoster([]));assert.equal(await dot.evaluate(node=>getComputedStyle(node).visibility),'hidden');
  await page.screenshot({animations:'disabled',path:path.join(output,'presence-reaction-followup.png')});
  await page.evaluate(()=>{statusInstance.destroy();document.querySelector('#status-check').remove();delete window.PlatformRealtime;testChannel.type='public';testMessages[0].reactions=[];});
  console.log('PASS DM corner status, profile status, no message dots, active/away/offline and named reaction tooltip');
  await page.evaluate(() => {
    window.typingSent = [];
    ChannelsAPI.typing = {note:async(_org,id,typing)=>typingSent.push({id,typing,time:performance.now()})};
    instance.setFeatures({typing:true});
  });
  const typingEditor = page.locator('.fm-ch-composer .fm-ch-rich-editor');
  await typingEditor.waitFor();
  const typingStarted = await page.evaluate(()=>performance.now());
  await typingEditor.fill('Typing now');
  await page.waitForFunction(()=>typingSent.some(event=>event.typing));
  assert.ok((await page.evaluate(()=>typingSent[0].time))-typingStarted < 1000,'first input should publish immediately');
  await typingEditor.press('x');
  assert.equal(await page.evaluate(()=>typingSent.filter(event=>event.typing).length),1,'keystrokes should be throttled');
  await typingEditor.evaluate(element=>element.blur());
  await page.waitForFunction(()=>typingSent.at(-1)?.typing===false);
  await typingEditor.fill('');
  await page.evaluate(() => {
    instance.setFeatures({typing:false});
    window.PlatformRealtime = {subscribe:(_org,_prefix,handler)=>{window.receiveTyping=handler;return ()=>{};}};
    const host=document.createElement('div'); host.id='typing-test'; document.body.append(host);
    window.typingList=FirstMateChannels.create(host,{...testOptions,mode:'list',realtime:true,features:{...testOptions.features,typing:true}});
  });
  const typingRow=page.locator('#typing-test .fm-ch-side-row[data-channel-id="general"]');
  await typingRow.waitFor();
  await page.evaluate(()=>receiveTyping({topic:'channels.typing',payload:{channel_id:'general',user_id:'guest',user_name:'Jordan',typing:true,expires_in_ms:6000}}));
  await typingRow.locator('.fm-ch-side-typing:visible').waitFor();
  assert.match(await typingRow.locator('.fm-ch-side-typing').getAttribute('aria-label'),/Jordan is typing/);
  await page.evaluate(()=>receiveTyping({topic:'channels.typing',payload:{channel_id:'general',user_id:'invitee',user_name:'Livia',typing:true,expires_at:new Date(Date.now()+600).toISOString()}}));
  await page.evaluate(()=>receiveTyping({topic:'channels.typing',payload:{channel_id:'general',user_id:'guest',typing:false}}));
  assert.match(await typingRow.locator('.fm-ch-side-typing').getAttribute('aria-label'),/Livia is typing/);
  await typingRow.locator('.fm-ch-side-typing:visible').waitFor({state:'hidden'});
  await page.evaluate(()=>receiveTyping({topic:'channels.typing',payload:{channel_id:'general',user_id:'owner',user_name:'Me',typing:true,expires_in_ms:6000}}));
  assert.equal(await typingRow.locator('.fm-ch-side-typing:visible').count(),0,'own typing is not displayed');
  await page.evaluate(()=>{typingList.destroy();document.querySelector('#typing-test').remove();delete window.PlatformRealtime;});
  console.log('PASS immediate typing, throttling, blur stop, inactive sidebar, multiple typists and expiry');
  await page.evaluate(async()=>{
    ChannelsAPI.tabs={list:async()=>({tabs:[{kind:'messages',label:'Messages'},{kind:'files',label:'Files'},{kind:'documents',label:'Documents'},{kind:'pins',label:'Pins'}]})};
    ChannelsAPI.resources={list:async(_org,_channel,options)=>{window.filesQuery=options;return {resources:[
      {resource_type:'media',resource_id:'photo',resource:{file_name:'Shared photo.png',content_type:'image/png'}},
      {resource_type:'media',resource_id:'report',resource:{file_name:'Report.pdf',content_type:'application/pdf'}},
      {resource_type:'document',resource_id:'doc',resource:{title:'Meeting notes'}}
    ]};}};
    ChannelsAPI.mediaFileUrl=(_org,id)=>`/media/${id}`;
    instance.setFeatures({resources:true});
    await instance.setChannel('general');
  });
  await page.locator('.fm-ch-tab').getByText('Files',{exact:true}).click();
  await page.getByRole('link',{name:/Shared photo.png/}).waitFor();
  assert.equal(await page.locator('.fm-ch-tab').getByText('Files',{exact:true}).count(),1);
  assert.equal(await page.locator('.fm-ch-tab').getByText('Documents',{exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:/Report.pdf/}).getAttribute('href'),'/media/report');
  await page.locator('.fm-ch-resource').getByText('Meeting notes',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>filesQuery),{type:'files'});
  await page.locator('.fm-ch-tab').getByText('Messages',{exact:true}).click();
  await page.evaluate(()=>{
    ChannelsAPI.pins={list:async()=>({messages:testMessages.filter(message=>message.pinned_at)})};
    ChannelsAPI.messages.pin=async(_org,id)=>{const message=testMessages.find(item=>item.id===id);message.pinned_at=new Date().toISOString();return {message:{...message}};};
    ChannelsAPI.messages.unpin=async(_org,id)=>{const message=testMessages.find(item=>item.id===id);message.pinned_at=null;return {message:{...message}};};
  });
  await page.locator('.fm-ch-tab').getByText('Pins',{exact:true}).click();
  await page.getByText('Easy access to all of your most important messages. Right-click on a message to pin it to the channel.',{exact:true}).waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'pins-empty.png')});
  await page.locator('.fm-ch-tab').getByText('Messages',{exact:true}).click();
  await page.locator('.fm-ch-msg').first().click({button:'right'});
  await page.getByRole('menuitem',{name:'Pin to channel',exact:true}).click();
  await page.locator('.fm-ch-msg-pinned .fm-ch-pin-label').waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'pinned-in-conversation.png')});
  await page.locator('.fm-ch-tab').getByText('Pins',{exact:true}).click();
  await page.locator('.fm-ch-pins-list .fm-ch-msg-pinned').waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'pins-tab.png')});
  await page.locator('.fm-ch-pins-list .fm-ch-msg').first().focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem',{name:'Unpin',exact:true}).click();
  await page.locator('.fm-ch-pins-empty').waitFor();
  assert.equal(await page.locator('.fm-ch-pins-list .fm-ch-msg').count(),0);
  await page.locator('.fm-ch-tab').getByText('Messages',{exact:true}).click();
  assert.equal(await page.locator('.fm-ch-msg-pinned').count(),0);
  console.log('PASS right-click pinning, pinned message styling, Pins empty state and immediate unpin refresh');
  await page.evaluate(()=>instance.setFeatures({resources:false}));
  console.log('PASS unified Files tab, legacy Documents tabs, shared filenames and file links');
  await typingEditor.fill(''); await typingEditor.pressSequentially('@');
  await page.locator('#fmMentionMenu.visible [data-mention-user="broadcast:channel"]').waitFor();
  await typingEditor.press('Enter');
  assert.match(await typingEditor.innerText(),/@channel/);
  await typingEditor.fill(''); await typingEditor.pressSequentially('@gener');
  await page.locator('#fmMentionMenu.visible [data-mention-user="channel:general"]').waitFor();
  await typingEditor.press('Enter');
  assert.match(await typingEditor.innerText(),/@general/);
  await typingEditor.fill(''); await typingEditor.pressSequentially('@Jordan');
  await page.locator('#fmMentionMenu.visible [data-mention-user="guest"]').waitFor();
  await typingEditor.press('Enter');
  assert.match(await typingEditor.innerText(),/@Jordan Ellis/);
  await typingEditor.fill('');
  console.log('PASS rich editor @ suggestions, broadcast and channel mentions, keyboard selection');
  await page.evaluate(async()=>{
    testChannel.type='project';testChannel.project_id='project-test';
    const app=document.querySelector('#app'), form=document.createElement('form'); form.id='project-form'; app.replaceWith(form); form.append(app);
    window.projectSubmits=0; form.addEventListener('submit',event=>{event.preventDefault();projectSubmits++;});
    await instance.setChannel('general');
  });
  await typingEditor.fill('Project channel message');
  const projectSend=page.locator('.fm-ch-composer .fm-ch-send');
  assert.equal(await projectSend.isEnabled(),true);
  await projectSend.click();
  await page.waitForFunction(()=>sent.some(message=>message.text==='Project channel message'));
  assert.equal(await page.evaluate(()=>projectSubmits),0,'channel send must not submit its surrounding project form');
  await page.evaluate(async()=>{testChannel.type='public';delete testChannel.project_id;window.sent=[];testMessages.splice(1);const form=document.querySelector('#project-form');form.replaceWith(document.querySelector('#app'));await instance.setChannel('general');});
  console.log('PASS project channel typing and sending inside a project form');
  await page.evaluate(async()=>{
    testMessages.push({...testMessages[0],id:'ended-call',text:'Huddle started',metadata:{event:'huddle_started',huddle_id:'past-call'},huddle:{state:'ended',started_at:'2026-09-28T10:00:00Z',ended_at:'2026-09-28T10:02:05Z',artifacts:[{kind:'transcript',metadata:{text:'Call transcript text'}},{kind:'video_recording',media_id:'recorded-video'}]}});
    await instance.refresh();
  });
  const endedCard=page.locator('[data-message-id="ended-call"]');
  await endedCard.getByText('Huddle ended · 2m 5s',{exact:true}).waitFor();
  await endedCard.getByRole('button',{name:'Start a new huddle',exact:true}).waitFor();
  await endedCard.locator('summary').click();
  await endedCard.getByText('Call transcript text',{exact:true}).waitFor();
  assert.equal(await endedCard.getByRole('link',{name:'Video recording'}).getAttribute('href'),'/media/recorded-video');
  await page.evaluate(async()=>{testMessages.splice(1);await instance.refresh();});
  console.log('PASS ended huddle message duration, transcript, recording and new-call action');
  await page.evaluate(async()=>{
    for(let i=2;i<=55;i++) testMessages.push({...testMessages[0],id:`scroll-${i}`,seq:i,text:`History message ${i}\n\nSecond line`,translation:{available:true,target_language:'es',auto_translate:false}});
    ChannelsAPI.messages.translate=async()=>new Promise(resolve=>window.finishTranslation=resolve);
    await instance.setChannel('general');
    const list=document.querySelector('.fm-ch-list'), row=list.querySelector('[data-message-id="scroll-15"]');
    list.scrollTop+=row.getBoundingClientRect().top-list.getBoundingClientRect().top-20;
    window.unchangedMessage=list.querySelector('[data-message-id="scroll-16"]');
  });
  const historyList=page.locator('.fm-ch-list');
  const initialScroll=await historyList.evaluate(node=>node.scrollTop);
  await page.locator('[data-message-id="scroll-15"] [data-act="translate"]').click();
  assert.ok(Math.abs(await historyList.evaluate(node=>node.scrollTop)-initialScroll)<2,'starting translation preserves scroll');
  const anchorBefore=await historyList.evaluate(list=>{
    list.scrollTop+=180;
    const top=list.getBoundingClientRect().top;
    const row=[...list.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>top);
    return {id:row.dataset.messageId,offset:row.getBoundingClientRect().top-top};
  });
  await page.evaluate(()=>finishTranslation({translation:{translated_text:'Translated message\n\n'+('Longer translated paragraph.\n\n'.repeat(12))}}));
  await page.locator('[data-message-id="scroll-15"] [data-act="translate"][aria-pressed="true"]').waitFor();
  const anchorAfter=await historyList.evaluate((list,id)=>list.querySelector(`[data-message-id="${id}"]`).getBoundingClientRect().top-list.getBoundingClientRect().top,anchorBefore.id);
  assert.ok(Math.abs(anchorAfter-anchorBefore.offset)<2,'completion preserves the current viewport after scrolling during the request');
  assert.equal(await page.evaluate(()=>unchangedMessage===document.querySelector('[data-message-id="scroll-16"]')),true,'unrelated message rows remain mounted');
  await page.evaluate(()=>{const list=document.querySelector('.fm-ch-list'),row=list.querySelector('[data-message-id="scroll-15"]');list.scrollTop+=row.getBoundingClientRect().top-list.getBoundingClientRect().top-20;});
  const toggleScroll=await historyList.evaluate(node=>node.scrollTop);
  await page.locator('[data-message-id="scroll-15"] [data-act="translate"]').click();
  assert.ok(Math.abs(await historyList.evaluate(node=>node.scrollTop)-toggleScroll)<2,'show original preserves scroll');
  await page.locator('[data-message-id="scroll-15"] [data-act="translate"]').click();
  assert.ok(Math.abs(await historyList.evaluate(node=>node.scrollTop)-toggleScroll)<2,'cached translation preserves scroll');
  await page.evaluate(async()=>{
    for(let i=1;i<=25;i++) testMessages.push({...testMessages[1],id:`reply-scroll-${i}`,parent_id:'scroll-15',text:`Thread reply ${i}`,translation:{available:true,target_language:'es',auto_translate:false}});
    await instance.openThread('scroll-15');
    const panel=document.querySelector('.fm-ch-panel'),list=panel.querySelector('.fm-ch-panel-body'),row=list.querySelector('[data-message-id="reply-scroll-10"]');
    list.scrollTop+=row.getBoundingClientRect().top-list.getBoundingClientRect().top-20;
    window.threadDraft=panel.querySelector('.fm-ch-rich-editor');threadDraft.value='Unsent reply';
  });
  const threadList=page.locator('.fm-ch-panel-body');
  const threadScroll=await threadList.evaluate(node=>node.scrollTop);
  await threadList.locator('[data-message-id="reply-scroll-10"] [data-act="translate"]').click();
  await page.evaluate(()=>finishTranslation({translation:{translated_text:'Translated reply'}}));
  await threadList.locator('[data-message-id="reply-scroll-10"] [aria-pressed="true"]').waitFor();
  assert.ok(Math.abs(await threadList.evaluate(node=>node.scrollTop)-threadScroll)<2,'thread translation preserves scroll');
  assert.equal(await page.evaluate(()=>threadDraft.isConnected && threadDraft.value==='Unsent reply'),true,'thread composer and draft remain mounted');
  await page.evaluate(()=>instance.setChannel('general'));
  await page.evaluate(()=>{
    window.bulkTranslations=[];window.bulkActive=0;window.bulkMax=0;
    ChannelsAPI.messages.translate=async(_org,id)=>{
      bulkTranslations.push(id);bulkActive++;bulkMax=Math.max(bulkMax,bulkActive);
      await new Promise(resolve=>setTimeout(resolve,10));bulkActive--;
      return {translation:{translated_text:`Translated ${id}`}};
    };
  });
  await page.getByRole('button',{name:'Translate All',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.fm-ch-list .fm-ch-translate.loading') && [...document.querySelectorAll('.fm-ch-list .fm-ch-translate')].every(button=>button.getAttribute('aria-pressed')==='true'));
  assert.ok(await page.evaluate(()=>bulkTranslations.includes('scroll-2') && bulkTranslations.includes('scroll-55')),'bulk action translates the conversation');
  assert.ok(await page.evaluate(()=>bulkMax<=2),'bulk translations are concurrency limited');
  await page.getByRole('button',{name:'Show Originals',exact:true}).click();
  assert.equal(await page.locator('.fm-ch-list .fm-ch-translate[aria-pressed="true"]').count(),0);
  const translatedCount=await page.evaluate(()=>bulkTranslations.length);
  await page.getByRole('button',{name:'Translate All',exact:true}).click();
  assert.equal(await page.evaluate(()=>bulkTranslations.length),translatedCount,'existing translations are reused');
  await page.getByRole('button',{name:'Show Originals',exact:true}).click();
  await page.evaluate(async()=>{testMessages.splice(1);await instance.refresh();});
  console.log('PASS inline translation preserves scroll during loading, completion and toggling');
  console.log('PASS Translate All, Show Originals, cached results and bounded requests');
  const sideRow = page.locator('.fm-ch-side-row[data-channel-id="general"]');
  await sideRow.hover();
  assert.equal(await sideRow.locator('.fm-ch-side-actions button:visible').count(),2);
  await sideRow.getByRole('button',{name:'More options for Team room',exact:true}).click();
  await page.getByRole('menuitem',{name:'Mute',exact:true}).click();
  await page.locator('.fm-ch-side-row.muted').waitFor();
  await sideRow.hover();
  await sideRow.getByRole('button',{name:'More options for Team room',exact:true}).click();
  await page.getByRole('menuitem',{name:'Unmute',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await sideRow.getByRole('button',{name:'More options for Team room',exact:true}).click();
  await page.getByRole('menuitem',{name:'Mark as read',exact:true}).click();
  assert.ok((await page.evaluate(()=>sidebarReads)).some(item=>item.id==='general' && item.seq===42));
  await sideRow.hover();
  await sideRow.getByRole('button',{name:'More options for Team room',exact:true}).click();
  await page.getByRole('menuitem',{name:'Open in split view',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>splitOpened),{id:'general',options:{windowMode:'docked'}});
  await sideRow.hover();
  await page.screenshot({animations:'disabled',path:path.join(output,'channel-hover-actions.png')});
  await sideRow.getByRole('button',{name:'Hide Team room',exact:true}).click();
  await sideRow.waitFor({state:'detached'});
  assert.deepEqual(await page.evaluate(()=>sidebarPreferences.hidden_channel_ids),['general']);
  await page.evaluate(()=>instance.refresh());
  await page.getByRole('button',{name:'Hidden conversations (1)',exact:true}).click();
  await page.getByRole('button',{name:'Show Team room',exact:true}).click();
  await sideRow.waitFor();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  console.log('PASS sidebar hover actions, mute, mark read, split options, saved hide and restore');

  if (!process.env.CHANNELS_PEER_ONLY) {
  await page.getByRole('button',{name:'View Jordan Ellis profile',exact:true}).click();
  await page.getByRole('link',{name:'jordan@example.test'}).waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'user-profile.png')});
  await page.getByRole('button',{name:'View profile',exact:true}).click();
  await page.locator('.fm-ch-profile-panel').waitFor();
  await page.locator('.fm-ch-profile-panel').getByText('Operations',{exact:true}).waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'full-user-profile.png')});
  await page.goBack(); await page.locator('.fm-ch-profile-panel').waitFor({state:'detached'});
  await page.goForward(); await page.locator('.fm-ch-profile-panel').waitFor();
  await page.getByRole('button',{name:'Close profile',exact:true}).click();
  await page.locator('.fm-ch-profile-panel').waitFor({state:'detached'});
  await page.keyboard.press('Escape');
  await page.locator('.fm-ch-msg-author').first().click();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('.fm-ch-msg-author').first().click();
  await page.getByRole('button',{name:'Message',exact:true}).click();
  await page.waitForFunction(()=>createdConversations.length===1);
  assert.deepEqual(await page.evaluate(()=>createdConversations[0].member_user_ids),['guest']);
  await page.getByTitle('Channel settings',{exact:true}).click();
  assert.equal(await page.locator('[data-field=huddle-recording]').count(),0);
  assert.doesNotMatch(await page.locator('.fm-ch-modal').innerText(),/recording|retention/i);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  if (!process.env.CHANNELS_LAYOUT_ONLY) {
  const editor = page.locator('.fm-ch-composer .fm-ch-rich-editor');
  await editor.waitFor();
  await editor.fill('A rich message'); await editor.press('Control+a');
  await page.getByRole('button',{name:'Bold',exact:true}).click();
  assert.equal(await editor.locator('b,strong').textContent(), 'A rich message');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  console.log('Rich message sent');
  assert.match(await page.evaluate(()=>sent[0].text), /\*\*A rich message\*\*/);
  assert.equal(await page.locator('.fm-ch-msg-body strong').last().textContent(), 'A rich message');
  await editor.click(); await page.getByRole('button',{name:'Table',exact:true}).click();
  await page.getByRole('button',{name:'3 rows by 3 columns',exact:true}).click();
  assert.equal(await editor.locator('table tr').count(),3);
  await editor.locator('td').first().click(); await page.keyboard.type('Project A');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  assert.match(await page.evaluate(()=>sent[1].text),/Project A/);
  assert.equal(await page.locator('.fm-ch-msg-body table').count(),1);
  await page.locator('.fm-ch-msg').first().hover();
  assert.equal(await page.locator('.fm-ch-toolbar').first().locator('button').count(),4);
  await page.getByRole('button',{name:'More message actions'}).first().click();
  assert.ok(await page.getByRole('menuitem',{name:'Edit message'}).isVisible());
  await page.keyboard.press('Escape');
  await editor.fill('Send this later');
  await page.getByRole('button',{name:'Schedule message',exact:true}).click();
  const scheduleValue = await page.locator('[data-field=scheduled]').inputValue();
  await page.waitForFunction(()=>{
    const shadow=document.querySelector('fm-date-time-picker')?.shadowRoot;
    const selected=shadow?.querySelector('[data-slot][aria-pressed=true]'),slots=shadow?.querySelector('.slots');
    if(!selected||!slots)return false;
    const a=selected.getBoundingClientRect(),b=slots.getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;
  });
  const earliestDate=await page.locator('[data-field=scheduled]').getAttribute('min');
  if(scheduleValue.slice(0,10)===earliestDate.slice(0,10))assert.ok(await page.locator('fm-date-time-picker').locator('[data-slot]:disabled').count()>0);
  const scheduledDelay = await page.evaluate(value => new Date(value).getTime() - Date.now(), scheduleValue);
  assert.ok(scheduledDelay >= 55 * 60000 && scheduledDelay <= 76 * 60000, 'picker represents a local time about one hour ahead');
  assert.equal(await page.locator('[data-field=scheduled]').isVisible(),false);
  assert.ok(await page.locator('fm-date-time-picker').getByRole('group',{name:'Calendar',exact:true}).isVisible());
  await page.locator('fm-date-time-picker').locator('[data-date][aria-pressed=true]').click();
  await page.getByRole('button',{name:'Schedule send',exact:true}).click();
  assert.equal(await page.evaluate(()=>scheduled.length),1);
  await page.locator('.fm-ch-scheduled-message').waitFor();
  assert.match(await page.locator('.fm-ch-scheduled-message').innerText(),/Only visible to you/);
  await page.getByRole('button',{name:'Cancel scheduled message',exact:true}).click();
  await page.locator('.fm-ch-scheduled-message').waitFor({state:'detached'});
  // Existing small tables also open in a full-window viewer.
  await page.locator('.fm-ch-msg-body table').click();
  await page.getByRole('dialog',{name:'Table',exact:true}).waitFor();
  await page.getByRole('button',{name:'Download TSV',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  const tsv = Array.from({length:125}, (_, i) => `${i}\tCell | ${i}\t${'large cell '.repeat(20)}`).join('\n');
  await editor.fill(''); await editor.focus();
  await editor.evaluate((node, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    node.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles:true, cancelable:true}));
  }, tsv);
  assert.equal(await editor.locator('table tr').count(),125);
  assert.equal(await editor.locator('table tr:visible').count(),10);
  assert.ok((await editor.evaluate(node=>node.value)).length>20000);
  await editor.getByRole('button',{name:/Open \/ edit table/}).click();
  const tableModal = page.getByRole('dialog',{name:'Table',exact:true});
  assert.equal(await tableModal.locator('table tr:visible').count(),125);
  await tableModal.locator('td').first().click();
  await tableModal.getByRole('button',{name:'Row below',exact:true}).click();
  assert.equal(await tableModal.locator('table tr').count(),126);
  await tableModal.locator('td').first().click();
  await tableModal.getByRole('button',{name:'Column right',exact:true}).click();
  assert.equal(await tableModal.locator('table tr').first().locator('th,td').count(),4);
  await tableModal.getByRole('button',{name:'Save table',exact:true}).click();
  const serialized = await editor.evaluate(node=>node.value);
  assert.match(serialized,/Cell \\\| 124/);
  await editor.evaluate((node,value)=>node.value=value,serialized);
  assert.equal(await editor.locator('table tr').count(),126);
  assert.equal(await editor.locator('table tr:visible').count(),10);
  await page.screenshot({animations:'disabled',path:path.join(output,'large-table-draft.png')});
  await editor.getByRole('button',{name:/Open \/ edit table/}).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button',{name:'Download TSV',exact:true}).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(),'table.tsv');
  const savedTsv = await readFile(await download.path(),'utf8');
  assert.match(savedTsv,/Cell \| 124/);
  assert.equal(savedTsv.split('\r\n').length,126);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Send',exact:true}).click();
  const sentTable = page.locator('.fm-ch-msg-body .fm-ch-table-card').last();
  assert.equal(await sentTable.locator('tr').count(),126);
  assert.equal(await sentTable.locator('tr:visible').count(),10);
  await sentTable.getByRole('button',{name:/Open full table/}).click();
  assert.equal(await page.getByRole('dialog',{name:'Table',exact:true}).locator('tr:visible').count(),126);
  await page.screenshot({animations:'disabled',path:path.join(output,'full-table-viewer.png')});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  // Resizing survives draft serialization and reopening.
  await editor.evaluate(node=>node.value='| A | B |\n| --- | --- |\n| one | two |');
  const edge = await editor.locator('th').first().boundingBox();
  await page.mouse.move(edge.x + edge.width - 2, edge.y + 12); await page.mouse.down();
  await page.mouse.move(edge.x + edge.width + 55, edge.y + 12); await page.mouse.up();
  const resized = await editor.evaluate(node=>node.value);
  assert.match(resized,/fm-table-widths:/);
  await editor.evaluate((node,value)=>node.value=value,resized);
  const restored = await editor.locator('th').first().boundingBox();
  assert.ok(restored.width > edge.width + 40);
  // Spreadsheet HTML is reduced to inert cell text.
  await editor.fill(''); await editor.focus();
  await editor.evaluate(node=>{
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html','<table><tr><td>Hello<img src=x onerror="window.pasteExecuted=true"></td><td>World</td></tr></table>');
    clipboardData.setData('text/plain','Hello\tWorld');
    node.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
  });
  assert.equal(await editor.locator('td,th').count(),2);
  assert.equal(await editor.locator('img').count(),0);
  assert.equal(await page.evaluate(()=>Boolean(window.pasteExecuted)),false);
  await editor.fill('');
  console.log('PASS table paste, compact preview, modal editing and serialization');
  await page.getByTitle('Record screen clip',{exact:true}).click();
  console.log('Clip opened');
  await page.getByRole('dialog',{name:'Record your screen'}).waitFor();
  assert.equal(await page.evaluate(()=>Boolean(window.displayStream)),false);
  await page.getByRole('button',{name:'Share screen',exact:true}).click();
  await page.waitForFunction(()=>Boolean(window.displayStream));
  assert.equal(await page.evaluate(()=>uploaded.length),0);
  assert.equal(await page.getByRole('button',{name:'Start recording',exact:true}).isVisible(),false);
  await page.waitForTimeout(3000);
  await page.evaluate(()=>{const track=window.displayStream.getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended'));});
  await page.getByRole('button',{name:'Attach clip',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>uploaded.length),0);
  await page.getByRole('button',{name:'Attach clip',exact:true}).click();
  await page.waitForFunction(()=>uploaded.length===1);
  assert.ok(await page.evaluate(()=>uploaded[0].size>0));
  assert.equal(await page.evaluate(()=>sent.length),3);
  assert.deepEqual(errors,[]);
  console.log('PASS screen explanation, automatic start/stop, preview and attachment');
  await editor.fill('Quoted text'); await editor.press('Control+a');
  await page.getByRole('button',{name:'Quote',exact:true}).click();
  await editor.press('End'); await editor.press('Enter'); await page.keyboard.type('Outside quote');
  assert.equal(await editor.locator('blockquote').innerText(),'Quoted text');
  assert.ok((await editor.evaluate(node=>node.value)).includes('\nOutside quote'));
  assert.equal(await page.evaluate(()=>sent.length),3,'quote Enter must not send');
  await editor.fill(''); await editor.focus();
  await page.getByRole('button',{name:'Link',exact:true}).click();
  const linkModal=page.getByRole('dialog',{name:'Insert link',exact:true});
  await linkModal.getByLabel('Link text').fill('Project [notes]');
  await linkModal.getByLabel('Web address').fill('javascript:alert(1)');
  await linkModal.getByRole('button',{name:'Insert link',exact:true}).click();
  assert.match(await linkModal.getByRole('alert').innerText(),/http/);
  await linkModal.getByLabel('Web address').fill('https://example.test/project(one)');
  await page.screenshot({animations:'disabled',path:path.join(output,'link-editor.png')});
  await linkModal.getByRole('button',{name:'Insert link',exact:true}).click();
  const linkText=await editor.evaluate(node=>node.value);
  await editor.evaluate((node,value)=>node.value=value,linkText);
  assert.equal(await editor.locator('a').innerText(),'Project [notes]');
  assert.equal(await editor.locator('a').getAttribute('href'),'https://example.test/project%28one%29');
  await editor.fill('');
  await editor.evaluate(node=>{
    const clipboardData=new DataTransfer(); clipboardData.items.add(new File([new Uint8Array([137,80,78,71])],'pasted.png',{type:'image/png'}));
    clipboardData.items.add(new File(['notes'],'notes.txt',{type:'text/plain'}));
    node.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
  });
  await page.waitForFunction(()=>uploaded.length===3);
  assert.equal(await page.locator('.fm-ch-pending-files button[aria-label="Remove attachment"]').count(),2);
  await page.getByRole('button',{name:'Send',exact:true}).click();
  assert.equal((await page.evaluate(()=>sent.at(-1))).text,'','attachment-only messages must not gain a caption');
  assert.equal((await page.evaluate(()=>sent.at(-1))).attachment_ids.length,3,'recorded clip and pasted files send together');
  console.log('PASS quote exit, link text/URL validation and clipboard image/file attachments');
  await page.locator('.fm-ch-msg').first().hover();
  await page.locator('.fm-ch-msg').first().getByRole('button',{name:'More message actions',exact:true}).click();
  await page.getByRole('menuitem',{name:'Forward message',exact:true}).click();
  const forwardDialog=page.getByRole('dialog',{name:'Forward message',exact:true});
  await forwardDialog.getByRole('searchbox').fill('Team room');
  await forwardDialog.getByRole('button',{name:'Team room',exact:true}).click();
  await forwardDialog.getByLabel('Add a note',{exact:false}).fill('For our next review');
  assert.match(await forwardDialog.locator('.fm-ch-forward-card').innerText(),/Jordan Ellis/);
  assert.equal(await forwardDialog.locator('textarea').evaluate(node=>getComputedStyle(node).borderRadius),'10px');
  await page.screenshot({animations:'disabled',path:path.join(output,'forward-message.png')});
  await forwardDialog.getByRole('button',{name:'Forward',exact:true}).click();
  await forwardDialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>sent.at(-1).forwarded_message_id),'message1');
  const forwardCard=page.locator('.fm-ch-msg .fm-ch-forward-card').last();
  await forwardCard.waitFor();assert.match(await forwardCard.innerText(),/Jordan Ellis/);
  assert.equal(await forwardCard.locator('strong').last().innerText(),'project review');
  await page.screenshot({animations:'disabled',path:path.join(output,'forwarded-message-card.png')});
  console.log('PASS searchable forwarding, original preview, optional note and attributed card');
  await page.evaluate(()=>{
    ChannelsAPI.saved={list:async()=>({messages:[{...testMessages[0],channel:testChannel,attachments:[{media_id:'report',file_name:'Review plan.pdf'}]}]})};
    ChannelsAPI.reminders={list:async()=>({reminders:[{id:'reminder',due:true,remind_at:new Date().toISOString(),channel:testChannel,message:{...testMessages[0],id:'reminder-message',text:'Confirm the delivery date'}}]})};
    instance.setFeatures({attention:true});
  });
  await page.getByTitle('Conversation notifications',{exact:true}).click();
  const notificationDialog=page.getByRole('dialog',{name:'Conversation notifications',exact:true});
  assert.equal(await notificationDialog.locator('select').count(),0);
  await notificationDialog.getByRole('radio',{name:/All new messages/}).click();
  await page.keyboard.press('ArrowDown');
  assert.equal(await notificationDialog.getByRole('radio',{name:/Mentions and replies/}).getAttribute('aria-checked'),'true');
  await page.screenshot({animations:'disabled',path:path.join(output,'conversation-notifications.png')});
  await notificationDialog.getByRole('button',{name:'Save',exact:true}).click();
  await notificationDialog.waitFor({state:'detached'});
  await page.locator('.fm-ch-modal-backdrop').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>testChannel.members.find(person=>person.id==='owner').notify_level),'mentions');
  await page.getByRole('button',{name:'Later',exact:true}).click();
  await page.getByRole('heading',{name:'Reminders',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Saved messages',exact:true}).waitFor();
  await page.getByRole('link',{name:'Review plan.pdf',exact:true}).waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'later-tab.png')});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({animations:'disabled',path:path.join(output,'later-mobile.png')});
  await page.evaluate(()=>instance.setChannel('general'));
  await page.getByTitle('Conversation actions',{exact:true}).click();
  await page.locator('.fm-ch-header-menu-item').filter({hasText:'Conversation notifications'}).click();
  await page.screenshot({animations:'disabled',path:path.join(output,'conversation-notifications-mobile.png')});
  assert.equal(await page.getByRole('dialog').evaluate(node=>node.getBoundingClientRect().right<=innerWidth),true);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.locator('.fm-ch-modal-backdrop').waitFor({state:'detached'});
  await page.setViewportSize({width:1366,height:768});
  await page.evaluate(()=>instance.setFeatures({attention:false}));
  console.log('PASS notification choice cards, keyboard selection, Later sections and mobile layout');


  if (!process.env.CHANNELS_COMPOSER_ONLY) {
  await page.getByTitle('Start or join huddle',{exact:true}).click();
  console.log('Call starting');
  assert.equal(await page.locator('[data-huddle-record]').count(),0);
  assert.doesNotMatch(await page.locator('.fm-ch-modal').innerText(),/retention|recording/i);
  await page.getByRole('button',{name:'Start or join',exact:true}).click();
  await page.locator('.fm-ch-call-stage').waitFor();
  assert.equal(await page.locator('.fm-ch-call-identity').count(),2);
  await page.getByRole('button',{name:'Maximize call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=full]').isVisible());
  await page.getByRole('button',{name:'React',exact:true}).click();
  await page.locator('.fm-ch-emoji-grid button').first().click();
  await page.locator('.fm-ch-call-reaction').first().waitFor();
  assert.equal(await page.locator('.fm-ch-call-reaction').count(),7);
  assert.equal(await page.locator('.fm-ch-call-reaction').first().evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.screenshot({animations:'disabled',path:path.join(output,'call-reactions.png')});
  await page.getByRole('button',{name:'Invite people',exact:true}).click();
  await page.getByRole('button',{name:/Livia/}).click();
  await page.getByRole('button',{name:'Send invitations',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.invitedUsers),['invitee']);
  await page.screenshot({animations:'disabled',path:path.join(output,'fullscreen-invite.png')});
  await page.getByRole('button',{name:'Call settings and troubleshooting',exact:true}).click();
  await page.locator('[data-mic] option').nth(1).waitFor({state:'attached'});
  await page.locator('[data-mic]').selectOption({index:1});
  await page.getByText('Audio settings applied.',{exact:true}).waitFor();
  if (await page.locator('[data-speaker]').isEnabled()) await page.locator('[data-speaker]').selectOption({index:1});
  await page.locator('[data-noise]').uncheck();
  await page.getByText('Audio settings applied.',{exact:true}).waitFor();
  await page.locator('[data-noise]').check();
  await page.getByText('Audio settings applied.',{exact:true}).waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'fullscreen-audio-settings.png')});
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Participants',exact:true}).click();
  await page.getByTitle('Remove Jordan Ellis',{exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByTitle('End huddle for everyone',{exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Participants',exact:true}).click();
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  await page.getByRole('button',{name:'Mute microphone',exact:true}).click();
  await page.getByRole('button',{name:'Unmute microphone',exact:true}).click();
  await page.getByTitle('Minimize call',{exact:true}).click();
  await page.getByTitle('Float call',{exact:true}).click();
  const callBox = await page.locator('.fm-call-window').boundingBox();
  await page.locator('.fm-call-window [data-resize=se]').hover();
  await page.mouse.down(); await page.mouse.move(callBox.x + callBox.width - 153,callBox.y + callBox.height + 60,{steps:10}); await page.mouse.up();
  const resized = await page.locator('.fm-call-window').boundingBox();
  assert.ok(resized.width < callBox.width - 50, 'resize grip changes call width');
  await page.screenshot({animations:'disabled',path:path.join(output,'resized-call.png')});

  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  await page.locator('.fm-ch-call-stage video').waitFor();
  await page.getByRole('button',{name:'Call settings and troubleshooting',exact:true}).click();
  await page.getByRole('tab',{name:'Video & backgrounds'}).click();
  await page.locator('[data-camera] option').nth(1).waitFor({state:'attached'});
  await page.locator('[data-camera]').selectOption({index:1});
  await page.getByText('Camera selected.',{exact:true}).waitFor();
  await page.locator('[data-background]').selectOption('image');
  await page.getByText('Choose a background image first.',{exact:true}).waitFor();
  await page.locator('[data-background-file]').setInputFiles({name:'background.png',mimeType:'image/png',buffer:await page.screenshot()});
  await page.getByText('Background applied.',{exact:true}).waitFor({timeout:60000});
  await page.screenshot({animations:'disabled',path:path.join(output,'custom-background.png')});
  await page.locator('[data-background]').selectOption('blur');
  console.log('Applying background');
  await page.getByText('Background applied.',{exact:true}).waitFor({timeout:60000});
  console.log('Background applied');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===0);
  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  await page.locator('.fm-ch-call-stage video').waitFor();
  await page.getByRole('button',{name:'Call settings and troubleshooting',exact:true}).click();
  await page.getByRole('tab',{name:'Video & backgrounds'}).click();
  assert.equal(await page.locator('[data-background]').inputValue(),'blur');
  await page.locator('[data-background]').selectOption('off');
  await page.getByText('Background applied.',{exact:true}).waitFor();
  // Simulate an unavailable model. Effects must fail independently of video.
  await page.route('**/selfie_segmenter.tflite',route=>route.abort());
  await page.locator('[data-background]').selectOption('blur');
  await page.getByText(/Background effect unavailable/).waitFor();
  assert.equal(await page.locator('[data-background]').inputValue(),'off');
  assert.equal(await page.locator('.fm-ch-call-stage video').evaluate(video=>video.srcObject.getVideoTracks()[0].readyState),'live');
  await page.unroute('**/selfie_segmenter.tflite');
  console.log('PASS effect failure retains a live camera and resets effects');
  await page.getByRole('tab',{name:'Troubleshooting',exact:true}).click();
  await page.getByRole('button',{name:'Run connection check'}).click();
  await page.getByText(/Secure browser: yes/).waitFor();
  await page.getByRole('button',{name:'Test speaker',exact:true}).click();
  await page.getByText('A short tone played through your speaker.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Test microphone level',exact:true}).click();
  await page.getByRole('meter',{name:'Microphone input level'}).waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'call-troubleshooting.png')});
  await page.getByRole('button',{name:'Done',exact:true}).click();
  console.log('Diagnostics checked');
  await page.screenshot({animations:'disabled',path:path.join(output,'call-workspace.png')});
  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  console.log('Camera disabled');
  await page.waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===0);
  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  console.log('Camera restarted');
  await page.locator('.fm-ch-call-stage video').waitFor();
  await page.getByRole('button',{name:'Leave huddle',exact:true}).click();
  console.log('Call left');
  await page.locator('.fm-ch-huddle').waitFor({state:'detached'});
  await page.evaluate(() => { testMessages.push({id:'huddle-start',channel_id:'general',seq:99,text:'Huddle started',author:{id:'owner',name:'Morgan Lee'},created_at:new Date().toISOString(),metadata:{event:'huddle_started',huddle_id:'call1'},reactions:[]}); instance.refresh(); });
  await page.getByRole('button',{name:'Join huddle',exact:true}).waitFor();
  const createdBeforeJoin = await page.evaluate(()=>createdHuddles);
  await page.getByRole('button',{name:'Join huddle',exact:true}).click();
  await page.locator('.fm-ch-call-stage').waitFor();
  assert.equal(await page.evaluate(()=>createdHuddles),createdBeforeJoin,'message joins the existing room instead of creating another');
  await page.getByRole('button',{name:'Leave huddle',exact:true}).click();
  await page.locator('.fm-ch-huddle').waitFor({state:'detached'});
  console.log('PASS huddle message joins existing call');
  console.log('Capturing messaging');
  await page.screenshot({animations:'disabled',path:path.join(output,'rich-messaging.png'),timeout:10000});
  await page.getByTitle('Start or join huddle',{exact:true}).click();
  await page.getByRole('button',{name:'Start or join',exact:true}).click();
  await page.getByRole('button',{name:'Participants',exact:true}).click();
  await page.getByTitle('End huddle for everyone',{exact:true}).click();
  await page.getByRole('button',{name:'End call',exact:true}).click();
  await page.locator('.fm-ch-huddle').waitFor({state:'detached'});
  }
  }
  if (!process.env.CHANNELS_COMPOSER_ONLY && !process.env.CHANNELS_HUDDLES_ONLY) {
  console.log('Opening overlay');
  await page.evaluate(() => { instance.destroy(); document.querySelector('#app').innerHTML = '<div style="padding:40px;background:#f7f8fa;height:100%;box-sizing:border-box"><h1>Project workspace</h1><p>Keep working while the conversation stays docked.</p><button id="underlying-action">Edit project</button></div>'; });
  await page.evaluate(() => {
    const main = document.querySelector('main'); main.style.cssText = 'position:relative;height:100vh;margin-left:220px;display:flex;flex-direction:column';
    const panels = document.createElement('div'); panels.id='mainPanels'; panels.style.cssText='flex:1;min-height:0;overflow:auto';
    const app = document.querySelector('#app'); app.style.height='100%'; app.before(panels); panels.append(app);
    const topbar = document.createElement('div'); topbar.id='platformTopbar'; topbar.textContent='Workspace'; topbar.style.cssText='height:48px;flex:none;box-sizing:border-box;padding:14px 24px;border-bottom:1px solid #e4e7ec'; main.prepend(topbar);
    const sidebar = document.createElement('aside'); sidebar.style.cssText='position:fixed;left:0;top:0;bottom:0;width:220px;background:#f1f3f6;padding:24px;box-sizing:border-box'; sidebar.textContent='FirstMate Â· Projects'; document.body.append(sidebar);
  });
  await page.addScriptTag({url:origin+'/libraries/apps/channels/app.js'});
  await page.evaluate(() => FirstMateChannelsOverlay.open('general', {windowMode:'docked'}));
  await page.locator('.fm-channels-overlay .fm-ch-rich-editor').waitFor();
  await page.getByRole('button',{name:'Dock conversation',exact:true}).click();
  assert.ok(await page.locator('.fm-channels-overlay[data-window=docked]').isVisible());
  const dockBox = await page.locator('.fm-channels-overlay').boundingBox();
  const contentBox = await page.locator('#app').boundingBox();
  assert.ok(contentBox.x + contentBox.width <= dockBox.x + 1,'docked conversation reserves workspace width');
  const divider = page.getByRole('separator',{name:'Resize conversation w',exact:true});
  await divider.hover(); await page.mouse.down(); await page.mouse.move(dockBox.x - 80,dockBox.y + dockBox.height/2,{steps:8}); await page.mouse.up();
  assert.ok((await page.locator('.fm-channels-overlay').boundingBox()).width > dockBox.width + 50);
  await divider.focus(); await page.keyboard.press('ArrowRight');
  await page.locator('#underlying-action').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fm:portal-tab:activated',{detail:{}})));
  assert.ok(await page.locator('.fm-channels-overlay[data-window=docked]').isVisible());
  await page.screenshot({animations:'disabled',path:path.join(output,'docked-conversation.png')});
  await page.getByRole('button',{name:'Minimize conversation',exact:true}).click();
  assert.equal(await page.locator('.fm-channels-overlay-body').isVisible(), false);
  await page.getByRole('button',{name:'Float conversation',exact:true}).click();
  for (const [corner,dx,dy] of [['nw',30,30],['ne',-30,20],['sw',20,-20],['se',-30,-20],['n',0,16],['e',-16,0],['s',0,-16],['w',16,0]]) {
    const initial = await page.locator('.fm-channels-overlay').boundingBox();
    await page.locator(`[data-resize=${corner}]`).hover(); await page.mouse.down();
    const gripBox = await page.locator(`[data-resize=${corner}]`).boundingBox();
    await page.mouse.move(gripBox.x + gripBox.width/2 + dx,gripBox.y + gripBox.height/2 + dy,{steps:6}); await page.mouse.up();
    const changed = await page.locator('.fm-channels-overlay').boundingBox();
    if (dx) assert.notEqual(Math.round(initial.width),Math.round(changed.width),`${corner} resizes width`);
    if (dy) assert.notEqual(Math.round(initial.height),Math.round(changed.height),`${corner} resizes height`);
  }
  const wide = await page.locator('.fm-channels-overlay').boundingBox();
  await page.locator('[data-resize=se]').hover(); await page.mouse.down();
  await page.mouse.move(wide.x + 360 - 8,wide.y + wide.height - 8,{steps:6}); await page.mouse.up();
  const headBox = await page.locator('.fm-channels-overlay-head').boundingBox();
  const controlsBox = await page.locator('.fm-channels-overlay .fm-window-controls').boundingBox();
  const actionsBox = await page.locator('.fm-channels-overlay-actions').boundingBox();
  assert.ok(controlsBox.y + controlsBox.height <= headBox.y + headBox.height + 1,'controls stay in top row');
  assert.ok(actionsBox.y >= headBox.y + headBox.height,'conversation actions stay below header');
  await page.screenshot({animations:'disabled',path:path.join(output,'narrow-floating-conversation.png')});
  await page.locator('.fm-channels-overlay .fm-ch-msg-author').first().click();
  await page.getByRole('button',{name:'View profile',exact:true}).click();
  await page.locator('.fm-channels-overlay .fm-ch-profile-panel').waitFor();
  await page.screenshot({animations:'disabled',path:path.join(output,'floating-profile-panel.png')});
  await page.getByRole('button',{name:'Close profile',exact:true}).click();
  await page.locator('.fm-ch-profile-panel').waitFor({state:'detached'});
  assert.ok((await page.locator('.fm-channels-overlay').boundingBox()).width < 380, 'closing profile preserves floating window size');
  assert.ok(Math.abs((await page.locator('#mainPanels').boundingBox()).width - (await page.locator('main').boundingBox()).width)<2,'floating releases dock reservation');

  const before = await page.locator('.fm-channels-overlay').boundingBox();
  await page.locator('.fm-channels-overlay-title').hover();
  await page.mouse.down(); await page.mouse.move(before.x - 60, before.y + 80); await page.mouse.up();
  const after = await page.locator('.fm-channels-overlay').boundingBox();
  assert.notEqual(before.x,after.x);
  await page.getByRole('button',{name:'Maximize conversation',exact:true}).click();
  await page.locator('.fm-channels-overlay-title').click({button:'right'});
  await page.getByRole('menuitem',{name:'Pin window',exact:true}).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fm:portal-tab:activated',{detail:{}})));
  assert.ok(await page.locator('.fm-channels-overlay').isVisible());
  await page.getByRole('button',{name:'Close conversation',exact:true}).click();
  await page.locator('.fm-channels-overlay').waitFor({state:'hidden'});
  await page.goForward();
  await page.locator('.fm-channels-overlay').waitFor({state:'visible'});
  // Windowed calls are independent and use the same four-button chrome.
  await page.getByRole('button',{name:'Float conversation',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Float conversation',exact:true}).count(),0);
  await page.getByTitle('Start or join huddle',{exact:true}).click();
  await page.getByRole('button',{name:'Start or join',exact:true}).click();
  await page.locator('main > .fm-call-window').waitFor();
  assert.equal(await page.locator('.fm-channels-overlay .fm-call-window').count(),0);
  assert.equal(await page.locator('.fm-call-window .fm-window-controls button').count(),4);
  await page.getByRole('button',{name:'Maximize call',exact:true}).click();
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Maximize call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=full]').isVisible());
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  // Restore returns to the previous placement; explicit placement is still available.
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  assert.equal(await page.locator('.fm-call-window .fm-window-controls button').count(),4);
  await page.locator('.fm-call-window [data-window-action=minimize]').click();
  assert.ok(await page.locator('.fm-call-window[data-window=floating]').isVisible());
  await page.getByRole('button',{name:'Dock call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=docked]').isVisible());
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=floating]').isVisible());
  const callBefore = await page.locator('.fm-call-window').boundingBox();
  await page.locator('.fm-call-window .fm-window-title').hover(); await page.mouse.down();
  await page.mouse.move(260,180,{steps:8}); await page.mouse.up();
  const callMoved = await page.locator('.fm-call-window').boundingBox();
  assert.notEqual(Math.round(callBefore.x),Math.round(callMoved.x));
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  assert.deepEqual(await page.locator('.fm-call-window').boundingBox(),callMoved);
  await page.locator('.fm-channels-overlay .fm-ch-rich-editor').first().click();
  await page.getByRole('button',{name:'Dock conversation',exact:true}).click();
  await page.getByRole('button',{name:'Dock call',exact:true}).click();
  const conversationDock=await page.locator('.fm-channels-overlay').boundingBox();
  const callDock=await page.locator('.fm-call-window').boundingBox();
  const workspaceContent=await page.locator('#mainPanels').boundingBox();
  assert.ok(callDock.x + callDock.width <= conversationDock.x + 1,'docks do not overlap');
  assert.ok(workspaceContent.x + workspaceContent.width <= callDock.x + 1,'both docks reserve page space');
  await page.screenshot({animations:'disabled',path:path.join(output,'shared-window-docks.png')});
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Dock call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=docked]').isVisible());
  const leavesBeforeClose = await page.evaluate(()=>leftCalls.length);
  await page.getByRole('button',{name:'Close conversation',exact:true}).click();
  await page.locator('.fm-channels-overlay').waitFor({state:'hidden'});
  assert.ok(await page.locator('.fm-call-window[data-window=docked]').isVisible(),'closing conversation preserves call and its docked state');
  assert.equal(await page.evaluate(()=>leftCalls.length),leavesBeforeClose);
  await page.getByRole('button',{name:'Close call',exact:true}).click();
  await page.locator('.fm-call-window').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>leftCalls.length),leavesBeforeClose + 1);
  assert.deepEqual(errors, []);
  console.log(process.env.CHANNELS_LAYOUT_ONLY ? 'PASS shared windows: eight resize handles, four-button chrome, previous-state restore, independent calls, multiple docks, close lifecycle, profiles and navigation' : 'PASS rich text, table round-trip, overflow menu, scheduled send, screen clip review, call tiles/fullscreen/camera restart, real background processor, diagnostics, cleanup, docking, minimizing, dragging, pinning, Back/Forward');
  }

  }
  if (!process.env.CHANNELS_LAYOUT_ONLY && !process.env.CHANNELS_COMPOSER_ONLY) {
  // A second test uses two real RTCPeerConnections and shared in-memory signaling.
  const participants = new Map(); const signals = []; let seq = 0;
  const room = () => ({id:'peer-call',channel_id:'team',started_by:'owner',state:'active',started_at:new Date().toISOString(),settings:{},participants:[...participants.values()],signaling:{mode:'browser-peer',ice_servers:[]}});
  const bridge = async (action, userId, input = {}) => {
    if (action === 'join') participants.set(userId,{user_id:userId,display_name:userId==='owner'?'Morgan Lee':'Jordan Ellis',microphone_enabled:true,camera_enabled:false,role:userId==='owner'?'host':'participant'});
    if (action === 'media') Object.assign(participants.get(userId),input);
    if (action === 'leave') participants.get(userId).left_at = new Date().toISOString();
    if (action === 'remove') { assert.equal(userId,'owner'); Object.assign(participants.get(input.userId),{role:'removed',left_at:new Date().toISOString()}); }
    if (action === 'signal') { signals.push({...input,seq:++seq}); return {}; }
    if (action === 'signals') return {signals:signals.filter(signal=>signal.seq>input.after && signal.sender_peer_id!==input.peerId && (!signal.target_peer_id || signal.target_peer_id===input.peerId)),cursor:seq};
    return {huddle:room()};
  };
  const peers = [];
  for (const userId of ['owner','guest']) {
    const peerPage = await browser.newPage({viewport:{width:1200,height:900}}); peerPage.setDefaultTimeout(25000);
    peerPage.on('pageerror',error=>errors.push(error.message));
    peerPage.on('console',message=>{if(message.type()==='warning'||message.type()==='error') console.log(userId, message.text());});
    await peerPage.goto(origin);
    await peerPage.exposeFunction('callBridge',bridge);
    await peerPage.evaluate(userId => {
      window.peerConnections = [];
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.peerConnections.push(this); } };
      const channel = {id:'team',type:'public',name:'team',display_name:'Team',members:[{id:'owner',name:'Morgan Lee'},{id:'guest',name:'Jordan Ellis'}],unread:{}};
      const request = (action,input)=>window.callBridge(action,userId,input);
      window.__APP = {userId,userOrgId:'test-org'};
      window.Portal = {ui:{showToast:(title,detail)=>console.log(title,detail)}};
      window.ChannelsAPI = {
        channels:{list:async()=>({channels:[channel]})}, messages:{list:async()=>({channel,messages:[]})}, readState:{markRead:async()=>({})},
        huddles:{create:()=>request('create'),join:()=>request('join'),get:()=>request('get'),leave:()=>request('leave'),mediaState:(_org,_id,input)=>request('media',input),signal:(_org,_id,input)=>request('signal',input),signals:(_org,_id,peerId,after)=>request('signals',{peerId,after}),removeParticipant:(_org,_id,userId)=>request('remove',{userId})}
      };
      navigator.mediaDevices.getDisplayMedia = async()=>navigator.mediaDevices.getUserMedia({video:true,audio:true});
      window.peerOptions = {orgId:'test-org',mode:'full',currentUser:channel.members.find(person=>person.id===userId),realtime:false,features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,richMessages:false,channelCreate:false,channelSettings:true,recording:false}};
    }, userId);
    await peerPage.addScriptTag({url:origin+'/libraries/calls-runtime/livekit-client.umd.js'});
    await peerPage.addScriptTag({url:origin+'/libraries/window-manager/window-manager.js'});
    await peerPage.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
    await peerPage.evaluate(()=>window.instance=FirstMateChannels.create(document.querySelector('#app'),window.peerOptions));
    peers.push(peerPage);
  }
  await Promise.all(peers.map(async peerPage=>{
    await peerPage.getByTitle('Start or join huddle',{exact:true}).click();
    await peerPage.getByRole('button',{name:'Start or join',exact:true}).click();
    await peerPage.locator('.fm-ch-call-stage').waitFor();
  }));
  console.log('Two peers joined');
  await Promise.all(peers.map(peerPage=>peerPage.waitForFunction(()=>document.querySelector('.fm-ch-huddle-status').textContent.toLowerCase().includes('connected'))));
  await Promise.all(peers.map(peerPage=>peerPage.getByRole('button',{name:'Toggle camera',exact:true}).click()));
  try { await Promise.all(peers.map(peerPage=>peerPage.waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===2))); }
  catch(error) {
    for (const peerPage of peers) {
      const snapshot = await peerPage.evaluate(() => ({
        videos:document.querySelectorAll('.fm-ch-call-stage video').length,
        peers:peerConnections.map(peer => ({
          state:peer.connectionState, signaling:peer.signalingState,
          transceivers:peer.getTransceivers().map(item => ({mid:item.mid,direction:item.currentDirection})),
          senders:peer.getSenders().map(item => ({kind:item.track?.kind,enabled:item.track?.enabled,muted:item.track?.muted,state:item.track?.readyState})),
          receivers:peer.getReceivers().map(item => ({id:item.track.id,kind:item.track.kind,muted:item.track.muted,state:item.track.readyState}))
        }))
      }));
      console.log(JSON.stringify(snapshot));
    }
    console.log('Signaling sequence',signals.map(signal=>({kind:signal.kind,sender:signal.sender_peer_id.split('_')[0]})));
    throw error;
  }
  console.log('Two-way camera and audio connected');
  await peers[0].getByRole('button',{name:'Share screen',exact:true}).click();
  await peers[1].waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===3);
  assert.equal(await peers[1].locator('.fm-ch-huddle audio').count(),1);
  await peers[0].getByRole('button',{name:'Mute microphone',exact:true}).click();
  await peers[0].getByRole('button',{name:'Stop sharing',exact:true}).click();
  await peers[1].waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===2);
  await peers[0].getByRole('button',{name:'Participants',exact:true}).click();
  await peers[0].getByTitle('Remove Jordan Ellis',{exact:true}).click();
  await peers[0].getByRole('button',{name:'Remove',exact:true}).last().click();
  await peers[1].locator('.fm-ch-huddle').waitFor({state:'detached'});
  await peers[0].getByRole('button',{name:'Leave huddle',exact:true}).click();
  assert.deepEqual(errors,[]);
  for (const peerPage of peers) await peerPage.close();
  console.log('PASS two real peers: audio/video, concurrent cameras, screen + camera, screen stop, host removal');
  }
  // Exercise the real topbar script inside a deliberately trapped stacking context.
  if (process.env.CHANNELS_COMPOSER_ONLY) {
    await page.evaluate(()=>{ instance.destroy(); });
    await page.addScriptTag({url:origin+'/libraries/apps/channels/app.js'});
    await page.evaluate(()=>FirstMateChannelsOverlay.open('general',{windowMode:'docked'}));
    await page.locator('.fm-channels-overlay[data-window="docked"]').waitFor();
    const overlayHeader = page.locator('.fm-channels-overlay-head');
    await overlayHeader.getByRole('button',{name:'Messages',exact:true}).waitFor();
    assert.equal(await page.locator('.fm-channels-overlay-body .fm-ch-tabs').count(),0);
    assert.equal(await overlayHeader.locator('.fm-window-controls button').count(),4);
    assert.equal(await overlayHeader.locator('.fm-channels-overlay-title').getAttribute('role'),null);
    await overlayHeader.locator('.fm-channels-overlay-title').click();
    assert.equal(await page.locator('.fm-window-menu').count(),0);
    assert.equal(await page.locator('.fm-channels-overlay-subhead').evaluate(node=>getComputedStyle(node).position),'absolute');
    await page.getByTitle('People in channel (3)',{exact:true}).click();
    await page.locator('.fm-ch-modal .fm-ch-member-row').first().waitFor();
    assert.ok(await page.locator('.fm-ch-modal').getByText('Livia',{exact:true}).isVisible());
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.screenshot({animations:'disabled',path:path.join(output,'unified-channel-header.png')});
    console.log('PASS unified title/tabs/docking header, plain title, floating actions and people picker');
    console.log('PASS split view opens a docked conversation');
    await page.evaluate(()=>{
      FirstMateChannelsOverlay.close({silent:true});
      Portal.currentUser.identity = {preferences:{left_column_channels:true}};
      Portal.cfg = {userOrgId:'test-org'};
      window.PlatformAPI = {appFlags:{current:()=>({}),has:()=>true}};
      Portal.util = {escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
      document.body.insertAdjacentHTML('beforeend','<div class="platform-messages" style="position:fixed;top:0;left:0;z-index:10"><button id="platformMessagesBtn">Message inbox</button><span id="platformMessagesCount"></span><div id="platformMessagesMenu"><div id="platformMessagesList"></div></div></div>');
      for (let i=0;i<65;i++) testMessages.push({...testMessages[0],id:'later'+i,seq:100+i,text:'Later message '+i});
      testMessages.push({...testMessages[0],id:'reply-deep-link',seq:200,parent_id:'message1',text:'A reply needing attention'});
      window.inboxRows = [{entry_id:'old',kind:'reaction',channel_id:'general',channel_type:'public',message_id:'message1',author:{name:'Jordan'},emoji:'👍',at:new Date().toISOString(),unread:true}, {entry_id:'reply',kind:'reply',channel_id:'general',channel_type:'public',message_id:'reply-deep-link',parent_id:'message1',author:{name:'Jordan'},at:new Date().toISOString(),unread:true}];
      inboxRows[0].text = 'Original project question <plan>';
      inboxRows[0].channel_name = '#general';
      inboxRows.splice(1,0,{...inboxRows[0],entry_id:'second-reaction',author:{name:'Livia'},emoji:'🔥'});
      window.inboxReads = [];
      ChannelsAPI.readState.inbox = async()=>({entries:[...inboxRows],unread_total:inboxRows.length});
      ChannelsAPI.readState.inboxRead = async(_org,entry)=>{inboxReads.push(entry.entry_id);inboxRows=inboxRows.filter(item=>item.entry_id!==entry.entry_id);return {ok:true}};
      ChannelsAPI.threads = {markRead:async()=>({})};
      window.duplicateRoutes = 0;
      const navigate = Portal.navigation.navigate;
      Portal.navigation.navigate = (...args)=>{duplicateRoutes++;return navigate(...args)};
    });
    await page.locator('.fm-channels-overlay').waitFor({state:'hidden'});
    await page.addScriptTag({url:origin+'/portal/scripts/topbar.js'});
    await page.evaluate(()=>document.dispatchEvent(new Event('DOMContentLoaded')));
    await page.getByRole('button',{name:'Message inbox',exact:true}).click();
    const reactionGroup = page.locator('.ptb-msg-reaction-group');
    await reactionGroup.waitFor();
    assert.equal(await reactionGroup.count(),1,'reactions to the same message share one group');
    assert.equal(await reactionGroup.locator('blockquote').innerText(),'Original project question <plan>');
    assert.equal(await reactionGroup.locator('plan').count(),0,'message preview is escaped');
    assert.match(await reactionGroup.innerText(),/Jordan.*reacted.*👍/s);
    assert.match(await reactionGroup.innerText(),/Livia.*reacted.*🔥/s);
    assert.equal(await reactionGroup.locator('[data-message-entry]').count(),2);
    console.log('PASS grouped reactions show each person, emoji and original message');
    await page.locator('[data-message-entry="0"]').click();
    await page.waitForFunction(()=>inboxReads.includes('old'));
    await page.locator('.fm-channels-overlay [data-message-id="message1"].highlight').waitFor();
    assert.equal(await page.evaluate(()=>duplicateRoutes),0,'integrated inbox does not navigate to the unregistered Channels tab');
    await page.getByRole('button',{name:'Message inbox',exact:true}).click();
    assert.equal(await page.locator('[data-message-entry]').count(),2);
    await page.locator('.ptb-msg-reaction-group [data-message-entry]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>inboxReads.includes('second-reaction'));
    await page.getByRole('button',{name:'Message inbox',exact:true}).click();
    assert.equal(await page.locator('.ptb-msg-reaction-group').count(),0);
    await page.locator('[data-message-entry="0"]').click();
    await page.waitForFunction(()=>inboxReads.includes('reply'));
    await page.locator('.fm-channels-overlay .fm-ch-panel [data-message-id="reply-deep-link"].highlight').waitFor();
    await page.getByRole('button',{name:'Message inbox',exact:true}).click();
    await page.getByText('No messages need your attention.',{exact:false}).waitFor();
    assert.equal(await page.locator('[data-message-entry]').count(),0);
    assert.deepEqual(await page.evaluate(()=>inboxReads),['old','second-reaction','reply']);
    console.log('PASS first-click inbox navigation to older messages and replies, durable read and removal');

  }
  const notificationsPage = await browser.newPage({viewport:{width:1280,height:800}});
  notificationsPage.on('pageerror',error=>errors.push(error.message));
  await notificationsPage.goto(origin);
  await notificationsPage.evaluate(()=>{
    document.body.innerHTML='<div style="position:relative;z-index:1;isolation:isolate;height:50px;overflow:hidden"><div id="platformTopbar" class="platform-notifications"><button id="platformBell">Notifications</button><div id="platformNotificationMenu" class="ptb-menu"><button id="notification-proof">Huddle invitation</button></div></div></div><div id="front-overlay" style="position:fixed;inset:50px 0 0;z-index:2147483647;background:#dfe5ef">Channels overlay</div>';
    const style=document.createElement('style');style.textContent='.ptb-menu{visibility:hidden;background:white;border:1px solid #aaa;padding:20px;box-sizing:border-box}.ptb-menu.visible{visibility:visible}';document.head.append(style);
    window.Portal={cfg:{userOrgId:'org'},util:{escapeHtml:value=>String(value)}};
    window.PlatformAPI={appFlags:{current:()=>({}),has:()=>true}};
    window.PlatformNotifications={load:()=>new Promise(resolve=>setTimeout(()=>resolve({}),500)),getState:()=>({}),subscribe:()=>{}};
    document.querySelector('#notification-proof').onclick=()=>window.notificationClicked=true;
  });
  await notificationsPage.addScriptTag({url:origin+'/portal/scripts/topbar.js'});
  await notificationsPage.evaluate(()=>document.dispatchEvent(new Event('DOMContentLoaded')));
  await notificationsPage.getByRole('button',{name:'Notifications',exact:true}).click();
  await notificationsPage.waitForFunction(()=>document.querySelector('#platformNotificationMenu').matches(':popover-open'));
  assert.equal(await notificationsPage.locator('#platformNotificationMenu').evaluate(menu=>{const rect=menu.getBoundingClientRect();return menu.contains(document.elementFromPoint(rect.left+30,rect.top+30));}),true);
  await notificationsPage.getByRole('button',{name:'Huddle invitation',exact:true}).click();
  assert.equal(await notificationsPage.evaluate(()=>window.notificationClicked),true);
  await notificationsPage.screenshot({path:path.join(output,'notification-top-layer.png')});
  await notificationsPage.keyboard.press('Escape');
  assert.equal(await notificationsPage.locator('#platformNotificationMenu').evaluate(menu=>menu.matches(':popover-open')),false);
  await notificationsPage.close();
  assert.deepEqual(errors,[]);
  console.log('PASS notifications escape clipping and highest-z-index app overlays');
} catch (error) { console.error(error); await page.screenshot({animations:'disabled',path:path.join(output,'failure.png'),timeout:5000}).catch(()=>{}); throw error; }
finally { await browser.close(); server.close(); }


