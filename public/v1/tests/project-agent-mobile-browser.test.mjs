import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// On a phone the project Agent is the assistant's input bar sliding up over the app (above the trays footer bar), not a full tray.
const asset=async f=>readFile(new URL('../../libraries/'+f,import.meta.url),'utf8');
const phoneAgent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function project(browser,{width,height,mobile}){
  const page=await browser.newPage({viewport:{width,height},...(mobile?{userAgent:phoneAgent,isMobile:true,hasTouch:true}:{})});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>m.type()==='error'&&errors.push('console '+m.text()));
  await page.route('http://agent.test/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.startsWith('/libraries/'))return route.fulfill({contentType:path.endsWith('.json')?'application/json':'application/javascript',body:await asset(path.slice('/libraries/'.length))});return route.fulfill({contentType:'text/html',body:'<html></html>'});});
  await page.goto('http://agent.test/');
  await page.setContent(`<style>body{margin:0}</style><main class="main" style="height:${height}px"><div id="mainPanels"></div><iframe id="project" style="border:0;width:${width}px;height:${height}px"></iframe></main>`);
  await page.evaluate(()=>{
    window.__APP={userOrgId:'org'};window.Portal={can:()=>true,tabs:{activateTab(){}},util:{currentBranchId:()=>'default'}};
    const threads={main:{id:'main',subject_id:'main'},p1:{id:'p1',subject_id:'project:1'}},messages={main:[],p1:[{role:'user',content:'Earlier question'},{role:'assistant',content:'Earlier answer'}]};
    window.sent=[];window.starts=[];window.tracks=[];window.release=null;
    window.AssistantAPI={context:async()=>({main_thread:threads.main,threads:[threads.main],agents:[],dashboard:[]}),projectConversation:async()=>({thread:threads.p1}),thread:async(_o,t)=>({thread:threads[t],messages:messages[t]}),
      send:async(o,t,b)=>{sent.push(b);await new Promise(r=>window.release=r);messages[t].push({role:'user',content:b.message},{role:'assistant',content:'Measured the roof'});return{actions:[],thread:threads[t],assistant_message:{role:'assistant',content:'Measured the roof'}};},
      startVoice:async(o,t)=>{starts.push(t);return{transport:{sdp:'answer'},close_token:'signed'};},closeVoice:async()=>{}};
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{const t=new EventTarget();t.enabled=true;t.stop=()=>t.stopped=true;tracks.push(t);return{getTracks:()=>[t],getAudioTracks:()=>[t]};}}});
    window.RTCPeerConnection=class extends EventTarget{iceGatheringState='complete';connectionState='connected';addTrack(){}
      createDataChannel(){this.events=new EventTarget();this.events.readyState='open';this.events.send=()=>{};this.events.close=()=>{};return this.events;}
      async createOffer(){return{type:'offer',sdp:'v=0\r\n'};}async setLocalDescription(d){this.localDescription=d;}
      async setRemoteDescription(){this.events.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'session.started'})}));}close(){}};
  });
  for(const f of ['doc-markdown/firstmate-markdown.js','window-manager/window-manager.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({content:await asset(f)});
  const frame=page.frames().find(f=>f!==page.mainFrame());
  await frame.setContent(`<style>html,body,#shell{height:100%;margin:0}#shell{display:flex;flex-direction:column}.r-preview{flex:1;background:#eef2f6}</style><div id="shell"><header class="r-modal-header" data-window-mobile="${mobile}"></header><main class="r-preview"><p>Overview</p></main></div>`);
  await frame.evaluate(()=>{window.__APP={userOrgId:'org'};window.Portal={can:()=>true,ProjectNotes:{mount(node){node.innerHTML='<textarea aria-label="Note"></textarea>';return{destroy(){}};}}};window.PlatformAssistant={mountProject:(...a)=>parent.PlatformAssistant.mountProject(...a)};});
  await frame.addScriptTag({content:await asset('project-trays/project-trays.js')});
  await frame.addScriptTag({url:'http://agent.test/libraries/platform-widgets/runtime.js'});
  await frame.evaluate(()=>window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{project:{id:'1'}}));
  return {page,frame,errors};
}
const box=(frame,selector)=>frame.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,width:r.width,height:r.height};});
const settled=frame=>frame.waitForTimeout(520);

