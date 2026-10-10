import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('project trays share the assistant composer, scope, responsive layout and voice cleanup', async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://assistant.test/**',r=>r.fulfill({body:'<html></html>'}));await page.goto('https://assistant.test');
  await page.setContent('<style>body{font:14px Arial;margin:0}main{height:800px}#projects{display:flex;gap:20px}#one,#two{height:650px;width:380px;display:flex;flex-direction:column}</style><main class="main"><div id="mainPanels"></div></main><div id="projects"><section id="one"></section><section id="two"></section></div>');
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
  for(const f of ['window-manager/window-manager.js','doc-markdown/firstmate-markdown.js','platform-assistant/platform-assistant.js']) {
   const source=process.env.ASSISTANT_ASSET_ORIGIN ? await(await fetch(`${process.env.ASSISTANT_ASSET_ORIGIN}/libraries/${f}?verify=${Date.now()}`)).text() : await readFile(new URL('../../libraries/'+f,import.meta.url),'utf8');
   await page.addScriptTag({content:source});
  }
  await page.evaluate(async()=>{PlatformAssistant.open();window.first=PlatformAssistant.mountProject(document.querySelector('#one'),{projectId:'1'});window.second=PlatformAssistant.mountProject(document.querySelector('#two'),{projectId:'2'});await Promise.all([first.ready,second.ready]);});
  const one=page.locator('#one'),two=page.locator('#two'),global=page.locator('#platformAssistantDrawer');
  await global.locator('[data-fma=input]').fill('Global draft retained');
  await global.locator('.fma-head').click({button:'right'});
  await page.getByRole('menuitem',{name:'Float',exact:true}).click();
  assert.equal(await global.getAttribute('data-window'),'floating');
  await global.locator('[data-window-action=close]').click();
  await page.evaluate(()=>PlatformAssistant.open());
  assert.equal(await global.getAttribute('data-window'),'docked');
  assert.equal(await global.locator('[data-fma=input]').inputValue(),'Global draft retained');
  for(const selector of ['attach','mic','voice','send','history']){
   assert.equal(await one.locator(`[data-fma=${selector}]`).getAttribute('class'),await global.locator(`[data-fma=${selector}]`).getAttribute('class'));
  }
  assert.equal(await one.locator('.fma-suggest').count(),3);assert.match(await one.locator('.fma-welcome').innerText(),/this project/);
  assert.equal(await one.locator('[data-fma=headTitle]').innerText(),'');
  assert.equal(await one.locator('[data-fma=sidebar]').isVisible(),false);
  await one.locator('[data-fma=history]').click();assert.equal(await one.locator('[data-fma=sidebar]').isVisible(),true);
  assert.equal(await one.locator('.fma-nav-item').innerText(),'Project conversation\nPrivate to you');
  await one.locator('[data-fma=history]').click();
  for(const width of [440,380,320,240]){
   await one.evaluate((e,w)=>e.style.width=w+'px',width);
   await page.waitForTimeout(180);
   const size=await one.locator('[data-fma=input]').evaluate(e=>{const s=getComputedStyle(e);const c=document.createElement('canvas').getContext('2d');c.font=s.font;return{height:e.clientHeight,placeholder:e.placeholder,textWidth:c.measureText(e.placeholder).width,width:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)};});
   assert.ok(size.height<=41,JSON.stringify(size));assert.ok(size.textWidth<=size.width,JSON.stringify(size));
  }
  const spacing=await one.evaluate(e=>{const m=e.querySelector('[data-fma=mic]').getBoundingClientRect(),v=e.querySelector('[data-fma=voice]').getBoundingClientRect();return v.left-m.right;});assert.ok(spacing<=3);
  if(process.env.ASSISTANT_SCREENSHOT_PATH){await one.evaluate(e=>e.style.width='380px');await page.waitForTimeout(200);await one.screenshot({path:process.env.ASSISTANT_SCREENSHOT_PATH});}
  await one.locator('[data-fma=input]').fill('Project one draft');await two.locator('[data-fma=input]').fill('Project two draft');
  await global.locator('[data-fma=input]').fill('Global draft');
  await one.locator('[data-fma=send]').click();await page.waitForFunction(()=>sent.length===1);
  assert.equal(await page.evaluate(()=>sent[0].t),'p1');assert.equal(await two.locator('[data-fma=input]').inputValue(),'Project two draft');assert.equal(await global.locator('[data-fma=input]').inputValue(),'Global draft');
  await one.locator('[data-fma=voice]').click();await page.waitForFunction(()=>document.querySelector('#one [data-fma=voiceStatus]').textContent==='Listening');
  assert.equal(await page.evaluate(()=>starts[0].t),'p1');
  await one.evaluate(e=>e.setAttribute('inert',''));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>!!tracks[0].stopped),false);assert.equal(await page.evaluate(()=>stops.length),0);
  await page.evaluate(()=>first.endVoice());
  await one.evaluate(e=>e.removeAttribute('inert'));
  await one.locator('[data-fma=voice]').click();await page.waitForFunction(()=>starts.length===2);
  await page.evaluate(()=>first.destroy());await page.waitForFunction(()=>tracks[1].stopped);
  assert.equal(await one.locator('.fma-drawer').count(),0);assert.equal(await two.locator('[data-fma=input]').inputValue(),'Project two draft');
  await two.locator('[data-fma=voice]').click();await page.waitForFunction(()=>starts.length===3);
  await global.locator('[data-fma=voice]').click();await page.waitForFunction(()=>starts.length===4);
  assert.equal(await page.evaluate(()=>tracks[2].stopped),true,'Starting voice elsewhere ends the previous call');
  await page.evaluate(()=>{second.destroy();PlatformAssistant.close();});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
