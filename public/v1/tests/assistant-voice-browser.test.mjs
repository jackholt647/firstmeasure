import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('voice connects, delegates once with context, preserves drafts, and releases microphone on exit',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.route('https://assistant-voice.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>html,body{margin:0;height:100%;font:14px Arial}.main{position:relative;height:100vh}</style><main class="main"><div id="mainPanels"><section id="tab_assistant" class="fm-tabpanel active"></section></div></main>'}));
 await page.goto('https://assistant-voice.test');
 await page.evaluate(()=>{
  window.Portal={};window.__APP={userOrgId:'org'};window.calls=[];window.voiceClosed=[];window.uploads=[];
  const thread={id:'main',title:'Main thread'},messages=[];
  window.AssistantAPI={context:async()=>{if(!window.bootReleased)await new Promise(resolve=>window.releaseBoot=()=>{window.bootReleased=true;resolve();});return{main_thread:thread,threads:[thread],agents:[],dashboard:[]};},thread:async()=>({thread,messages}),
   startVoice:async()=>{if(window.delayStart)await new Promise(r=>window.releaseStart=r);return{session:{id:'live-test'},transport:{sdp:'answer'},close_token:'signed'};},
   closeVoice:async(...args)=>{window.voiceClosed.push(args);},
   upload:async(org,id,file)=>{uploads.push({org,id,name:file.name});return{attachment:{media_id:'uploaded-file'}};},
   send:async(_org,_id,body)=>{window.calls.push(body);if(window.delaySend)await new Promise(resolve=>window.releaseSend=resolve);messages.push({role:'user',content:body.message},{role:'assistant',content:'Your result.'});return{assistant_message:{content:'Your result.'}};}};
  const NativeAudioContext=window.AudioContext; window.cueFrequencies=[];
  window.AudioContext=class extends NativeAudioContext{createOscillator(){const oscillator=super.createOscillator(),set=oscillator.frequency.setValueAtTime.bind(oscillator.frequency);oscillator.frequency.setValueAtTime=(value,time)=>{cueFrequencies.push(value);return set(value,time);};return oscillator;}};
  window.tracks=[];Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const track=new EventTarget();track.enabled=true;track.stop=()=>{track.stopped=true;};window.tracks.push(track);return{getTracks:()=>[track],getAudioTracks:()=>[track]};}}});
  window.RTCPeerConnection=class extends EventTarget{
   constructor(){super();window.peer=this;}
   iceGatheringState='complete';connectionState='connected';addTrack(){};
   createDataChannel(){const e=new EventTarget();e.readyState='open';e.sent=[];e.send=s=>e.sent.push(JSON.parse(s));e.close=()=>{e.readyState='closed';};window.events=e;return e;}
   async createOffer(){return{type:'offer',sdp:'v=0 offer'};}async setLocalDescription(d){this.localDescription=d;}
   async setRemoteDescription(){window.events.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'session.started'})}));}
   close(){this.connectionState='closed';}
  };
  window.emit=e=>window.events.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(e)}));
 });
 for(const f of ['window-manager/window-manager.js','window-manager/window-shell.js','platform-assistant/platform-assistant.js']) {
  const source=process.env.ASSISTANT_ASSET_ORIGIN ? await (await fetch(`${process.env.ASSISTANT_ASSET_ORIGIN}/libraries/${f}?voice_verify=${Date.now()}`)).text() : await readFile(new URL('../../libraries/'+f,import.meta.url),'utf8');
  await page.addScriptTag({content:source});
 }
 await page.evaluate(()=>PlatformAssistant.openFull());
 await page.locator('[data-fma=voice]').click();await page.waitForFunction(()=>cueFrequencies.includes(240));assert.ok(await page.evaluate(()=>cueFrequencies.includes(380)));await page.evaluate(()=>window.releaseBoot?.());await page.waitForFunction(()=>document.querySelector('[data-fma=voiceStatus]').textContent==='Listening');
 assert.ok(await page.evaluate(()=>cueFrequencies.includes(960)));
 const connectingCount=await page.evaluate(()=>cueFrequencies.filter(f=>f===240).length);await page.waitForTimeout(1400);assert.equal(await page.evaluate(()=>cueFrequencies.filter(f=>f===240).length),connectingCount);
 await page.locator('[data-fma=input]').fill('Keep my draft');
 assert.equal(await page.locator('[data-fma=mic]').isVisible(),false);
 assert.equal(await page.locator('[data-fma=voice]').isVisible(),false);
 assert.equal(await page.locator('[data-fma=voiceMute]').isVisible(),true);
 assert.equal(await page.locator('[data-fma=voiceEnd] .fma-stop-square').count(),1);
 assert.equal(await page.locator('[data-fma=voicePanel]').count(),0);
 assert.equal(await page.locator('[data-fma=voiceIndicator]').isVisible(),true);
 if(process.env.ASSISTANT_SCREENSHOT_PATH)await page.addStyleTag({url:'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'});
 await page.evaluate(async()=>{
  const nativeContext=new AudioContext();window.testAudio=nativeContext;
  const output=nativeContext.createMediaStreamDestination();window.tone=nativeContext.createOscillator();const gain=nativeContext.createGain();gain.gain.value=.06;tone.connect(gain);gain.connect(output);tone.start();await nativeContext.resume();
  const track=output.stream.getAudioTracks()[0];
  const e=new Event('track');e.track=track;peer.dispatchEvent(e);
 });
 await page.waitForFunction(()=>Number(document.querySelector('[data-fma=voiceIndicator] i:nth-child(5)').style.transform.match(/[\d.]+/)?.[0] || 0)>.25);
 await page.evaluate(()=>{emit({type:'session.input_transcript.delta',delta:'Check my orders',start_ms:0,end_ms:500});emit({type:'session.delegation.created',delegation:{id:'d1',target:'client'},offset_ms:510});emit({type:'session.delegation.created',delegation:{id:'d1',target:'client'}});});
 await page.waitForFunction(()=>events.sent.some(e=>e.type==='session.commentary.append' && e.delegation_id==='d1'));
 assert.equal(await page.evaluate(()=>calls.length),1);assert.equal(await page.evaluate(()=>calls[0].intent),'voice');
 assert.match(await page.evaluate(()=>calls[0].message),/User: Check my orders/);
 assert.match(await page.locator('[data-fma=voiceLog]').innerText(),/Check my orders/);
 await page.evaluate(()=>{emit({type:'session.output_transcript.delta',delta:'Your orders ',start_ms:1000,end_ms:1800});emit({type:'session.input_transcript.delta',delta:'What about ',start_ms:3000,end_ms:3500});emit({type:'session.output_transcript.delta',delta:'are ready.',start_ms:1800,end_ms:2200});emit({type:'session.input_transcript.delta',delta:'tomorrow?',start_ms:3500,end_ms:4000});});
 assert.equal(await page.locator('[data-fma=voiceLog] .assistant').filter({hasText:'Your orders are ready.'}).count(),1);
 assert.equal(await page.locator('[data-fma=voiceLog] .user').filter({hasText:'What about tomorrow?'}).count(),1);
 // Fast back-and-forth must create new bubbles for both speakers, even with
 // less than 1500ms between their turns. Late fragments stay in their turn.
 await page.evaluate(()=>{
  emit({type:'session.output_transcript.delta',delta:'Tomorrow ',start_ms:4100,end_ms:4300});
  emit({type:'session.input_transcript.delta',delta:'Thanks',start_ms:4600,end_ms:4700});
  emit({type:'session.output_transcript.delta',delta:'too.',start_ms:4300,end_ms:4500});
  emit({type:'session.output_transcript.delta',delta:'You are welcome.',start_ms:4800,end_ms:5100});
  emit({type:'session.input_transcript.delta',delta:'One more thing.',start_ms:5200,end_ms:5500});
 });
 assert.deepEqual(await page.locator('[data-fma=voiceLog] .fma-msg').evaluateAll(nodes=>nodes.map(e=>e.textContent.trim())),[
  'Check my orders','Your orders are ready.','What about tomorrow?','Tomorrow too.','Thanks','You are welcome.','One more thing.'
 ]);
 assert.match(await page.locator('[data-fma=msgs]').innerText(),/Your orders are ready/);
 assert.equal(await page.locator('.fma-welcome').count(),0);
 // Typing and files join the same serialized voice backend queue.
 await page.evaluate(()=>window.delaySend=true);
 await page.locator('[data-fma=input]').fill('Check this file');
 await page.locator('[data-fma=fileInput]').setInputFiles({name:'scope.txt',mimeType:'text/plain',buffer:Buffer.from('Project scope')});
 await page.locator('[data-fma=send]').click();await page.waitForFunction(()=>window.releaseSend);
 await page.locator('[data-fma=input]').fill('Also check the schedule');await page.locator('[data-fma=send]').click();
 assert.equal(await page.evaluate(()=>calls.length),2);
 await page.evaluate(()=>{window.delaySend=false;releaseSend();});await page.waitForFunction(()=>calls.length===3);
 assert.equal(await page.evaluate(()=>uploads[0].id),'main');
 assert.deepEqual(await page.evaluate(()=>calls[1].attachments),['uploaded-file']);
 assert.match(await page.evaluate(()=>calls[2].message),/Also check the schedule/);
 await page.waitForFunction(()=>events.sent.some(e=>e.type==='session.commentary.append'&&e.delegation_id===null&&e.content==='Your result.'));
 assert.match(await page.locator('[data-fma=voiceLog]').innerText(),/scope.txt/);
 assert.equal(await page.locator('[data-fma=voiceLog] .user').filter({hasText:'Check this file'}).count(),1);
 await page.locator('[data-fma=input]').fill('Keep my draft');
 const center=await page.locator('[data-fma=voiceIndicator]').evaluate(e=>{const r=e.getBoundingClientRect(),h=e.parentElement.getBoundingClientRect();return Math.abs(r.left+r.width/2-h.left-h.width/2);});assert.ok(center<1);
 if(process.env.ASSISTANT_SCREENSHOT_PATH){await page.evaluate(()=>document.fonts.ready);await page.locator('#platformAssistantDrawer').screenshot({path:process.env.ASSISTANT_SCREENSHOT_PATH});await page.evaluate(()=>PlatformAssistant.dockIfFull());await page.waitForTimeout(250);await page.locator('#platformAssistantDrawer').screenshot({path:process.env.ASSISTANT_SCREENSHOT_PATH.replace('.png','-dock.png')});}
 await page.setViewportSize({width:360,height:800});await page.waitForTimeout(250);
 const overlap=await page.locator('.fma-head').evaluate(h=>{const w=h.querySelector('[data-fma=voiceIndicator]').getBoundingClientRect();return [...h.querySelectorAll('.fm-window-controls button,[data-fma=visualsToggle]')].filter(e=>e.getClientRects().length).some(e=>{const b=e.getBoundingClientRect();return b.left<w.right&&b.right>w.left;});});assert.equal(overlap,false);
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-fma=voiceMute]').click();assert.equal(await page.evaluate(()=>tracks[0].enabled),false);
 assert.equal(await page.locator('[data-fma=voiceMute]').getAttribute('aria-label'),'Unmute microphone');
 await page.locator('[data-fma=voiceEnd]').click();assert.equal(await page.evaluate(()=>tracks[0].stopped),true);assert.ok(await page.evaluate(()=>cueFrequencies.includes(540)));
 assert.equal(await page.locator('[data-fma=input]').inputValue(),'Keep my draft');assert.equal(await page.locator('[data-fma=mic]').isDisabled(),false);
 assert.equal(await page.evaluate(()=>voiceClosed.length),1);
 assert.equal(await page.locator('[data-fma=voiceIndicator]').isVisible(),false);
 assert.equal(await page.locator('[data-fma=mic]').isVisible(),true);
 assert.equal(await page.locator('[data-fma=voiceEnd]').isVisible(),false);
 await page.evaluate(()=>{tone.stop();testAudio.close();});
 await page.locator('[data-fma=input]').fill('A later text message');await page.locator('[data-fma=send]').click();
 await page.waitForFunction(()=>calls.length===4);
 const ordered=await page.locator('[data-fma=msgs]').innerText();assert.ok(ordered.indexOf('Check my orders')<ordered.indexOf('A later text message'));
 await page.locator('[data-fma=input]').fill('Keep my draft');
 // Cancel while the SDP request is in flight; its late response must be closed too.
 await page.evaluate(()=>{window.delayStart=true;});await page.locator('[data-fma=voice]').click();await page.waitForFunction(()=>window.releaseStart);
 await page.locator('[data-fma=voiceEnd]').click();await page.evaluate(()=>releaseStart());await page.waitForFunction(()=>voiceClosed.length===2);
 assert.equal(await page.evaluate(()=>tracks[1].stopped),true);
 await page.evaluate(()=>{window.delayStart=false;});await page.locator('[data-fma=voice]').click();await page.waitForFunction(()=>document.querySelector('[data-fma=voiceStatus]').textContent==='Listening');
 await page.evaluate(()=>PlatformAssistant.close());assert.equal(await page.evaluate(()=>tracks[2].stopped),true);
 }finally{await browser.close();}
});

