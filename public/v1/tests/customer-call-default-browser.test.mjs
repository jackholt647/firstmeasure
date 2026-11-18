import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-546: a customer's phone number calls through the FirstMate phone. A link marked data-fm-customer-call opens the
// tray (a bottom sheet on a phone) ready to call that contact instead of the device's dialer; the tray offers a subtle
// "Call from this device" for the device's own phone app, which is also the fallback when calling is off.
test('a customer phone link opens the FirstMate phone, with a subtle call from this device',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:433,height:870},isMobile:true,hasTouch:true}),errors=[];
    page.on('pageerror',e=>errors.push(e.stack||e.message));
    await page.route('https://phone.test/**',route=>route.fulfill({body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}.main{height:100vh;position:relative}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="platformPhoneSlot"><button id="platformPhoneBtn">Phone</button></div><div id="mainPanels"><a id="contactCall" href="tel:2069415049" data-fm-customer-call="2069415049" data-contact-id="contact-one" data-project-id="project-one" data-customer-name="Bill Testo">Call Bill</a></div></main>',contentType:'text/html'}));
    await page.route('https://phone.test/libraries/window-manager/window-shell.js*',async route=>route.fulfill({body:await readFile(new URL('../../libraries/window-manager/window-shell.js',import.meta.url),'utf8'),contentType:'text/javascript'}));
    await page.goto('https://phone.test');
    await page.evaluate(()=>{
      window.__APP={orgId:'org-test',userId:'user-test'};
      window.voiceEnabled=true;window.statusRequests=0;
      window.Portal={appFlags:{has:()=>true},modules:{},navigation:{registerSchema(){},registerHandler(){},push(){}}};
      window.PlatformAPI={contacts:{settings:async()=>({settings:{tags:[]}})}};
      window.CommsAPI={customer:async(_org,path)=>{
        if(path==='voice/status'){window.statusRequests++;return {settings:{enabled:window.voiceEnabled,allowed_destination_countries:['US'],allowed_country_prefixes:['+1']},permissions:{manage:true},numbers:[{phone_number:'+12065550199',label:'Development test line',status:'active'}],sms_numbers:[],default_number:'+12065550199'};}
        if(path==='voice/endpoint/token')return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
        if(path==='voice/endpoint/presence')return {availability:'unavailable'};
        if(path==='call-scripts')return {scripts:[]};
        if(path.startsWith('call-context'))return {projects:[{contacts:[]}]};
        if(path.startsWith('voice/calls')||path.startsWith('calls'))return {calls:[],items:[]};
        return {};
      },customerUrl:(_org,path)=>`https://phone.test/v1/comms/organizations/org-test/${path}`,inbox:async()=>({conversations:[]})};
      window.TelnyxWebRTC={TelnyxRTC:class{constructor(){this.handlers={};}on(n,cb){this.handlers[n]=cb;}connect(){this.handlers['telnyx.ready']?.();}async setAudioSettings(){}disconnect(){}}};
    });
    for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','apps/comms/communications-ui.js','channels-ui/channels-ui.js','apps/comms/phone-tray.js','apps/comms/calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
    await page.evaluate(()=>{window.dialed=[];Portal.CustomerPhone.deviceCall=number=>{window.dialed.push(number);return true;};});

    await page.locator('#contactCall').tap();
    await page.waitForFunction(()=>{const tray=document.querySelector('.fm-phone-tray');return tray&&!tray.hidden&&tray.getBoundingClientRect().height>200&&document.querySelector('.fm-phone-selected');});
    assert.equal(page.url(),'https://phone.test/','the link did not hand the call to the device');
    assert.match(await page.locator('.fm-phone-selected').innerText(),/Bill Testo/);
    assert.deepEqual(await page.evaluate(()=>Portal.CustomerPhone.state.prepared),{contact_id:'contact-one',project_id:'project-one',customer_name:'Bill Testo',customer_number:'2069415049'});
    const start=page.locator('.fm-phone-tray [data-phone=start]'),device=page.locator('.fm-phone-tray [data-phone-device-call]');
    assert.equal(await start.isVisible(),true,'the FirstMate call is the main action');
    assert.equal(await device.isVisible(),true);
    assert.equal((await device.innerText()).trim(),'Call from this device');
    const [startBox,deviceBox]=[await start.boundingBox(),await device.boundingBox()];
    assert.ok(deviceBox.y>=startBox.y+startBox.height-1,'call from this device sits under Start call');
    const look=await device.evaluate(button=>{const style=getComputedStyle(button);return {background:style.backgroundColor,size:parseFloat(style.fontSize)};});
    assert.equal(look.background,'rgba(0, 0, 0, 0)','call from this device is a subtle text button');
    assert.ok(look.size<=12,'call from this device is small');
    await device.tap();
    assert.deepEqual(await page.evaluate(()=>window.dialed),['+12069415049']);

    // Typing a name hides it; a number brings it back.
    await page.locator('.fm-phone-selected button').tap();
    await page.locator('.fm-phone-tray [name=customer_number]').fill('Bill');
    assert.equal(await device.isVisible(),false);
    await page.locator('.fm-phone-tray [name=customer_number]').fill('');
    assert.equal(await device.isVisible(),false,'nothing to call from an empty dialer');
    await page.locator('.fm-phone-tray [name=customer_number]').fill('2025550111');
    assert.equal(await device.isVisible(),true);

    // With FirstMate calling off, the device's own phone app is used and no tray opens for it.
    await page.evaluate(()=>{window.voiceEnabled=false;Portal.CustomerPhone.state.status=null;});
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.call({customer_number:'2069415049'})),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
