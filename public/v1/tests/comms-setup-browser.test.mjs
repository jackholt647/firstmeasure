import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-491, FM-510, FM-513: the Communications setup's own pages, against a stubbed publication layer, platform billing and the
// carrier registration workflow: one title and one line under it, the three channels in a row (each explained in its
// tooltip), straight to the two choices; texts and calls turn on and go straight into registration; one done page
// that offers email (and the texting plan) right there; Go to Communications.
test('Communications setup: start, carrier registration, one done page with email, the plan, through published actions',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:960,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://comms-setup.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
      return route.fulfill({contentType:'text/html',body:'<div class="gxs"><main id="step"></main></div>'});
    });
    await page.goto('https://comms-setup.test/');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org-test'};window.calls=[];window.events=[];window.registration='none';
      const status={phone:{texts:false,calls:false,numbers:[],texting_numbers:[],registration:'none'},email:{on:false,address:''},done:{phone:false,email:false}};
      window.PlatformAPI={baseUrl:()=>'/v1/platform',
        publication:{invoke:async(org,action,target,input,options)=>{calls.push({action,target,input,options});
          if(action==='comms.setup.start'){if(input.channel==='phone'){status.phone={texts:true,calls:registration==='approved',numbers:registration==='approved'?['+12025550100']:[],texting_numbers:[],registration};status.done.phone=true;}else{status.email={on:true,address:'acme@mail.test'};status.done.email=true;}}
          return {value:structuredClone(status)};}},
        request:async path=>({can_manage:true,payment_details:{has_payment_method:true},subscriptions:[],prices:[{id:'sms-basic',product_id:'sms',plan_key:'basic',version:1,published:true,capability_key:'comms.sms',name:'SMS Basic',description:'1,000 texts',monthly_cents:3000,currency:'USD'}]})};
      window.FirstMatePlatformBilling={isEnabled:()=>true,review:async options=>{calls.push({action:'billing.review',input:options});return true;}};
      // The registration workflow (settings/sms-registration.js): the test submits it by closing it.
      window.FirstMateSetupWizard={open(){}};
      window.FirstMateSmsRegistration={open:options=>new Promise(resolve=>{calls.push({action:'registration.open',input:options});window.submitRegistration=()=>{registration='approved';resolve({id:'profile'});};})};
      window.DomainsAPI={config:async()=>({configured:true,encryption_configured:true})};
      window.FirstMateDomainsSettings={openForEmail:async options=>{calls.push({action:'domains.open',input:options});}};
      addEventListener('fm:comms:setup-changed',()=>events.push('changed'));
    });
    await page.evaluate(async()=>{
      const module=await import('/libraries/guided-experiences/comms-setup.js');
      window.completed=0;window.titles=[];
      window.handle=module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:(key,fallback)=>fallback,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),change(){},setTitle(value){titles.push(value);},complete:async()=>{completed++;}});
    });
    // The start: one line under the title, no paragraphs; the channels side by side, each explained in its tooltip.
    await page.getByText('Every conversation with your customers in one place.').waitFor();
    assert.equal(await page.locator('.gxc p:not(.gxc-error)').count(),1,'one line of copy on the start');
    const tops=await page.locator('.gxc-way').evaluateAll(ways=>ways.map(way=>way.offsetTop));
    assert.equal(tops.length,3); assert.equal(new Set(tops).size,1,'texts, calls and email in one row');
    assert.equal(await page.locator('#gxc-tip-texts').evaluate(tip=>getComputedStyle(tip).opacity),'0');
    await page.locator('[data-gxc-way="calls"]').hover();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#gxc-tip-calls')).opacity==='1');
    for(const choice of ['phone','email'])assert.equal(await page.locator(`[data-gxc-start="${choice}"] .gxc-icon i`).evaluate(i=>getComputedStyle(i).getPropertyValue('content')!==''||i.className.includes('fa-')),true,choice+' has an icon');
    // Texts and calls: on at once and straight into registration, with no page in between.
    await page.getByRole('button',{name:/^Texts and calls/}).click();
    await page.waitForFunction(()=>calls.some(c=>c.action==='registration.open'));
    assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.action)),['comms.setup.status','comms.setup.start','registration.open']);
    assert.equal(await page.getByText('Turn on texts and calls').count(),0);
    assert.equal(await page.locator('.gxs').evaluate(sheet=>getComputedStyle(sheet).visibility+(sheet.inert?' inert':'')),'hidden inert','the setup steps aside while the workflow is open');
    await page.evaluate(()=>submitRegistration());
    // One done page: texts and calls ready, email offered right there, and the texting plan.
    await page.getByText('Ready on +12025550100.').waitFor();
    assert.equal(await page.locator('.gxs').evaluate(sheet=>getComputedStyle(sheet).visibility),'visible');
    await page.getByRole('button',{name:'Set up'}).waitFor();
    await page.getByRole('button',{name:'Choose a plan'}).click();
    await page.getByText('SMS Basic').waitFor();
    await page.getByText('We’ll charge the card you already have on file.').waitFor();
    await page.getByRole('button',{name:'Add this plan'}).click();
    await page.getByRole('button',{name:'Not now'}).click();
    // FM-513: email asks how it starts (nothing is turned on until a way is picked), then FirstMate Mail is on at once.
    const before=await page.evaluate(()=>calls.length);
    await page.getByRole('button',{name:'Set up'}).click();
    for(const name of [/^Use my domain/,/^Buy a domain/,/^FirstMate Mail/])await page.getByRole('button',{name}).waitFor();
    assert.equal(await page.evaluate(()=>calls.length),before,'choosing email turns nothing on');
    assert.equal(await page.getByText('Find a new one').count(),1,'domains can be bought where the registry is set up');
    await page.getByRole('button',{name:/^FirstMate Mail/}).click();
    await page.locator('[data-gxc-address]',{hasText:'acme@mail.test'}).waitFor();
    assert.equal(await page.getByText('Ready on +12025550100.').count(),1,'email is turned on in the same page');
    await page.getByRole('button',{name:'Go to Communications'}).click();
    await page.waitForFunction(()=>completed===1);
    const calls=await page.evaluate(()=>calls);
    assert.deepEqual(calls.filter(c=>c.action==='comms.setup.start').map(c=>c.input.channel),['phone','phone','email'],'phone again after registration reads where it stands');
    assert.equal(calls.filter(c=>c.action==='domains.open').length,0);
    assert.ok(calls.filter(c=>c.action==='comms.setup.start').every(c=>c.options.idempotencyKey&&c.target.scope==='organization'));
    assert.deepEqual(calls.find(c=>c.action==='registration.open').input,{orgId:'org-test'});
    assert.deepEqual(calls.find(c=>c.action==='billing.review').input,{orgId:'org-test',priceId:'sms-basic'});
    assert.equal(await page.evaluate(()=>events.length),3,'each change tells Communications to redraw');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Back'}).click();
    const phoneTops=await page.locator('.gxc-way').evaluateAll(ways=>ways.map(way=>way.offsetTop));
    assert.equal(new Set(phoneTops).size,1,'still one row on a phone');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// FM-510: registration closed before it was submitted: the done page asks to finish it and offers nothing else first.