test('on a phone the project agent is a compact input bar with folded history, a glowing footer button and the same voice pin',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,frame,errors}=await project(browser,{width:390,height:844,mobile:true});
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();
    await frame.waitForSelector('.fma-msg',{state:'attached'});await settled(frame);
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-agent-compact'),'true');
    assert.equal(await frame.locator('.fm-project-tray-tabs').getAttribute('data-agent-compact'),'true','the agent footer button glows');
    assert.match(await frame.locator('[data-tray=agent] > i').evaluate(e=>getComputedStyle(e).backgroundImage),/gradient/);
    const bar=await box(frame,'.fm-project-tray'),content=await box(frame,'.fm-project-content'),footer=await box(frame,'.fm-project-tray-tabs');
    assert.ok(Math.abs(bar.bottom-content.bottom)<1 && bar.width===content.width,'the bar spans the bottom of the project content');
    assert.ok(Math.abs(bar.bottom-footer.top)<1,'and sits on the trays footer bar');
    assert.ok(bar.height<150,'only the input bar shows: '+bar.height);
    for(const name of ['Message']) assert.equal(await frame.getByRole('textbox',{name,exact:true}).isVisible(),true);
    for(const name of ['Add files or camera photo','Dictate','Start voice conversation','Close assistant']) assert.equal(await frame.getByRole('button',{name,exact:true}).isVisible(),true,name);
    const history=frame.getByRole('button',{name:'Show conversation',exact:true});
    assert.equal(await history.getAttribute('aria-expanded'),'false');
    assert.equal(await frame.locator('.fma-stage').evaluate(e=>e.getBoundingClientRect().height),0,'history is folded');
    await history.click();await settled(frame);
    assert.ok(await frame.locator('.fma-stage').evaluate(e=>e.getBoundingClientRect().height)>200,'history unfolds');
    assert.equal(await frame.getByText('Earlier answer',{exact:true}).isVisible(),true);
    await frame.getByRole('button',{name:'Hide conversation',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fma-stage').evaluate(e=>e.getBoundingClientRect().height),0);
    // Asking from the folded bar shows the answer when it arrives.
    await frame.getByRole('textbox',{name:'Message',exact:true}).fill('Measure the roof');
    await frame.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>!!window.release);
    assert.equal(await frame.locator('.fm-project-tray').getAttribute('data-agent-history'),'closed');
    await frame.getByRole('button',{name:'Show conversation',exact:true}).getByText('Working').waitFor();
    await page.evaluate(()=>window.release());
    await frame.waitForFunction(()=>document.querySelector('.fm-project-tray').dataset.agentHistory==='open');
    await frame.getByText('Measured the roof',{exact:true}).waitFor();
    // Close control hides the bar; it slides away and the button stops glowing.
    await frame.getByRole('button',{name:'Close assistant',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').isVisible(),false);
    assert.equal(await frame.locator('.fm-project-tray-tabs').getAttribute('data-agent-compact'),'false');
    // Opening again starts folded; tapping the agent button again hides it.
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();await settled(frame);
    assert.equal(await frame.getByRole('button',{name:'Show conversation',exact:true}).getAttribute('aria-expanded'),'false');
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').isVisible(),false);
    assert.equal(await frame.locator('.fm-project-tray-toggle').count(),0,'no header tray control on a phone');
    // Other trays open as bottom sheets.
    await frame.getByRole('tab',{name:'Notes',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-agent-compact'),'false');
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-tray-mode'),'sheet');
    assert.equal(await frame.getByRole('textbox',{name:'Note',exact:true}).isVisible(),true);
    // A voice call still pins the agent when its bar is put away.
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();await settled(frame);
    await frame.getByRole('button',{name:'Start voice conversation',exact:true}).click();await page.waitForFunction(()=>starts.length===1);
    assert.equal(await frame.getByRole('button',{name:'Stop voice conversation',exact:true}).isVisible(),true);
    await frame.getByRole('button',{name:'Close assistant',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fm-project-agent-pin').isVisible(),true);
    assert.equal(await page.evaluate(()=>!!tracks[0].stopped),false);
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fm-project-agent-pin').isVisible(),false);
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-agent-compact'),'true');
    await frame.getByRole('button',{name:'Stop voice conversation',exact:true}).click();assert.equal(await page.evaluate(()=>tracks[0].stopped),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('on desktop the project agent stays a full tray',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {frame,errors}=await project(browser,{width:1600,height:1000,mobile:false});
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();
    await frame.waitForSelector('.fma-msg');await settled(frame);
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-agent-compact'),'false');
    assert.equal(await frame.locator('.fm-project-tray-tabs').getAttribute('data-agent-compact'),'false');
    assert.equal(await frame.locator('.r-modal-header .fm-project-tray-tabs').count(),1,'the tray buttons stay in the header');
    const tray=await box(frame,'.fm-project-tray'),content=await box(frame,'.fm-project-content');
    assert.equal(tray.width,380);assert.equal(tray.height,content.height);
    assert.equal(await frame.getByText('Earlier answer',{exact:true}).isVisible(),true,'history shows as before');
    assert.equal(await frame.locator('.fm-project-agent-history').isVisible(),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
