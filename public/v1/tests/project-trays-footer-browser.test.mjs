import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// On a phone (390x844, a mobile user agent) the project trays are a footer bar along the bottom of the
// window, from the same list as the desktop header icons. Notes, To Do and Activity open as bottom sheets
// above it, the agent bar sits on it, the Take photos bar sits above it, and the colours are the
// organization's. Desktop keeps its header icons and right-hand trays.
const asset=async f=>readFile(new URL('../../libraries/'+f,import.meta.url),'utf8');
const phoneAgent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const BRANDS=[{primary:'#0e7490',rgb:'14,116,144',secondary:'#f59e0b',primaryCss:'rgb(14, 116, 144)',secondaryCss:'rgb(245, 158, 11)'},
  {primary:'#7c2d12',rgb:'124,45,18',secondary:'#16a34a',primaryCss:'rgb(124, 45, 18)',secondaryCss:'rgb(22, 163, 74)'}];
const shots=process.env.TRAY_SHOTS;
async function project(browser,{width,height,mobile}){
  const page=await browser.newPage({viewport:{width,height},...(mobile?{userAgent:phoneAgent,isMobile:true,hasTouch:true}:{})});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>m.type()==='error'&&errors.push('console '+m.text()));
  await page.route('http://trays.test/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript',body:await asset(path.slice('/libraries/'.length))});return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});});
  await page.goto('http://trays.test/');
  await page.setContent(`<style>body{margin:0}</style><main class="main" style="height:${height}px"><div id="mainPanels"></div><iframe id="project" src="http://trays.test/frame" style="border:0;width:${width}px;height:${height}px;display:block"></iframe></main>`);
  await page.evaluate(()=>{
    window.__APP={userOrgId:'org'};window.Portal={can:()=>true,tabs:{activateTab(){}},util:{currentBranchId:()=>'default'}};
    const threads={main:{id:'main',subject_id:'main'},p1:{id:'p1',subject_id:'project:1'}},messages={main:[],p1:[{role:'user',content:'Earlier question'},{role:'assistant',content:'Earlier answer'}]};
    window.AssistantAPI={context:async()=>({main_thread:threads.main,threads:[threads.main],agents:[],dashboard:[]}),projectConversation:async()=>({thread:threads.p1}),thread:async(_o,t)=>({thread:threads[t],messages:messages[t]}),send:async()=>({actions:[]})};
  });
  for(const f of ['doc-markdown/firstmate-markdown.js','window-manager/window-manager.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({content:await asset(f)});
  const frame=page.frames().find(f=>f!==page.mainFrame());
  await frame.waitForLoadState();
  // The project window's markup: a header (title row and tabs) over the app, laid out by window-shell.
  await frame.evaluate(({mobile})=>{
    document.body.innerHTML=`<style>html,body{height:100%;margin:0;font-family:Arial,sans-serif}#shell{display:flex;flex-direction:column;height:100%}.r-preview{flex:1;min-height:0;position:relative;background:#eef2f6}</style>
      <div class="r-overlay project-layout-prototype"><div class="r-win fm-window fm-entity-window" style="position:fixed;inset:0;display:flex;flex-direction:column"><div id="shell" class="r-right">
      <header class="r-modal-header r-window-bar fm-shell-header" data-header-rows="2" data-window-mobile="${mobile}"><div class="r-window-identity fm-shell-identity"><span id="rWindowProjectTitle">2205 Mimosa Pl</span></div>
      <div class="r-tabbar fm-shell-tabs" data-tab-style="underline">${['Overview','Reports','Photos','Docs','Materials','Portal'].map((t,i)=>`<button data-tab="t${i}" aria-selected="${i===2}">${t}</button>`).join('')}</div>
      <div class="modal-shell-actions"></div><div class="r-window-bar-actions"><div class="fm-window-controls"><button data-window-action="close" aria-label="Close">x</button></div></div></header>
      <main class="r-preview"><p style="margin:16px">Photos</p></main></div></div></div>`;
    window.__APP={userOrgId:'org',userId:'sam'};
    window.Portal={can:()=>true,ProjectNotes:{mount(node){node.innerHTML='<textarea aria-label="Note" style="margin:12px"></textarea>';return{destroy(){}};}}};
    window.PlatformAssistant={mountProject:(...a)=>parent.PlatformAssistant.mountProject(...a)};
    window.PlatformActionItems={renderTodayList(node){node.innerHTML='<p>Call the homeowner</p>';return{load:async()=>{},destroy(){}};}};
    window.PlatformAPI={work:{activity:async()=>({events:[{id:'e1',type:'project.scope.created',payload:{summary:'Scope created'},created_at:new Date().toISOString()}]})},userActivity:{listForProject:async()=>({events:[]})}};
  },{mobile});
  for(const f of ['window-manager/window-shell.js','project-trays/activity-presenter.js','project-trays/project-trays.js','platform-widgets/runtime.js','camera-capture/camera-capture.js'])await frame.addScriptTag({url:'http://trays.test/libraries/'+f});
  await frame.evaluate(()=>{
    FirstMateWindowShell.ensureStyles();
    // A module's own tray: whatever the right-hand rail offers, the footer offers too.
    FirstMateProjectTrays.register({id:'checklist',label:'Checklist',icon:'fa-clipboard-check',mount(node){node.innerHTML='<p>Roof checklist</p>';return{destroy(){}};}});
    window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{project:{id:'1'}});
    window.cam=FirstMateCamera.mount(document.querySelector('.r-preview'),{});
  });
  return {page,frame,errors};
}
const box=(frame,selector)=>frame.locator(selector).first().evaluate(e=>{const r=e.getBoundingClientRect();return{top:Math.round(r.top),bottom:Math.round(r.bottom),left:Math.round(r.left),width:Math.round(r.width),height:Math.round(r.height)};});
const settled=frame=>frame.waitForTimeout(560);
const brand=(frame,b)=>frame.evaluate(b=>{const s=document.documentElement.style;s.setProperty('--primary',b.primary);s.setProperty('--primary-rgb',b.rgb);s.setProperty('--secondary',b.secondary);s.setProperty('--on-primary','#fff');window.dispatchEvent(new CustomEvent('fm:theme:updated'));},b);
const shot=async(page,name)=>{if(shots)await page.screenshot({path:`${shots}/test-${name}.png`});};