test('Communications setup: an unfinished registration is the one thing left to do',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://comms-setup.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
      return route.fulfill({contentType:'text/html',body:'<main id="step"></main>'});
    });
    await page.goto('https://comms-setup.test/');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org-test'};window.opened=0;
      const status={phone:{texts:false,registration:'none'},email:{on:false},done:{phone:false,email:false}};
      window.PlatformAPI={baseUrl:()=>'/v1/platform',publication:{invoke:async(org,action,target,input)=>{if(action==='comms.setup.start'&&input.channel==='phone'){status.phone={texts:true,registration:'draft'};status.done.phone=true;}return {value:structuredClone(status)};}}};
      window.FirstMatePlatformBilling={isEnabled:()=>false};
      window.FirstMateSetupWizard={open(){}};
      window.FirstMateSmsRegistration={open:async()=>{opened++;return {id:'draft'};}};
      window.__fmCommsSetupStart='phone';
    });
    await page.evaluate(async()=>{
      const module=await import('/libraries/guided-experiences/comms-setup.js');
      module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:(key,fallback)=>fallback,esc:value=>String(value??''),change(){},setTitle(){},complete:async()=>{}});
    });
    await page.getByText('Register your business with the carriers to start texting.').waitFor();
    assert.equal(await page.evaluate(()=>opened),1,'an Overview button for texts goes straight into registration');
    await page.getByRole('button',{name:'Continue'}).click();
    await page.waitForFunction(()=>opened===2);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// FM-513: email from an Overview button opens the choice, not FirstMate Mail. "Use my domain" runs the Domains workflow
