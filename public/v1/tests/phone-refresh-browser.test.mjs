import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('refresh keeps the endpoint identity while a duplicated tab cannot borrow it',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const context=await browser.newContext();let owner='',tokens=0;
    await context.exposeBinding('phoneFixture',(_source,path,body)=>{
      if(path==='voice/status')return {settings:{enabled:true}};
      if(path==='voice/endpoint/token'){
        if(owner&&owner!==body.device_id)throw Error('Your phone is connected in another tab or device.');
        owner=body.device_id;tokens++;return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};
      }
      if(path==='voice/endpoint/presence')return {availability:'unavailable'};
      return {scripts:[],calls:[]};
    });
    await context.addInitScript(()=>{
      window.__APP={userOrgId:'org',userId:'user'};window.Portal={};
      window.CommsAPI={customer:(_org,path,body)=>window.phoneFixture(path,body)};
      window.TelnyxWebRTC={TelnyxRTC:class{
        constructor(){this.handlers={};}on(n,fn){(this.handlers[n]||=[]).push(fn);}
        async setAudioSettings(){}connect(){for(const fn of this.handlers['telnyx.ready'])fn();}disconnect(){}
      }};
    });
    const code=(await Promise.all(['communications-ui.js','calling-runtime.js'].map(f=>readFile(new URL('../../libraries/apps/comms/'+f,import.meta.url),'utf8')))).join('\n');
    await context.route('https://refresh.test/**',r=>r.fulfill({contentType:'text/html',body:'<body><script>'+code+'</script></body>'}));
    const page=await context.newPage();await page.goto('https://refresh.test');
    await page.evaluate(()=>Portal.CustomerPhone.open());await page.waitForFunction(()=>Portal.CustomerPhone.connected);
    const original=await page.evaluate(()=>Portal.CustomerPhone.deviceId);
    await page.reload();await page.evaluate(()=>Portal.CustomerPhone.open());await page.waitForFunction(()=>Portal.CustomerPhone.connected);
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.deviceId),original);
    assert.equal(tokens,2);
    const opened=context.waitForEvent('page');await page.evaluate(()=>window.open(location.href));const duplicate=await opened;await duplicate.waitForLoadState();
    await duplicate.evaluate(()=>Portal.CustomerPhone.open());await duplicate.waitForFunction(()=>document.querySelector('.fmcm-error')?.textContent.includes('another tab'));
    assert.notEqual(await duplicate.evaluate(()=>Portal.CustomerPhone.deviceId),original);
    assert.equal(owner,original);assert.equal(tokens,2);
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.connected),true);
  }finally{await browser.close();}
});
