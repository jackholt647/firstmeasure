import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserService, publicAddress, signupUrl } from '../payment-browser/server.mjs';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('Set up payments suggestion opens a persistent browser beside the global chat',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<style>html,body{margin:0;height:100%;font-family:Arial}main.main{position:relative;height:100vh;width:100%;overflow:hidden}</style><main class="main"><div id="mainPanels"></div></main>');
    await page.evaluate(()=>{
      window.Portal={};window.__APP={userOrgId:'new-org'};window.sessionStarts=0;window.sent=[];
      const thread={id:'main',title:'Main conversation'};
      window.AssistantAPI={context:async()=>({main_thread:thread,threads:[],agents:[],dashboard:[]}),thread:async()=>({thread,messages:[]}),send:async(_org,_id,body)=>{window.sent.push(body.message);return {thread,assistant_message:{id:'reply',content:'Complete signup beside the chat.',data:{renders:[{type:'payment_setup'}]}}};}};
      window.PaymentsAPI={request:async(path)=>{if(path.endsWith('/session')){window.sessionStarts++;return {state:'ready',session_id:'00112233-4455-4677-8899-aabbccddeeff',width:900,height:780};}return {state:'ready',width:900,height:780};}};
    });
    for(const file of ['window-manager/window-manager.js','payments-setup/payments-setup.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await page.evaluate(()=>window.PlatformAssistant.openFull());
    await page.getByRole('button',{name:'Set up payments',exact:true}).click();
    await page.getByRole('application').waitFor({state:'visible'});
    const rectangles=await page.evaluate(()=>{const a=document.querySelector('.fma-payment-widget').getBoundingClientRect(),b=document.querySelector('.fma-main').getBoundingClientRect();return {a:{x:a.x,width:a.width,height:a.height},b:{x:b.x,width:b.width}};});
    assert.ok(rectangles.a.width>350&&rectangles.a.height>400,JSON.stringify(rectangles));
    assert.ok(rectangles.b.x>rectangles.a.x+rectangles.a.width-1,JSON.stringify(rectangles));
    await page.evaluate(()=>window.PlatformAssistant.openPaymentSetup());
    assert.equal(await page.evaluate(()=>window.sessionStarts),1);
    assert.deepEqual(await page.evaluate(()=>window.sent),['Set up payments']);
    assert.equal(await page.locator('iframe').count(),0);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test('signup URL and egress reject production, credentials, private and metadata addresses',()=>{
  for(const url of ['http://boarding.sandbox.getfwd.com/a','https://boarding.getfwd.com/a','https://sandbox.getfwd.com.evil.test/a','https://user:pass@boarding.sandbox.getfwd.com/a','https://localhost/a']) assert.throws(()=>signupUrl(url));
  assert.equal(signupUrl('https://boarding.sandbox.getfwd.com/a'),'https://boarding.sandbox.getfwd.com/a');
  for(const ip of ['127.0.0.1','10.124.16.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1']) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('1.1.1.1'),true);
});

test('private browser reservations are exclusive, bounded, and isolated by owner and session',async()=>{
  const token=randomBytes(32).toString('hex');
  const service=await createBrowserService({token,port:0,maxSessions:2});
  try{
    const base=`http://127.0.0.1:${service.server.address().port}`;
    const call=async(route,body,credential=token)=>{const r=await fetch(base+route,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
    const owner='a'.repeat(64),other='b'.repeat(64);
    assert.equal((await call('/reserve',{owner},'incorrect')).status,401);
    const reservations=await Promise.all(Array.from({length:6},()=>call('/reserve',{owner})));
    assert.equal(reservations.filter(r=>r.data.claimed).length,1);
    assert.equal(new Set(reservations.map(r=>r.data.session_id)).size,1);
    const id=reservations[0].data.session_id;
    assert.equal((await call('/frame',{owner:other,session_id:id})).status,410);
    assert.equal((await call('/close',{owner,session_id:'wrong'})).status,410);
    await call('/reserve',{owner:other});
    assert.equal((await call('/reserve',{owner:'c'.repeat(64)})).status,429);
    assert.equal((await call('/close',{owner,session_id:id})).status,200);
    assert.equal((await call('/frame',{owner,session_id:id})).status,410);
    assert.equal((await call('/reserve',{owner:'c'.repeat(64)})).status,200);
  }finally{await service.close();}
});

test('dashboard browser transmits direct typing, paste, scrolling, file upload and close without putting inputs in chat',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    await page.setContent('<main style="width:680px;height:780px"></main>');
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.evaluate(()=>{
      window.events=[];window.wantUpload=false;window.completed=false;
      window.PaymentsAPI={request:async(path,options)=>{
        if(path.endsWith('/session'))return {state:'ready',session_id:'00112233-4455-4677-8899-aabbccddeeff',width:680,height:700};
        if(path.includes('/frame?'))return {width:680,height:700,sequence:1,upload_requested:window.wantUpload,complete:window.completed};
        if(path.endsWith('/input')){window.events.push(options.body.event);if(options.body.event.type==='upload')window.wantUpload=false;return {ok:true};}
        if(path.endsWith('/close'))window.didClose=true;
        return {ok:true};
      }};
    });
    await page.addScriptTag({content:await readFile(new URL('../../libraries/payments-setup/payments-setup.js',import.meta.url),'utf8')});
    await page.evaluate(()=>window.FirstMatePaymentsSetup.mount(document.querySelector('main'),{orgId:'test'}));
    await page.getByRole('application').click({position:{x:100,y:100}});
    await page.keyboard.type('Example Company');
    await page.keyboard.press('Tab');
    await page.mouse.wheel(0,150);
    await page.evaluate(()=>{const e=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{getData:()=> 'Pasted details'}});document.querySelector('textarea').dispatchEvent(e);});
    await page.waitForFunction(()=>window.events.some(e=>e.type==='text'&&e.text==='Pasted details'));
    await page.evaluate(()=>window.wantUpload=true);
    await page.locator('[data-file]').setInputFiles({name:'sample.txt',mimeType:'text/plain',buffer:Buffer.from('sample document')});
    await page.waitForFunction(()=>window.events.some(e=>e.type==='upload'));
    const events=await page.evaluate(()=>window.events);
    assert.ok(events.some(e=>e.type==='pointer'&&e.action==='mousePressed'));
    assert.ok(events.some(e=>e.type==='key'&&e.key==='Tab'));
    assert.ok(events.some(e=>e.type==='wheel'&&e.deltaY===150));
    assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Example CompanyPasted details');
    assert.equal(Buffer.from(events.find(e=>e.type==='upload').data,'base64').toString(),'sample document');
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.waitForFunction(()=>window.didClose);
    assert.equal(await page.locator('iframe').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