// full screen; closed before the domain is verified, the choice offers to finish it; once it has its address, email is
// on and the done page shows that address and where mail is sent from until the domain's email records are set up.
test('Communications setup: email on the company\'s own domain',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://comms-setup.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
      return route.fulfill({contentType:'text/html',body:'<div class="gxs"><main id="step"></main></div>'});
    });
    await page.goto('https://comms-setup.test/');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org-test'};window.calls=[];window.opens=[];
      const status={phone:{texts:false,registration:'none'},email:{on:false,address:'',domain:null},done:{phone:false,email:false}};
      window.PlatformAPI={baseUrl:()=>'/v1/platform',publication:{invoke:async(org,action,target,input)=>{calls.push({action,input});
        if(action==='comms.setup.start'&&input.channel==='email'){status.email={...status.email,on:true,address:'acme@firstmatemail.com'};status.done.email=true;}
        return {value:structuredClone(status)};}}};
      window.FirstMatePlatformBilling={isEnabled:()=>false};
      window.FirstMateSetupWizard={open(){}};
      window.DomainsAPI={config:async()=>({configured:false})};
      window.FirstMateDomainsSettings={openForEmail:options=>new Promise(resolve=>{opens.push({...options,hidden:getComputedStyle(document.querySelector('.gxs')).visibility});
        window.closeDomains=(domain)=>{status.email.domain=domain;resolve();};})};
      window.__fmCommsSetupStart='email';
    });
    await page.evaluate(async()=>{
      const module=await import('/libraries/guided-experiences/comms-setup.js');
      module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:(key,fallback)=>fallback,esc:value=>String(value??''),change(){},setTitle(){},complete:async()=>{}});
    });
    await page.getByText('Not available yet').waitFor();
    assert.equal(await page.getByRole('button',{name:/^Buy a domain/}).isDisabled(),true,'no domain can be bought while the registry is not set up');
    assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.action)),['comms.setup.status'],'nothing is turned on by itself');
    await page.getByRole('button',{name:/^Use my domain/}).click();
    await page.waitForFunction(()=>opens.length===1);
    assert.deepEqual(await page.evaluate(()=>opens[0]),{orgId:'org-test',path:'existing',domain:'',hidden:'hidden'},'the workflow opens full screen, the setup steps aside');
    await page.evaluate(()=>closeDomains({name:'acme.com',address:'',state:'verify'}));
    await page.getByText('Finish connecting acme.com').waitFor();
    assert.equal(await page.evaluate(()=>calls.some(c=>c.action==='comms.setup.start')),false,'an unverified domain turns nothing on');
    await page.getByRole('button',{name:/^Use my domain/}).click();
    await page.waitForFunction(()=>opens.length===2);
    assert.equal(await page.evaluate(()=>opens[1].domain),'acme.com','picks up the domain already started');
    await page.evaluate(()=>closeDomains({name:'acme.com',address:'info@acme.com',state:'records'}));
    await page.locator('[data-gxc-address]',{hasText:'info@acme.com'}).waitFor();
    await page.getByText('Sends from acme@firstmatemail.com until its email records are set up.').waitFor();
    assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.action==='comms.setup.start').map(c=>c.input.channel)),['email']);
    assert.equal(await page.locator('.gxs').evaluate(sheet=>getComputedStyle(sheet).visibility),'visible');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// FM-513: the Domains workflow for email (settings/domains.js openForEmail): no path choice and no website; your domain,
