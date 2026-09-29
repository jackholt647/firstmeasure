// Real-browser regression checks with an isolated in-memory API and fake devices.
// Does not log in, send messages, invite users, or change production data.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const publicRoot = path.resolve('..');
const output = path.resolve('../../output/channels-huddle-polish-20260929');
await mkdir(output, {recursive:true});
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (name === '/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial"><main class="main" style="position:relative;height:100vh"><div id="app" style="height:100vh"></div></main></body></html>'); return; }
  const filename = path.resolve(publicRoot, '.' + name);
  if (!filename.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  try { let data = process.env.DEV_ASSETS ? Buffer.from(await (await fetch('https://dev.1m8.ai'+name+'?quotes='+Date.now())).arrayBuffer()) : await readFile(filename); if(name==='/libraries/channels-ui/channels-ui.js')data=Buffer.from(data.toString().replace('    async function startHuddle(', '    root.callProbe={state,audibleHuddleStream,updateHuddleSpeakers,renderHuddle,applyHuddleBackground,startHuddleRecording};\n    async function startHuddle(')); response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream'); response.end(data); }
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



  await page.evaluate(()=>{ChannelsAPI.huddles.end=async()=>{window.endedCalls=(window.endedCalls||0)+1;return {};};});
  await page.evaluate(()=>instance.setChannel('general'));
  await page.getByTitle('Start or join huddle',{exact:true}).click();
  await page.getByRole('button',{name:'Start or join',exact:true}).click();
  const call=page.locator('main > .fm-call-window');await call.waitFor();
  await page.evaluate(()=>{
    callProbe.state.huddle.settings={recording_mode:'video',recording_enabled:true,record_video:true};
    callProbe.state.huddle.participants.push({user_id:'third',display_name:'Livia',microphone_enabled:true});
    callProbe.renderHuddle();
  });
  for(const [width,height] of [[320,260],[440,330],[700,440]]){
    await call.evaluate((node,size)=>{node.style.width=size[0]+'px';node.style.height=size[1]+'px';},[width,height]);
    await page.waitForTimeout(150);
    const geometry=await call.evaluate(node=>{const bounds=node.getBoundingClientRect();return [...node.querySelectorAll('.fm-ch-huddle-actions button')].map(button=>{const b=button.getBoundingClientRect();return {x:b.x,right:b.right,bottom:b.bottom,within:b.bottom<=bounds.bottom && b.x>=bounds.x && b.right<=bounds.right};});});
    assert(geometry.every(button=>button.within),JSON.stringify({width,height,geometry}));
    assert.equal(await call.locator('.fm-ch-huddle-recording').innerText(),'');
    await page.screenshot({path:path.join(output,`call-${width}.png`)});
  }
  await page.evaluate(()=>{callProbe.state.huddleSpeakers=new Set(['guest']);callProbe.updateHuddleSpeakers();});
  assert.equal(await call.locator('.fm-ch-call-tile.primary').getAttribute('data-person'),'guest');
  assert.equal(await call.locator('.fm-ch-call-tile.speaking').getAttribute('data-person'),'guest');
  await call.getByRole('button',{name:'Mute microphone',exact:true}).click();
  assert.equal(await page.evaluate(()=>callProbe.state.huddleStreams.flatMap(stream=>stream.getAudioTracks()).every(track=>!track.enabled)),true);
  await call.getByRole('button',{name:'Unmute microphone',exact:true}).click();
  assert.equal(await page.evaluate(()=>callProbe.state.huddleStreams.flatMap(stream=>stream.getAudioTracks()).some(track=>track.enabled)),true);
  // Real Web Audio verifies quiet background rejection, voice opening and explicit mute.
  const levels=await page.evaluate(async()=>{
    const ctx=new AudioContext(),osc=ctx.createOscillator(),volume=ctx.createGain(),input=ctx.createMediaStreamDestination();osc.connect(volume);volume.connect(input);volume.gain.value=.002;osc.start();await ctx.resume();
    const state=callProbe.state;state.huddle.participants.find(p=>p.user_id==='guest').microphone_enabled=true;
    const output=callProbe.audibleHuddleStream(input.stream,'guest'),source=ctx.createMediaStreamSource(output),analyser=ctx.createAnalyser();source.connect(analyser);const data=new Float32Array(analyser.fftSize);
    const measure=async()=>{await new Promise(resolve=>setTimeout(resolve,500));analyser.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length);};
    const quiet=await measure();volume.gain.value=.2;const voice=await measure();state.huddle.participants.find(p=>p.user_id==='guest').microphone_enabled=false;const muted=await measure();osc.stop();await ctx.close();return {quiet,voice,muted};
  });
  assert(levels.quiet<.001 && levels.voice>.02 && levels.muted<.001,JSON.stringify(levels));
  console.log('PASS compact controls, speaker priority/highlight, capture-track mute and real audio gate',levels);
  await call.getByRole('button',{name:'Toggle camera',exact:true}).click();
  await call.locator('.fm-ch-call-tile video').first().waitFor();
  await page.evaluate(async()=>{const effects=await import('/libraries/calls-runtime/effects/track-processors.js');window.effects=effects;});
  assert.equal(await page.evaluate(()=>typeof effects.BackgroundProcessor),'function');
  await page.evaluate(()=>callProbe.applyHuddleBackground('blur'));
  assert.equal(await page.evaluate(()=>callProbe.state.huddleBackground),'blur');
  await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d').fillRect(0,0,64,64);callProbe.state.huddleBackgroundUrl=canvas.toDataURL();await callProbe.applyHuddleBackground('image');});
  assert.equal(await page.evaluate(()=>callProbe.state.huddleBackground),'image');
  await page.screenshot({path:path.join(output,'effects-before-off.png')});
  await call.getByRole('button',{name:'Toggle camera',exact:true}).click();
  await page.screenshot({path:path.join(output,'effects-before-on.png')});
  await call.getByRole('button',{name:'Toggle camera',exact:true}).click();
  await page.waitForFunction(()=>Boolean(callProbe.state.huddleCameraTrack));
  console.log('PASS local effects imports, actual blur/custom processing and camera restart');
  await page.evaluate(()=>{
    window.savedRecordings=0;
    instance.setFeatures({recording:true,recordVideo:true});
    const state=callProbe.state;state.huddle.settings={recording_mode:'video',record_video:true,recording_enabled:true};
    ChannelsAPI.huddles.get=async()=>({huddle:state.huddle});
    ChannelsAPI.huddles.manage=async(_org,_id,input)=>{if(input.admin_user_id)state.huddle.settings.admin_user_ids=[input.admin_user_id];if(input.recording_enabled!==undefined)state.huddle.settings.recording_enabled=input.recording_enabled;return {huddle:state.huddle};};
    ChannelsAPI.huddles.recording=async()=>{window.savedRecordings=(window.savedRecordings||0)+1;return {};};
    callProbe.startHuddleRecording();callProbe.renderHuddle();
  });
  await page.waitForTimeout(500);
  await call.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.waitForFunction(()=>savedRecordings===1);
  assert.equal(await call.locator('.fm-ch-huddle-recording').count(),0);
  await call.getByRole('button',{name:'Participants',exact:true}).click();
  await call.getByRole('button',{name:'Make admin',exact:true}).first().click();
  assert.equal(await page.evaluate(()=>callProbe.state.huddle.settings.admin_user_ids.length),1);
  await call.getByRole('button',{name:'Participants',exact:true}).click();
  await call.getByRole('button',{name:'Resume recording',exact:true}).click();
  await page.waitForTimeout(500);
  await call.getByRole('button',{name:'End huddle for everyone',exact:true}).click();
  await call.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>endedCalls),1);
  await page.waitForFunction(()=>savedRecordings===2);
  assert.equal(await page.evaluate(()=>callProbe.state.huddleAudioGates.size),0);
  await page.evaluate(async()=>{
    ChannelsAPI.mediaFileUrl=(_org,id)=>'/recordings/'+id;
    const artifact={id:'art1',media_id:'video1',kind:'video_recording'};
    testMessages.push({id:'ended-call',channel_id:'general',kind:'system',text:'Huddle started',created_at:new Date().toISOString(),author:{id:'owner',name:'Morgan'},reply_count:3,metadata:{event:'huddle_started',huddle_id:'ended1'},huddle:{state:'ended',started_at:new Date(Date.now()-528000).toISOString(),ended_at:new Date().toISOString(),artifacts:[artifact,artifact,{id:'art2',media_id:'video2',kind:'video_recording'}]}});
    await instance.setChannel('general');
  });
  assert.equal(await page.locator('.fm-ch-huddle-artifact video').count(),2);
  assert.equal(await page.locator('.fm-ch-huddle-artifact a[download]').count(),2);
  assert.equal(await page.locator('.fm-ch-huddle-artifacts').evaluate(node=>getComputedStyle(node).gap),'12px');
  await page.screenshot({path:path.join(output,'recording-cards.png')});
  console.log('PASS admin promotion, recording stop/resume, end/cleanup, one save per segment, playable spaced cards and downloads');
  assert.deepEqual(errors,[]);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
