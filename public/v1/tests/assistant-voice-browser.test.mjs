import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('voice connects, delegates once with context, preserves drafts, and releases microphone on exit',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.setContent('<style>html,body{margin:0;height:100%}.main{position:relative;height:100vh}</style><main class="main"><div id="mainPanels"><section id="tab_assistant" class="fm-tabpanel active"></section></div></main>');
 await page.evaluate(()=>{
  window.Portal={};window.__APP={userOrgId:'org'};window.calls=[];window.voiceClosed=[];
  const thread={id:'main',title:'Main thread'},messages=[];
  window.AssistantAPI={context:async()=>({main_thread:thread,threads:[thread],agents:[],dashboard:[]}),thread:async()=>({thread,messages}),
   startVoice:async()=>{if(window.delayStart)await new Promise(r=>window.releaseStart=r);return{session:{id:'live-test'},transport:{sdp:'answer'},close_token:'signed'};},
   closeVoice:async(...args)=>{window.voiceClosed.push(args);},
   send:async(_org,_id,body)=>{window.calls.push(body);messages.push({role:'user',content:body.message},{role:'assistant',content:'Your result.'});return{assistant_message:{content:'Your result.'}};}};
  window.tracks=[];Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const track=new EventTarget();track.enabled=true;track.stop=()=>{track.stopped=true;};window.tracks.push(track);return{getTracks:()=>[track],getAudioTracks:()=>[track]};}}});
  window.RTCPeerConnection=class extends EventTarget{
   iceGatheringState='complete';connectionState='connected';addTrack(){};
   createDataChannel(){const e=new EventTarget();e.readyState='open';e.sent=[];e.send=s=>e.sent.push(JSON.parse(s));e.close=()=>{e.readyState='closed';};window.events=e;return e;}
   async createOffer(){return{type:'offer',sdp:'v=0 offer'};}async setLocalDescription(d){this.localDescription=d;}
   async setRemoteDescription(){window.events.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'session.started'})}));}
   close(){this.connectionState='closed';}
  };
  window.emit=e=>window.events.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(e)}));
 });
 for(const f of ['window-manager/window-manager.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+f,import.meta.url),'utf8')});
 await page.evaluate(()=>PlatformAssistant.openFull());await page.locator('[data-fma=input]').fill('Keep my draft');
 await page.locator('[data-fma=voice]').click();await page.waitForFunction(()=>document.querySelector('[data-fma=voiceStatus]').textContent==='Listening');
 assert.equal(await page.locator('[data-fma=mic]').isDisabled(),true);
 await page.evaluate(()=>{emit({type:'session.input_transcript.delta',delta:'Check my orders',start_ms:0,end_ms:500});emit({type:'session.delegation.created',delegation:{id:'d1',target:'client'},offset_ms:510});emit({type:'session.delegation.created',delegation:{id:'d1',target:'client'}});});
 await page.waitForFunction(()=>events.sent.some(e=>e.type==='session.commentary.append'));
 assert.equal(await page.evaluate(()=>calls.length),1);assert.equal(await page.evaluate(()=>calls[0].intent),'voice');
 assert.match(await page.evaluate(()=>calls[0].message),/User: Check my orders/);
 await page.locator('[data-fma=voiceMute]').click();assert.equal(await page.evaluate(()=>tracks[0].enabled),false);
 await page.locator('[data-fma=voiceEnd]').click();assert.equal(await page.evaluate(()=>tracks[0].stopped),true);
 assert.equal(await page.locator('[data-fma=input]').inputValue(),'Keep my draft');assert.equal(await page.locator('[data-fma=mic]').isDisabled(),false);
 assert.equal(await page.evaluate(()=>voiceClosed.length),1);
 // Cancel while the SDP request is in flight; its late response must be closed too.
 await page.evaluate(()=>{window.delayStart=true;});await page.locator('[data-fma=voice]').click();await page.waitForFunction(()=>window.releaseStart);
 await page.locator('[data-fma=voiceEnd]').click();await page.evaluate(()=>releaseStart());await page.waitForFunction(()=>voiceClosed.length===2);
 assert.equal(await page.evaluate(()=>tracks[1].stopped),true);
 await page.evaluate(()=>{window.delayStart=false;});await page.locator('[data-fma=voice]').click();await page.waitForFunction(()=>document.querySelector('[data-fma=voiceStatus]').textContent==='Listening');
 await page.evaluate(()=>PlatformAssistant.close());assert.equal(await page.evaluate(()=>tracks[2].stopped),true);
 }finally{await browser.close();}
});

