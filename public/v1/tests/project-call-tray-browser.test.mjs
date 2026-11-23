import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// GP-155: a project window is a frame of the portal and has one phone, the portal's. A call started in it opens in
// the window's Call tray (comms/project-call-tray.js), which holds the portal's one call panel while the window shows;
// the tab is marked while the call is live and when its customer is not on the project; a second call is refused;
// minimizing or closing the window gives the call back to the phone tray (comms/phone-tray.js projectCallHost).
const asset=f=>readFile(new URL('../../libraries/'+f,import.meta.url),'utf8');
const scripts=['window-manager/window-manager.js','window-manager/window-shell.js','apps/comms/communications-ui.js','apps/comms/phone-tray.js','apps/comms/calling-runtime.js','project-trays/project-trays.js','apps/comms/project-call-tray.js'];
// What both documents need before the scripts: the session, the portal, and the communications API.
function fixture(){
  window.__APP={orgId:'org-test',userId:'user-test',userOrgId:'org-test'};
  window.Portal={appFlags:{has:()=>true},can:()=>true,modules:{},navigation:{registerSchema(){},registerHandler(){},push(){},backOrClose(){}}};
  window.TelnyxWebRTC={TelnyxRTC:class{constructor(){this.handlers={};}on(n,cb){this.handlers[n]=cb;}connect(){this.handlers['telnyx.ready']?.();}async setAudioSettings(){}disconnect(){}}};
  window.CommsAPI={customer:async(_org,path)=>{
    const top=window.top;
    if(path==='voice/endpoint/token')return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
    if(path==='voice/endpoint/presence')return {availability:'unavailable'};
    if(path==='voice/status')return {settings:{enabled:true,allowed_destination_countries:['US'],allowed_country_prefixes:['+1']},permissions:{manage:true},numbers:[{phone_number:'+12065550199',label:'Test line',status:'active'}],default_number:'+12065550199'};
    if(path.startsWith('call-context'))return {projects:[{contacts:[{id:'contact-one',name:'Jane Test',phone:'+12025550124',primary:true}]}]};
    if(path.startsWith('calls/')&&top.testCall)return {call:top.testCall};
    return {};
  },customerUrl:(_org,path)=>`https://phone.test/v1/comms/organizations/org-test/${path}`};
}
test('a project window opens the call in its Call tray, marks it, keeps one call, and gives it back when it goes',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:860}}),errors=[];
    page.on('pageerror',e=>errors.push(e.stack||e.message));
    await page.route('https://phone.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
    await page.goto('https://phone.test/');
    // The portal: its phone tray, and a project window's layer holding the window's frame (window-manager/project-windows.js).
    await page.evaluate(()=>{document.body.innerHTML='<style>body{margin:0;font-family:Arial,sans-serif}.main{height:100vh;position:relative}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="mainPanels"></div><div class="fm-project-window-layer" data-mode="modal" style="position:fixed;left:40px;top:60px;width:900px;height:760px"><iframe src="https://phone.test/project" style="border:0;width:100%;height:100%"></iframe></div></main>';});
    await page.evaluate(fixture);
    for(const file of scripts)await page.addScriptTag({content:await asset(file)});
    await page.addStyleTag({content:await asset('apps/comms/communications.css')});
    const frame=page.frames().find(f=>f!==page.mainFrame());await frame.waitForLoadState();
    // The project window: an open project with its trays.
    await frame.evaluate(()=>{document.body.innerHTML='<style>html,body{height:100%;margin:0;font-family:Arial,sans-serif}</style><div id="rOverlay" class="r-overlay active" data-window-mode="modal"><div class="r-win" style="position:fixed;inset:0;display:flex;flex-direction:column"><header class="r-modal-header" style="display:flex;height:44px"></header><div class="r-preview" style="flex:1;min-height:0"></div></div></div>';});
    await frame.evaluate(fixture);
    for(const file of scripts)await frame.addScriptTag({content:await asset(file)});
    await frame.addStyleTag({content:await asset('apps/comms/communications.css')});
    await frame.evaluate(()=>{window.project={id:'project-one',contacts:[{id:'contact-one',name:'Jane Test',phone:'+12025550124'}]};window.trays=FirstMateProjectTrays.mount(document.querySelector('.r-win'),{content:document.querySelector('.r-preview'),header:document.querySelector('.r-modal-header'),getProject:()=>window.project,orgId:'org-test'});});
    const tab=frame.locator('.fm-project-tray-tabs [data-tray=call]'),inTray=frame.locator('.fm-project-call .fmcp'),phoneTray=page.locator('.fm-phone-tray');
    assert.equal(await tab.count(),0,'no Call tab without a call');

    // New call in the project window: the portal's phone opens it, in this window's Call tray.
    assert.equal(await frame.evaluate(()=>Portal.CustomerPhone.state===window.top.Portal.CustomerPhone.state),true,'one phone');
    assert.equal(await frame.evaluate(()=>Portal.ProjectCallTray.open({project_id:'project-one'})),true);
    await inTray.waitFor();
    assert.equal(await tab.getAttribute('aria-selected'),'true');
    assert.equal(await inTray.locator('[name=customer_number]').inputValue(),'+12025550124','the project contact is ready to call');
    assert.equal(await phoneTray.isVisible(),false,'the phone tray steps aside');
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.state.error),'');

    // A live call to someone who is not on this project: the tab and the tray say so.
    await page.evaluate(()=>{window.testCall={id:'call-other',state:'connected',mode:'browser',direction:'outbound',owner_user_id:'user-test',customer_name:'Morgan Lee',customer_number:'+12065550177',contact_id:'contact-elsewhere',project_id:'project-two',wrap_up_state:'draft',metadata:{}};});
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'call-other'}));
    await frame.waitForFunction(()=>document.querySelector('.fm-project-tray-tabs [data-tray=call]')?.dataset.trayState==='live other');
    assert.match(await frame.locator('.fm-project-call-other').textContent(),/Morgan Lee is not a customer on this project/);
    assert.equal(await inTray.count(),1,'the call stays in the project window');
    // The same live call from this project is not marked.
    await frame.evaluate(()=>{window.project={...window.project,id:'project-two'};window.trays.update();window.dispatchEvent(new CustomEvent('fm:customer-calls:changed'));});
    await frame.waitForFunction(()=>document.querySelector('.fm-project-tray-tabs [data-tray=call]')?.dataset.trayState==='live');
    assert.equal(await frame.locator('.fm-project-call-other').isVisible(),false);

    // One call at a time: a call to someone else is refused, and the live call stays.
    assert.equal(await frame.evaluate(()=>Portal.ProjectCallTray.open({project_id:'project-two',customer_number:'+12025550124'})),false);
    assert.equal(await page.evaluate(()=>[Portal.CustomerPhone.state.call.id,Portal.CustomerPhone.state.error].join('|')),'call-other|Finish the active call before opening another contact.');
    assert.match(await inTray.textContent(),/Finish the active call/);

    // Minimizing the window gives the call to the phone tray; restoring it brings it back.
    await page.evaluate(()=>{document.querySelector('.fm-project-window-layer').dataset.mode='minimized';});
    await page.locator('.fm-phone-tray .fmcp').waitFor();
    assert.equal(await phoneTray.isVisible(),true);
    await page.evaluate(()=>{document.querySelector('.fm-project-window-layer').dataset.mode='modal';});
    await inTray.waitFor();
    assert.equal(await phoneTray.isVisible(),false);

    // Closing the window: the panel leaves the frame as it goes, still working, and the phone tray shows the call.
    await page.evaluate(()=>document.querySelector('.fm-project-window-layer').remove());
    await page.locator('.fm-phone-tray .fmcp').waitFor();
    assert.equal(await phoneTray.isVisible(),true);
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.state.panel.ownerDocument===document),true);
    await page.evaluate(()=>{window.testCall={...window.testCall,state:'ended',wrap_up_state:'saved'};});
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'call-other'}));
    await page.locator('.fm-phone-tray [data-phone=new-call]').click();
    await page.waitForFunction(()=>!Portal.CustomerPhone.state.call);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
