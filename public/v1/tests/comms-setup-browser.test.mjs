import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-491: the Communications setup's own pages, against a stubbed publication layer and platform billing:
// intro → texts and calls → texting plan (card on file) → set up email next → Go to Communications.
test('Communications setup walks texts and calls, the texting plan and email, through published actions',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:960,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://comms-setup.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
      return route.fulfill({contentType:'text/html',body:'<main id="step"></main>'});
    });
    await page.goto('https://comms-setup.test/');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org-test'};window.calls=[];window.events=[];
      const status={phone:{texts:false,calls:false,numbers:[],texting_numbers:[]},email:{on:false,address:''},done:{phone:false,email:false}};
      window.PlatformAPI={baseUrl:()=>'/v1/platform',
        publication:{invoke:async(org,action,target,input,options)=>{calls.push({action,target,input,options});
          if(action==='comms.setup.start'){if(input.channel==='phone'){status.phone={texts:true,calls:true,numbers:['+12025550100'],texting_numbers:[]};status.done.phone=true;}else{status.email={on:true,address:'acme@mail.test'};status.done.email=true;}}
          return {value:structuredClone(status)};}},
        request:async path=>({can_manage:true,payment_details:{has_payment_method:true},subscriptions:[],prices:[{id:'sms-basic',product_id:'sms',plan_key:'basic',version:1,published:true,capability_key:'comms.sms',name:'SMS Basic',description:'1,000 texts',monthly_cents:3000,currency:'USD'}]})};
      window.FirstMatePlatformBilling={isEnabled:()=>true,review:async options=>{calls.push({action:'billing.review',input:options});return true;}};
      addEventListener('fm:comms:setup-changed',()=>events.push('changed'));
    });
    await page.evaluate(async()=>{
      const module=await import('/libraries/guided-experiences/comms-setup.js');
      window.completed=0;
      window.handle=module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:(key,fallback)=>fallback,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),change(){},setTitle(){},complete:async()=>{completed++;}});
    });
    await page.getByText('Every conversation with your customers, in one place').waitFor();
    for(const way of ['Texts','Calls','Email'])assert.equal(await page.locator('.gxc-way strong',{hasText:way}).count(),1,way);
    await page.getByRole('button',{name:/Set up texts and calls/}).click();
    await page.getByRole('button',{name:'Turn on texts and calls'}).click();
    await page.getByText('Texts are on').waitFor();
    await page.getByText('Texts and calls use +12025550100.').waitFor();
    await page.getByRole('button',{name:'Continue'}).click();
    await page.getByText('SMS Basic').waitFor();
    await page.getByText('We’ll charge the card you already have on file.').waitFor();
    await page.getByRole('button',{name:'Add this plan'}).click();
    await page.getByRole('button',{name:'Not now'}).click();
    await page.getByText('Texts and calls is set up').waitFor();
    await page.getByRole('button',{name:/Set up email/}).click();
    await page.getByRole('button',{name:'Turn on email'}).click();
    await page.locator('[data-gxc-address]',{hasText:'acme@mail.test'}).waitFor();
    await page.getByRole('button',{name:'Continue'}).click();
    assert.equal(await page.getByRole('button',{name:/Set up texts and calls/}).count(),0,'nothing left to set up');
    await page.getByRole('button',{name:'Go to Communications'}).click();
    await page.waitForFunction(()=>completed===1);
    const calls=await page.evaluate(()=>calls);
    assert.deepEqual(calls.filter(c=>c.action==='comms.setup.start').map(c=>c.input.channel),['phone','email']);
    assert.ok(calls.filter(c=>c.action==='comms.setup.start').every(c=>c.options.idempotencyKey&&c.target.scope==='organization'));
    assert.deepEqual(calls.find(c=>c.action==='billing.review').input,{orgId:'org-test',priceId:'sms-basic'});
    assert.equal(await page.evaluate(()=>events.length),2,'each channel tells Communications to redraw');
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
