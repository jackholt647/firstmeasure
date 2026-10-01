import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('phone connects automatically and closing cancels late token and SDK readiness',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://phone.test/**',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));
    await page.goto('https://phone.test');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org',userId:'user'};window.requests=[];window.clients=[];window.holdToken=true;
      window.Portal={};
      window.CommsAPI={customer:async(_org,path,body)=>{
        requests.push({path,body});
        if(path==='voice/status')return {settings:{enabled:true},permissions:{manage:true}};
        if(path==='voice/endpoint/token'){if(window.holdToken)await new Promise(r=>window.releaseToken=r);return {token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()};}
        if(path==='voice/endpoint/disconnect'&&window.failCleanup)throw Error('Offline');
        if(path==='voice/endpoint/presence')return {availability:'unavailable'};
        return {calls:[],scripts:[]};
      }};
      window.TelnyxWebRTC={TelnyxRTC:class{
        constructor(){this.handlers={};clients.push(this);}
        on(name,cb){(this.handlers[name]||=[]).push(cb);}
        emit(name){for(const cb of this.handlers[name]||[])cb();}
        async setAudioSettings(){}connect(){}disconnect(){this.stopped=true;}
      }};
    });
    for(const f of ['communications-ui.js','calling-runtime.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/comms/'+f,import.meta.url),'utf8')});
    await page.evaluate(()=>Portal.CustomerPhone.open({customer_number:'+12069415049'}));
    await page.waitForFunction(()=>typeof releaseToken==='function');
    assert.equal(await page.locator('[data-phone=connect]').count(),0);
    assert.equal(await page.locator('[name=mode]').inputValue(),'browser');
    await page.locator('[data-phone=start]').click();
    assert.match(await page.locator('[data-phone=start]').textContent(),/Connecting/);
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.path==='voice/endpoint/token').length),1);
    await page.locator('[data-phone=close]').click();
    await page.waitForFunction(()=>document.querySelector('.fmcp').hidden);
    await page.evaluate(()=>{holdToken=false;releaseToken();});
    await page.waitForFunction(()=>requests.some(r=>r.path==='voice/endpoint/disconnect'));
    assert.equal(await page.evaluate(()=>clients.length),0);
    assert.equal(await page.evaluate(()=>requests.filter(r=>r.path==='calls').length),0);
    await page.evaluate(()=>Portal.CustomerPhone.open());
    await page.waitForFunction(()=>clients.length===1&&clients[0].handlers['telnyx.ready']);
    await page.locator('[data-phone=close]').click();
    await page.waitForFunction(()=>clients[0].stopped);
    await page.evaluate(()=>clients[0].emit('telnyx.ready'));
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.connected),false);
    assert.equal(await page.locator('.fmcp').evaluate(e=>e.hidden),true);
    await page.evaluate(()=>Portal.CustomerPhone.open());
    await page.waitForFunction(()=>clients.length===2&&clients[1].handlers['telnyx.ready']);
    await page.evaluate(()=>clients[1].emit('telnyx.ready'));
    await page.waitForFunction(()=>Portal.CustomerPhone.connected&&!Portal.CustomerPhone.connecting);
    await page.locator('[data-phone=minimize]').click();
    assert.equal(await page.evaluate(()=>Portal.CustomerPhone.connected),true);
    await page.evaluate(()=>window.failCleanup=true);
    await page.locator('[data-phone=close]').click();
    await page.waitForFunction(()=>clients[1].stopped&&!Portal.CustomerPhone.connected);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
