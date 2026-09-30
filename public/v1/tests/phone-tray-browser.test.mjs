import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('phone stays docked, floats above minimized windows, retains ended calls and restores without fullscreen',async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://phone.test/**',route=>route.fulfill({body:'<style>body{margin:0}.main{height:900px;position:relative}</style><main class="main"><header id="platformTopbar" style="height:50px"></header><div id="platformPhoneSlot"><button id="platformPhoneBtn">Phone</button></div><div id="mainPanels"></div></main>',contentType:'text/html'}));
    await page.goto('https://phone.test');
    await page.evaluate(()=>{
      window.__APP={orgId:'org-test',userId:'user-test'};
      window.Portal={appFlags:{has:()=>true},navigation:{registerSchema(){},registerHandler(){},push(){}}};
      window.testCall={id:'call-test',customer_name:'Test contact',customer_number:'+12025550123',state:'connected',mode:'browser',owner_user_id:'user-test',wrap_up_state:'draft',metadata:{}};
      window.CommsAPI={customer:async(_org,path,data)=>{
        if(path==='voice/status')return {settings:{enabled:true},permissions:{manage:true}};
        if(path==='call-scripts')return {scripts:[]};
        if(path==='call-context')return {contacts:[]};
        if(path==='call-lists/queue')return {columns:[]};
        if(path.startsWith('voice/contacts'))return {contacts:[{id:'contact-one',name:'Jane Test',phone:'+12025550124'}]};
        if(path.includes('/actions')){if(data.action==='hangup')window.testCall={...window.testCall,state:'ended',wrap_up_state:'needs_wrap_up'};return {call:window.testCall};}
        if(path.startsWith('calls/'))return {call:window.testCall};
        return {};
      }};
    });
    for(const file of ['window-manager/window-manager.js','apps/comms/communications-ui.js','apps/comms/phone-tray.js','apps/comms/calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
    await page.evaluate(()=>Portal.CustomerPhone.open());
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'docked');
    await page.locator('[data-digit="2"]').click();
    assert.equal(await page.locator('[name=customer_number]').inputValue(),'2');
    await page.locator('[data-phone-tab=contacts]').click();
    await page.getByRole('textbox',{name:'Search contacts'}).fill('Jane');
    await page.getByRole('button',{name:'Jane Test'}).click();
    assert.equal(await page.locator('[name=customer_number]').inputValue(),'+12025550124');
    if(process.env.PHONE_TRAY_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_TRAY_SCREENSHOTS+'/docked.png'});
    await page.evaluate(()=>{const e=document.createElement('aside'),h=document.createElement('header');h.textContent='Other minimized window';e.append(h);document.querySelector('main').append(e);window.otherWindow=FirstMateWindows.attach({element:e,header:h,host:document.querySelector('main'),mode:'minimized',name:'other'});});
    await page.getByRole('button',{name:'Float phone',exact:true}).click();
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'floating');
    assert.equal(await page.getByRole('button',{name:/Maximize phone|Fill workspace|Fill entire screen/}).count(),0);
    await page.waitForFunction(()=>document.querySelector('.fm-phone-tray').getBoundingClientRect().bottom<=856);
    const box=await page.locator('.fm-phone-tray').boundingBox();assert.ok(box.width<400&&box.y+box.height<=858,JSON.stringify(box));
    if(process.env.PHONE_TRAY_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_TRAY_SCREENSHOTS+'/floating.png'});
    await page.evaluate(()=>Portal.CustomerPhone.open({call_id:'call-test'}));
    await page.getByRole('button',{name:'Minimize phone',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.fm-phone-tray').getBoundingClientRect().height<=79);
    if(process.env.PHONE_TRAY_SCREENSHOTS)await page.screenshot({path:process.env.PHONE_TRAY_SCREENSHOTS+'/minimized.png'});
    await page.locator('.fm-phone-compact [data-phone=hangup]').click();
    await page.waitForFunction(()=>document.querySelector('.fm-phone-title').textContent.includes('Outcome ready'));
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'minimized');
    await page.locator('.fm-phone-title').click();
    assert.equal(await page.locator('.fm-phone-tray').getAttribute('data-window'),'floating');
    await page.getByRole('button',{name:'Close phone',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.fm-phone-tray').hidden);
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>Portal.CustomerPhone.open());
    const mobile=await page.locator('.fm-phone-tray').boundingBox();assert.ok(mobile.x>=0&&mobile.x+mobile.width<=390);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
