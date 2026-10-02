import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('project voice pins across trays, survives minimizing and transfers out of a removed iframe',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<main class="main" style="height:850px"><div id="mainPanels"></div><iframe id="project" style="width:1000px;height:700px"></iframe></main>');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org'};window.Portal={can:()=>true,tabs:{activateTab(){}},util:{currentBranchId:()=> 'default'}};
   const threads={main:{id:'main',subject_id:'main'},p1:{id:'p1',subject_id:'project:1'},p2:{id:'p2',subject_id:'project:2'}};
   const messages={main:[],p1:[],p2:[]};window.sent=[];window.starts=[];window.stops=[];window.tracks=[];
   window.AssistantAPI={context:async()=>({main_thread:threads.main,threads:[threads.main],agents:[],dashboard:[]}),
    projectConversation:async(_o,p)=>({thread:threads['p'+p]}),thread:async(_o,t)=>({thread:threads[t],messages:messages[t]}),
    send:async(o,t,b)=>{sent.push({o,t,b});messages[t].push({role:'user',content:b.message},{role:'assistant',content:'Done for '+t});return{thread:threads[t],assistant_message:{role:'assistant',content:'Done for '+t}};},
    startVoice:async(o,t)=>{starts.push({o,t});return{transport:{sdp:'answer'},close_token:'signed'};},closeVoice:async(o,t)=>{stops.push(t);}};
   Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const t=new EventTarget();t.enabled=true;t.stop=()=>t.stopped=true;tracks.push(t);return{getTracks:()=>[t],getAudioTracks:()=>[t]};}}});
   window.RTCPeerConnection=class extends EventTarget{
    iceGatheringState='complete';connectionState='connected';addTrack(){};
    createDataChannel(){this.events=new EventTarget();this.events.readyState='open';this.events.send=()=>{};this.events.close=()=>{};return this.events;}
    async createOffer(){return{type:'offer',sdp:'v=0\r\n'};}async setLocalDescription(d){this.localDescription=d;}
    async setRemoteDescription(){this.events.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'session.started'})}));}close(){}
   };
  });

 await page.evaluate(()=>{window.transfers=[];AssistantAPI.transferProject=async(o,t)=>{transfers.push(t);return {ok:true};};});
 for(const f of ['window-manager/window-manager.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+f,import.meta.url),'utf8')});
 const frame=page.frames().find(f=>f!==page.mainFrame());
 await frame.setContent('<style>html,body,#shell{height:100%;margin:0}#shell{display:flex;flex-direction:column}.r-preview{flex:1}</style><div id="shell"><header class="r-modal-header"></header><main class="r-preview"></main></div>');
 await frame.evaluate(()=>{window.__APP={userOrgId:'org'};window.Portal={can:k=>k!=='channels.separate_project_notes',ProjectNotes:{mount(node){node.innerHTML='<textarea aria-label="Note"></textarea>';return {destroy(){}};}}};window.PlatformAssistant={mountProject:(...a)=>parent.PlatformAssistant.mountProject(...a)};});
 await frame.addScriptTag({content:await readFile(new URL('../../libraries/project-trays/project-trays.js',import.meta.url),'utf8')});
 await frame.evaluate(()=>window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{project:{id:'1'}}));
 await frame.getByRole('tab',{name:'Agent',exact:true}).click();await frame.waitForSelector('.fma-welcome');
 await frame.getByRole('button',{name:'Pin assistant',exact:true}).click();
 await frame.getByRole('button',{name:'Close assistant',exact:true}).click();
 assert.equal(await frame.locator('.fm-project-agent-pin').isVisible(),true);
 await frame.getByRole('textbox',{name:'Message',exact:true}).fill('Pinned draft');
 await frame.getByRole('tab',{name:'Notes',exact:true}).click();
 assert.equal(await frame.getByRole('textbox',{name:'Note',exact:true}).isVisible(),true);
 assert.equal(await frame.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'Pinned draft');
 await frame.getByRole('tab',{name:'Agent',exact:true}).click();
 await frame.getByRole('button',{name:'Pin assistant',exact:true}).click();
 await frame.getByRole('button',{name:'Start voice conversation',exact:true}).click();await page.waitForFunction(()=>starts.length===1);
 await frame.getByRole('tab',{name:'Notes',exact:true}).click();
 assert.equal(await frame.locator('.fm-project-agent-pin').isVisible(),true);
 await frame.getByRole('button',{name:'Mute microphone',exact:true}).click();assert.equal(await page.evaluate(()=>tracks[0].enabled),false);
 await page.locator('#project').evaluate(e=>e.style.visibility='hidden');await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>!!tracks[0].stopped),false);
 await page.locator('#project').evaluate(e=>e.style.visibility='visible');
 assert.equal(await frame.evaluate(()=>trays.requestClose(()=>window.closedProject=true)),false);
 await frame.getByRole('button',{name:'Keep project open',exact:true}).click();assert.equal(await page.evaluate(()=>stops.length),0);
 await frame.evaluate(()=>trays.requestClose(()=>window.closedProject=true));
 await frame.getByRole('button',{name:'End voice agent',exact:true}).click();assert.equal(await page.evaluate(()=>tracks[0].stopped),true);assert.equal(await frame.evaluate(()=>closedProject),true);
 await frame.getByRole('tab',{name:'Agent',exact:true}).click();await frame.getByRole('button',{name:'Start voice conversation',exact:true}).click();await page.waitForFunction(()=>starts.length===2);
 await frame.evaluate(()=>trays.requestClose(()=>window.parent.document.querySelector('#project').remove()));
 await frame.getByRole('button',{name:'Transfer to global voice agent',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#project'));
 assert.deepEqual(await page.evaluate(()=>transfers),['p1']);assert.equal(await page.evaluate(()=>!!tracks[1].stopped),false);
 assert.equal(await page.getByRole('button',{name:'Mute microphone',exact:true}).isVisible(),true);
 await page.getByRole('button',{name:'Stop voice conversation',exact:true}).click();assert.equal(await page.evaluate(()=>tracks[1].stopped),true);
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