test('phone: the trays are a footer bar, open as bottom sheets, the agent bar and Take photos sit above it, in the organization colours',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,frame,errors}=await project(browser,{width:390,height:844,mobile:true});
    await brand(frame,BRANDS[0]);
    // No header control; one footer button per tray, from the same list as desktop.
    assert.equal(await frame.locator('.fm-project-tray-toggle').count(),0,'no header tray control');
    assert.equal(await frame.locator('.r-modal-header .fm-project-tray-tabs').count(),0,'no tray buttons in the header');
    const footer=await box(frame,'.fm-project-tray-tabs'),content=await box(frame,'.fm-project-content');
    assert.equal(footer.bottom,844,'the footer is along the bottom of the window');assert.equal(footer.width,390);
    assert.ok(footer.height>=50&&footer.height<=60,'a thin bar: '+footer.height);
    assert.equal(content.bottom,footer.top,'the app ends on the footer');
    const ids=await frame.evaluate(()=>FirstMateProjectTrays.definitions().map(item=>item.id));
    assert.deepEqual(await frame.locator('.fm-project-tray-tabs [data-tray]').evaluateAll(n=>n.map(b=>b.dataset.tray)),ids);
    const labels=await frame.locator('.fm-project-tray-tabs .fm-tray-label').allInnerTexts();
    for(const name of ['Notes','To Do','Activity','Agent','Checklist'])assert.ok(labels.includes(name),'footer names '+name+': '+labels);
    for(const b of await frame.locator('.fm-project-tray-tabs [data-tray]').all()){const r=await b.boundingBox();assert.ok(r.height>=44,'touch-sized buttons');}
    // The Take photos bar sits above the footer, in the organization's colours.
    const camera=await box(frame,'.fmc-bar');
    assert.ok(camera.bottom<=footer.top-8&&camera.bottom>=footer.top-14,'Take photos sits just above the footer: '+JSON.stringify(camera));
    assert.equal(await frame.locator('.fmc-bar').evaluate(e=>getComputedStyle(e).backgroundColor),BRANDS[0].primaryCss);
    assert.equal(await frame.locator('.fmc-bar i').evaluate(e=>getComputedStyle(e).backgroundColor),BRANDS[0].secondaryCss,'a secondary accent');
    await shot(page,'phone-footer');

    // Notes, To Do, Activity (and a module tray) open as bottom sheets above the footer, one at a time.
    for(const [name,text] of [['Notes',null],['To Do','Call the homeowner'],['Activity','Scope created'],['Checklist','Roof checklist']]){
      await frame.getByRole('tab',{name,exact:true}).click();await settled(frame);
      assert.equal(await frame.locator('.fm-project-content').getAttribute('data-tray-mode'),'sheet',name);
      const sheet=await box(frame,'.fm-project-tray');
      assert.equal(sheet.bottom,footer.top,name+' sits on the footer');assert.equal(sheet.width,390);
      assert.ok(Math.abs(sheet.height-content.height*.62)<3,name+' is about 60% tall: '+sheet.height);
      assert.equal(await frame.locator('.fm-project-tray-grip').isVisible(),true,name+' has a drag handle');
      assert.equal(await frame.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await frame.locator('.fm-project-tray-panel:not([hidden])').count(),1,'one sheet at a time');
      if(text)await frame.locator('.fm-project-tray').getByText(text).first().waitFor();
    }
    assert.equal(await frame.locator('.fm-project-tray-tabs [data-tray=checklist]').evaluate(e=>getComputedStyle(e).color),BRANDS[0].primaryCss,'the open tray is highlighted');
    await shot(page,'phone-sheet');
    // Tapping the scrim puts it away, sliding down.
    await page.mouse.click(195,120);
    await frame.waitForTimeout(140);
    const leaving=await box(frame,'.fm-project-tray');
    assert.equal(await frame.locator('.fm-project-tray').evaluate(e=>getComputedStyle(e).visibility),'visible','it slides away rather than vanishing');
    assert.ok(leaving.top>footer.top-content.height*.62+20,'moving down: '+JSON.stringify(leaving));
    assert.equal(await frame.locator('.fm-project-tray-panel:not([hidden])').count(),1,'its content stays while it leaves');
    await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').isVisible(),false);
    // Dragging the handle up makes it taller; dragging down puts it away.
    await frame.getByRole('tab',{name:'Notes',exact:true}).click();await settled(frame);
    let grip=await box(frame,'.fm-project-tray-grip');
    await page.mouse.move(195,grip.top+10);await page.mouse.down();
    for(const y of [grip.top-60,grip.top-140,grip.top-220])await page.mouse.move(195,y,{steps:4});
    await page.mouse.up();await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').getAttribute('data-sheet-size'),'full','dragged up to full height');
    assert.ok((await box(frame,'.fm-project-tray')).height>content.height-20);
    grip=await box(frame,'.fm-project-tray-grip');
    await page.mouse.move(195,grip.top+10);await page.mouse.down();
    for(const y of [grip.top+120,grip.top+300,grip.top+520])await page.mouse.move(195,y,{steps:4});
    await page.mouse.up();await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').isVisible(),false,'dragged down, it closes');
    assert.equal(await frame.getByRole('tab',{name:'Notes',exact:true}).getAttribute('aria-selected'),'false');
    // The handle is a button too: it toggles the height.
    await frame.getByRole('tab',{name:'To Do',exact:true}).click();await settled(frame);
    await frame.getByRole('button',{name:'Expand tray',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').getAttribute('data-sheet-size'),'full');
    await frame.getByRole('button',{name:'Close project tray',exact:true}).click();await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').isVisible(),false);

    // The agent bar sits on the footer, its edge and button in the organization's colours; × slides it away.
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();
    await frame.waitForSelector('.fma-msg',{state:'attached'});await settled(frame);
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-agent-compact'),'true');
    const bar=await box(frame,'.fm-project-tray');
    assert.equal(bar.bottom,footer.top,'the agent bar sits on the footer');assert.ok(bar.height<150,'only its input bar: '+bar.height);
    for(const b of BRANDS){
      await brand(frame,b);
      const pill=await frame.locator('[data-tray=agent] > i').evaluate(e=>getComputedStyle(e).backgroundImage);
      assert.ok(pill.includes(b.primaryCss)&&pill.includes(b.secondaryCss),'the agent button uses the organization colours: '+pill);
      const edge=await frame.locator('.fm-project-tray').evaluate(e=>getComputedStyle(e,'::before').backgroundImage);
      assert.ok(edge.includes(b.primaryCss)&&edge.includes(b.secondaryCss),'the agent edge uses them too: '+edge);
      assert.ok(!/139, 92, 246|236, 72, 153/.test(pill+edge),'no fixed purple or pink');
      await frame.evaluate(()=>cam.repaint());
      assert.equal(await frame.locator('.fmc-bar').evaluate(e=>getComputedStyle(e).backgroundColor),b.primaryCss,'Take photos follows the primary colour');
      await shot(page,'phone-agent-'+b.primary.slice(1));
    }
    await frame.getByRole('button',{name:'Close assistant',exact:true}).click();
    await frame.waitForTimeout(150);
    const closing=await frame.locator('.fm-project-tray').evaluate(e=>({visibility:getComputedStyle(e).visibility,opacity:Number(getComputedStyle(e).opacity),top:e.getBoundingClientRect().top,composer:e.querySelector('.fma-composer')?.getBoundingClientRect().height||0}));
    assert.equal(closing.visibility,'visible','the agent bar animates away');
    assert.ok(closing.composer>0,'with its content while it goes');
    assert.ok(closing.top>bar.top||closing.opacity<1,'sliding down and fading: '+JSON.stringify(closing));
    await settled(frame);
    assert.equal(await frame.locator('.fm-project-tray').isVisible(),false);
    assert.equal(await frame.locator('.fm-project-tray-tabs').getAttribute('data-agent-compact'),'false');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('360x740: the footer and sheets fit a small phone',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,frame,errors}=await project(browser,{width:360,height:740,mobile:true});
    const footer=await box(frame,'.fm-project-tray-tabs');
    assert.equal(footer.bottom,740);
    const labels=await frame.locator('.fm-project-tray-tabs .fm-tray-label').evaluateAll(n=>n.map(l=>({text:l.textContent,cut:l.scrollWidth>l.clientWidth+1})));
    assert.ok(labels.every(l=>!l.cut),'labels fit: '+JSON.stringify(labels));
    await frame.getByRole('tab',{name:'Activity',exact:true}).click();await settled(frame);
    assert.equal((await box(frame,'.fm-project-tray')).bottom,footer.top);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await shot(page,'phone-360-sheet');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('desktop is unchanged: header tray icons, a 380px right-hand tray, no footer, grip or scrim',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,frame,errors}=await project(browser,{width:1600,height:1000,mobile:false});
    const ids=await frame.evaluate(()=>FirstMateProjectTrays.definitions().map(item=>item.id));
    assert.deepEqual(await frame.locator('.r-modal-header .fm-project-tray-tabs [data-tray]').evaluateAll(n=>n.map(b=>b.dataset.tray)),ids,'the tray icons stay in the header');
    assert.equal(await frame.locator('.fm-project-tray-tabs').getAttribute('data-placement'),null);
    for(const b of await frame.locator('.fm-project-tray-tabs [data-tray]').all())assert.equal((await b.boundingBox()).width,32);
    assert.equal(await frame.locator('.fm-tray-label').first().isVisible(),false);
    assert.equal(await frame.locator('.fmc-bar').isVisible(),false,'no camera bar on desktop');
    await frame.getByRole('tab',{name:'Notes',exact:true}).click();await settled(frame);
    const tray=await box(frame,'.fm-project-tray'),content=await box(frame,'.fm-project-content');
    assert.equal(tray.width,380);assert.equal(tray.height,content.height);assert.equal(content.bottom,1000);
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-tray-mode'),null);
    assert.equal(await frame.locator('.fm-project-tray-grip').isVisible(),false);
    assert.equal(await frame.locator('.fm-project-tray-scrim').isVisible(),false);
    await frame.getByRole('tab',{name:'Agent',exact:true}).click();
    await frame.waitForSelector('.fma-msg');await settled(frame);
    assert.equal(await frame.locator('.fm-project-content').getAttribute('data-agent-compact'),'false');
    assert.equal((await box(frame,'.fm-project-tray')).height,content.height,'the agent is a full tray');
    await shot(page,'desktop-agent');
    await frame.getByRole('button',{name:'Close assistant',exact:true}).click();
    assert.equal(await frame.locator('.fm-project-tray-panel:not([hidden])').count(),0,'closing on desktop is as before');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
