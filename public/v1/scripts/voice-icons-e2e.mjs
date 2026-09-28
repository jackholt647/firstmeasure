// Real-browser regression checks with an isolated in-memory API and fake devices.
// Does not log in, send messages, invite users, or change production data.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const publicRoot = path.resolve('..');
const output = path.resolve('../../output/voice-icons-20260928');
await mkdir(output, {recursive:true});
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (name === '/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial"><main class="main" style="position:relative;height:100vh"><div id="app" style="height:100vh"></div></main></body></html>'); return; }
  const filename = path.resolve(publicRoot, '.' + name);
  if (!filename.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  try { const data = process.env.VOICE_ASSET_ORIGIN && (name.includes('/voice-icons/') || name.includes('/audio-notes/') || name.includes('/channels-ui/')) ? Buffer.from(await (await fetch(process.env.VOICE_ASSET_ORIGIN + name)).arrayBuffer()) : await readFile(name === '/libraries/channels-ui/channels-ui.js' && process.env.VOICE_CHANNEL_SOURCE ? process.env.VOICE_CHANNEL_SOURCE : filename); response.setHeader('Content-Type', name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream'); response.end(data); }
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
    window.testMessages = messages; window.createdHuddles = 0;
    let huddle;
    window.__APP = {userId:me.id, userOrgId:'test-org', userName:me.name};
    window.Portal = {currentUser:me, ui:{showToast:(title, detail) => window.lastToast = title + ': ' + detail}, appFlags:{current:()=>true, has:()=>true}};
    window.ChannelsAPI = {
      channels:{setNotifyLevel:async(_org,_id,userId,level)=>{channel.members.find(person=>person.id===userId).notify_level=level;return {}},list:async()=>({channels:[channel]}), get:async()=>({channel}), create:async(_org,input)=>{window.createdConversations.push(input);return {channel:{...channel,id:'assistant-new',type:'dm',display_name:input.name,members:[me,agent]}}}},
      messages:{list:async(_org,_channel,options={})=>({channel,messages:messages.filter(item=>!options.before || item.seq<options.before)}),post:async(_org,_channel,input)=>{window.sent.push(input);const message={...messages[0],...input,id:'sent'+window.sent.length,author:me,seq:window.sent.length+1};messages.push(message);return {message}},edit:async(_org,id,input)=>({message:{...messages[0],...input,id}}),thread:async()=>({root:messages[0],replies:[]})},
      preferences:{collaboration:async()=>({preferences:{...window.sidebarPreferences}}),updateCollaboration:async(_org,patch)=>{Object.assign(window.sidebarPreferences,patch);return {preferences:{...window.sidebarPreferences}}}},
      directory:{list:async()=>({users:[me,other,agent]})},
      readState:{markRead:async(_org,id,seq)=>{window.sidebarReads.push({id,seq});return {}}},
      drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},
      scheduled:{list:async()=>({scheduled_messages:window.scheduled}),remove:async(_org,id)=>{window.scheduled=window.scheduled.filter(item=>item.id!==id);return {}},create:async(_org,input)=>{const item={...input,id:'scheduled'+(window.scheduled.length+1),state:'scheduled',sender_user_id:me.id};window.scheduled.push(item);return {scheduled_message:item}}},
      uploads:{send:async(_org,file,channelId)=>{window.uploaded.push({size:file.size,type:file.type,channelId});return {attachment:{id:'clip1',file_name:file.name}}}},
      huddles:{invite:async(_org,_id,ids)=>{window.invitedUsers.push(...ids);return {invited_user_ids:ids}},create:async()=>{window.createdHuddles++;huddle={id:'call1',channel_id:channel.id,started_by:me.id,state:'active',started_at:new Date().toISOString(),settings:{recording_enabled:false},participants:[{...me,user_id:me.id,display_name:me.name,microphone_enabled:true},{...other,user_id:other.id,display_name:other.name,microphone_enabled:false}]};return {huddle}},join:async()=>({huddle}),get:async()=>({huddle}),mediaState:async(_org,_id,patch)=>{Object.assign(huddle.participants[0],patch);return {huddle}},signals:async()=>({signals:[],cursor:0}),signal:async()=>({}),leave:async()=>{window.leftCalls.push('call1');return {}},end:async()=>({})}
    };
    window.testOptions = {onOpenChannel:(id,options)=>window.splitOpened={id,options},orgId:'test-org',currentUser:me,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:true,channelCreate:false,channelSettings:true,recording:false}};
    // A real camera stream stands in for the display picker in unattended tests.
    navigator.mediaDevices.getDisplayMedia = async () => { window.displayStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true}); return window.displayStream; };
  });
  await page.addScriptTag({url:origin+'/libraries/navigation/portal-navigation.js'});
  await page.addScriptTag({url:origin+'/libraries/calls-runtime/livekit-client.umd.js'});
  await page.addScriptTag({url:origin+'/libraries/window-manager/window-manager.js'});
  await page.addScriptTag({url:origin+'/libraries/audio-notes/audio-notes.js'});
  await page.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
  await page.evaluate(() => window.instance = FirstMateChannels.create(document.querySelector('#app'), window.testOptions));

  const dictate = page.locator('[data-voice-mode="dictation"]');
  const record = page.locator('[data-voice-mode="record"]');
  await dictate.waitFor();
  let transcriptions = 0;
  await page.route('**/transcriptions', route => { transcriptions++; return route.fulfill({json:{transcription:{text:'Remember the flashing.',model:'test'}}}); });
  await page.evaluate(() => { document.querySelector('.fm-ch-composer-box [contenteditable]').value = 'Existing draft.'; });
  await dictate.click();
  await page.getByRole('button',{name:'Finish recording',exact:true}).waitFor();
  assert.equal(await record.isDisabled(), true);
  await page.waitForTimeout(400);
  await page.getByRole('button',{name:'Finish recording',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.fm-ch-composer-box [contenteditable]').value === 'Existing draft. Remember the flashing.');
  assert.equal(transcriptions,1);
  assert.equal(await page.evaluate(() => uploaded.length),0);
  await record.click();
  await page.getByRole('button',{name:'Finish recording',exact:true}).waitFor();
  assert.equal(await dictate.isDisabled(),true);
  await page.waitForTimeout(400);
  await page.getByRole('button',{name:'Finish recording',exact:true}).click();
  await page.waitForFunction(() => uploaded.length === 1);
  await page.waitForFunction(() => !document.querySelector('[data-voice-mode="dictation"]').disabled);
  assert.equal(transcriptions,1,'Audio recording must not invoke transcription');
  assert.equal(await page.evaluate(() => document.querySelector('.fm-ch-composer-box [contenteditable]').value),'Existing draft. Remember the flashing.');
  await dictate.click();
  await page.getByRole('button',{name:'Cancel recording',exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('[data-voice-mode="dictation"]').disabled);
  assert.equal(transcriptions,1);
  assert.equal(await record.isDisabled(),true,'Existing attachment keeps recording disabled');
  await page.screenshot({path:path.join(output,'channel-voice-controls.png')});
  for (const size of [24,40]) {
    await page.evaluate(size => { document.body.innerHTML = ['record','dictation'].map(mode => `<span style="display:inline-block;margin:20px;width:${size}px;height:${size}px;background:#182230;mask:url(/libraries/voice-icons/${mode}.svg) center/contain no-repeat"></span>`).join(''); },size);
    await page.screenshot({path:path.join(output,`voice-icons-${size}.png`)});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: dictation preserves draft and uploads no audio; recording preserves draft and skips transcription; cancellation and mutual exclusion.');
} finally { await browser.close(); server.close(); }