// its TXT record, the name before the @, done; it resolves when it closes, and picks up a domain already started.
test('Domains workflow for email: domain, TXT record, address, no website',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://comms-setup.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
      return route.fulfill({contentType:'text/html',body:'<main></main>'});
    });
    await page.goto('https://comms-setup.test/');
    await page.evaluate(()=>{
      window.calls=[];const registration={domain:'acme.com',acquisition_type:'existing',status:'dns_verification_pending',verification:{host:'_firstmate-verification.acme.com',value:'token-1'}};
      window.DomainsAPI={config:async()=>({configured:false}),list:async()=>({domains:window.listed||[]}),
        connect:async(org,domain)=>{calls.push(['connect',domain]);return {registration};},
        checkVerification:async()=>{calls.push(['check']);return {registration:{...registration,status:'ready_to_connect',verified_at:'2026-11-16T00:00:00Z'}};},
        attachResources:async(org,domain,body)=>{calls.push(['attach',domain,body]);return {registration:{...registration,status:'active',default_email:'office@acme.com'},website_id:''};}};
      window.WebsitesAPI={sites:{list:async()=>{calls.push(['websites']);return {sites:[]};}}};
    });
    await page.addScriptTag({url:'/libraries/setup-wizard/setup-wizard.js'});
    await page.addScriptTag({url:'/libraries/apps/settings/domains.js'});
    await page.evaluate(()=>{window.closed=FirstMateDomainsSettings.openForEmail({orgId:'org-test',path:'existing'}).then(value=>{window.result=value;});});
    const wizard=page.locator('.fm-wizard');
    await wizard.locator('input[name="domain"]').fill('acme.com');
    assert.equal(await wizard.getByText('Choose a path').count(),0,'no path choice');
    await wizard.getByRole('button',{name:/Continue/}).click();
    await wizard.locator('[data-attest]').check();
    await wizard.getByRole('button',{name:/Create connection/}).click();
    await wizard.getByText('_firstmate-verification.acme.com').first().waitFor();
    await wizard.getByRole('button',{name:/Check/}).click();
    await wizard.getByText('Verification complete').waitFor();
    await wizard.getByRole('button',{name:/Continue/}).click();
    await wizard.locator('input[name="default_email_local_part"]').fill('office');
    assert.equal(await wizard.getByText('Choose a website').count(),0,'no website');
    await wizard.getByRole('button',{name:/Continue/}).click();
    await wizard.getByText('office@acme.com').first().waitFor();
    await wizard.getByRole('button',{name:'Done'}).click();
    await page.waitForFunction(()=>window.result);
    assert.deepEqual(await page.evaluate(()=>calls),[['connect','acme.com'],['check'],['attach','acme.com',{website:{mode:'none'},default_email_local_part:'office'}]]);
    assert.equal(await page.evaluate(()=>result.registration.default_email),'office@acme.com');
    // Started before: it opens on the TXT record for that domain.
    await page.evaluate(()=>{window.listed=[{domain:'acme.com',acquisition_type:'existing',status:'dns_verification_pending',verification:{host:'_firstmate-verification.acme.com',value:'token-1'}}];window.result=null;FirstMateDomainsSettings.openForEmail({orgId:'org-test',path:'existing',domain:'acme.com'}).then(value=>{window.result=value;});});
    await page.locator('.fm-wizard').getByText('token-1').first().waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
