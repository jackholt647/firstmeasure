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
      window.DomainsAPI={config:async()=>({configured:true,encryption_configured:true,billing_enabled:true})};
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
    await page.getByRole('button',{name:/^Business phone/}).click();
    await page.waitForFunction(()=>calls.some(c=>c.action==='registration.open'));
    assert.deepEqual(await page.evaluate(()=>calls.map(c=>c.action)),['comms.setup.status','comms.setup.start','registration.open']);
    assert.equal(await page.getByText('Turn on texts and calls').count(),0);
    assert.equal(await page.evaluate(()=>calls.find(c=>c.action==='registration.open').input.container===document.querySelector('#step')),true,'registration is drawn in the setup\'s own step (GP-138)');
    await page.evaluate(()=>submitRegistration());
    // GP-7: registration submitted, the setup goes on to what is left: email. Back is the done page.
    await page.getByRole('button',{name:/^FirstMate Mail/}).waitFor();
    assert.equal(await page.evaluate(()=>completed),0);
    await page.getByRole('button',{name:'Back'}).click();
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
    // FM-590: FirstMate Mail first (the default), then your own domain, both free; then buying one, which is paid.
    for(const name of [/^FirstMate Mail/,/^Use your own domain/,/^Buy a domain through FirstMate/])await page.getByRole('button',{name}).waitFor();
    assert.deepEqual(await page.locator('[data-gxc-email-way]').evaluateAll(cards=>cards.map(card=>card.dataset.gxcEmailWay+':'+(card.querySelector('.gxc-tag')?.textContent||'')+(card.hasAttribute('data-first')?':default':''))),['firstmate:Free:default','existing:Free','register:Paid']);
    await page.getByText('FirstMate Mail and your own domain are free. A domain bought through FirstMate is billed every year, with privacy included free.').waitFor();
    assert.equal(await page.evaluate(()=>calls.length),before,'choosing email turns nothing on');
    assert.equal(await page.getByText('Search for a name and see its yearly price').count(),1,'domains can be bought where the registry and billing are set up');
    await page.getByRole('button',{name:/^FirstMate Mail/}).click();
    await page.locator('[data-gxc-address]',{hasText:'acme@mail.test'}).waitFor();
    assert.equal(await page.getByText('Ready on +12025550100.').count(),1,'email is turned on in the same page');
    await page.getByRole('button',{name:'Go to Communications'}).click();
    await page.waitForFunction(()=>completed===1);
    const calls=await page.evaluate(()=>calls);
    assert.deepEqual(calls.filter(c=>c.action==='comms.setup.start').map(c=>c.input.channel),['phone','phone','email'],'phone again after registration reads where it stands');
    assert.equal(calls.filter(c=>c.action==='domains.open').length,0);
    assert.ok(calls.filter(c=>c.action==='comms.setup.start').every(c=>c.options.idempotencyKey&&c.target.scope==='organization'));
    assert.equal(calls.find(c=>c.action==='registration.open').input.orgId,'org-test');
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

// GP-7: with email already on, submitting registration is the last thing: the setup finishes and closes, and
// Communications shows texts and calls pending approval.
test('Communications setup: submitting registration with email on finishes the setup',async()=>{
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
      window.__APP={userOrgId:'org-test'};window.registration='draft';
      const status={phone:{texts:false,registration:'none'},email:{on:true,address:'acme@mail.test'},done:{phone:false,email:true}};
      window.PlatformAPI={baseUrl:()=>'/v1/platform',publication:{invoke:async(org,action,target,input)=>{if(action==='comms.setup.start'&&input.channel==='phone'){status.phone={texts:true,registration};status.done.phone=true;}return {value:structuredClone(status)};}}};
      window.FirstMatePlatformBilling={isEnabled:()=>false};
      window.FirstMateSetupWizard={open(){}};
      window.FirstMateSmsRegistration={open:()=>new Promise(resolve=>{window.submitRegistration=()=>{registration='submitted';resolve({id:'profile'});};})};
    });
    await page.evaluate(async()=>{
      const module=await import('/libraries/guided-experiences/comms-setup.js');
      window.completed=0;
      module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:(key,fallback)=>fallback,esc:value=>String(value??''),change(){},complete:async()=>{completed++;}});
    });
    await page.getByRole('button',{name:/^Business phone/}).click();
    await page.waitForFunction(()=>typeof window.submitRegistration==='function');
    await page.evaluate(()=>submitRegistration());
    await page.waitForFunction(()=>completed===1);
    assert.equal(await page.getByRole('button',{name:/^FirstMate Mail/}).count(),0,'no email page: email is already on');
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

// FM-586: each channel's tooltip sits over its own card (not across the row, not over the choices below), no wider
// than a tooltip, inside the row on a phone; texts and calls say "On" only once carrier registration is approved.
test('Communications setup: channel tooltips over their own card, and where registration stands',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:960,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://comms-setup.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
      return route.fulfill({contentType:'text/html',body:'<div class="gxs"><div class="gxs-step" style="position:absolute;inset:0;overflow:auto;padding:8px 16px"><div class="gxs-titlebar"><h2 style="margin:4px 0 12px;font-size:22px">Talk to your customers from FirstMate</h2></div><main id="step"></main></div></div>'});
    });
    await page.goto('https://comms-setup.test/');
    const mount=(registration)=>page.evaluate(async(registration)=>{
      window.__APP={userOrgId:'org-test'};
      const status={phone:{texts:true,registration},email:{on:true,address:'acme@mail.test'},done:{phone:true,email:true}};
      window.PlatformAPI={baseUrl:()=>'/v1/platform',publication:{invoke:async()=>({value:structuredClone(status)})}};
      window.handle?.destroy?.();
      const module=await import('/libraries/guided-experiences/comms-setup.js');
      window.handle=module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:(key,fallback)=>fallback,esc:value=>String(value??''),change(){},setTitle(){},complete:async()=>{}});
    },registration);
    const states=async()=>{await page.locator('.gxc-way').first().waitFor();return page.locator('.gxc-way').evaluateAll(ways=>ways.map(way=>way.querySelector('.gxc-way-on')?.textContent||''));};
    const choice=(id)=>page.locator(`[data-gxc-start="${id}"] small`).textContent();
    for(const [registration,label] of [['none','Needs review'],['draft','Needs review'],['submitted','Awaiting approval'],['attention','Needs attention'],['approved','On']]){
      await mount(registration);
      assert.deepEqual(await states(),[label,label,'On'],registration);
      assert.equal(await choice('phone'),label==='On'?'On · review':label,registration);
    }
    const hover=async(id)=>{
      const way=page.locator(`[data-gxc-way="${id}"]`);
      await way.hover();
      await page.waitForFunction(id=>getComputedStyle(document.querySelector('#gxc-tip-'+id)).opacity==='1',id);
      return page.evaluate(id=>{const box=(el)=>el.getBoundingClientRect(),tip=box(document.querySelector('#gxc-tip-'+id)),card=box(document.querySelector(`[data-gxc-way="${id}"]`)),row=box(document.querySelector('.gxc-ways')),label=box(document.querySelector('.gxc-label'));return {tip,card,row,label};},id);
    };
    for(const [width,height] of [[960,900],[390,844]]){
      await page.setViewportSize({width,height});
      for(const id of ['texts','calls','email']){
        const {tip,card,row,label}=await hover(id);
        assert.ok(tip.width<=(width<640?width-30:282),`${id} at ${width}: no wider than a tooltip (${tip.width})`);
        assert.ok(tip.width<row.width-1||width<640,`${id} at ${width}: not across the whole row`);
        assert.ok(tip.left>=row.left-1&&tip.right<=row.right+1,`${id} at ${width}: inside the row`);
        assert.ok(tip.left<card.left+card.width/2&&tip.right>card.left+card.width/2,`${id} at ${width}: over its own card`);
        assert.ok(tip.bottom<=card.top,`${id} at ${width}: above its card`);
        assert.ok(tip.bottom<=label.top,`${id} at ${width}: not over "Where do you want to start?"`);
        await page.mouse.move(1,height-1);
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// FM-513: email from an Overview button opens the choice, not FirstMate Mail. "Use your own domain" runs the Domains workflow
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
    await page.getByRole('button',{name:/^Use your own domain/}).click();
    await page.waitForFunction(()=>opens.length===1);
    assert.deepEqual(await page.evaluate(()=>opens[0]),{orgId:'org-test',path:'existing',domain:'',hidden:'hidden'},'the workflow opens full screen, the setup steps aside');
    await page.evaluate(()=>closeDomains({name:'acme.com',address:'',state:'verify'}));
    await page.getByText('Finish connecting acme.com').waitFor();
    assert.equal(await page.evaluate(()=>calls.some(c=>c.action==='comms.setup.start')),false,'an unverified domain turns nothing on');
    await page.getByRole('button',{name:/^Use your own domain/}).click();
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
    // On a phone the workflow fits the screen: no wider than it, the record and the buttons in view, the step rail one short row.
    assert.ok(await wizard.evaluate(node=>node.scrollWidth<=innerWidth&&node.querySelector('.fm-wizard-head').getBoundingClientRect().right<=innerWidth+1),'the workflow is no wider than the phone');
    assert.ok(await wizard.getByText('token-1').evaluate(node=>node.getBoundingClientRect().right<=innerWidth));
    assert.ok(await wizard.getByRole('button',{name:/Check/}).evaluate(node=>{const r=node.getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight;}));
    assert.ok(await wizard.locator('.fm-wizard-rail').evaluate(node=>node.getBoundingClientRect().height<120),'the step rail is one short row');
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

// FM-590: buying domains: a name is tried on .com, .net and .co, two go in the cart, the registrant, then one payment on
// Stripe's page (a new tab, so the workflow stays); once the payment is in, the domains are registered and it moves on.
test('Domains workflow: buy a cart of domains with one payment',async()=>{
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
      window.calls=[];let checkout=null;
      window.open=(url)=>{calls.push(['open',url]);return {closed:false,close(){},location:{set href(value){calls.push(['tab',value]);}}};};
      window.DomainsAPI={config:async()=>({configured:true,encryption_configured:true,billing_enabled:true,order_test_mode:true}),list:async()=>({domains:window.listed||[]}),
        quote:async(org,domains)=>{calls.push(['quote',domains]);return {quote:{id:'quote-1',items:domains.map((domain,index)=>index===1?{domain,available:false,reason:'Already registered'}:{domain,available:true,price:'25.00',renewal_price:'25.00',privacy_price:'0.00'})}};},
        checkout:async(org,body)=>{calls.push(['checkout',body]);checkout={id:'checkout-1',status:'open',url:'https://checkout.stripe.test/pay',total:body.accept_total,items:body.items.map(item=>({domain:item.domain,price:'25.00',status:''}))};return {checkout};},
        refreshCheckout:async()=>{calls.push(['refresh']);
          if(window.paid){checkout={...checkout,status:'fulfilled',url:'',items:checkout.items.map(item=>({...item,status:'registered'}))};window.listed=checkout.items.map(item=>({domain:item.domain,acquisition_type:'register',status:'verification_pending',simulated:true}));}
          return {checkout};}};
      window.WebsitesAPI={sites:{list:async()=>({sites:[]})}};
    });
    await page.addScriptTag({url:'/libraries/setup-wizard/setup-wizard.js'});
    await page.addScriptTag({url:'/libraries/apps/settings/domains.js'});
    await page.evaluate(()=>{FirstMateDomainsSettings.openForEmail({orgId:'org-test',path:'register'});});
    const wizard=page.locator('.fm-wizard');
    await wizard.locator('input[name="domain"]').fill('Acme Roofing');
    await wizard.locator('[data-search] button[type="submit"]').click();
    await wizard.locator('[data-cart-toggle="acmeroofing.com"]').click();
    await wizard.locator('[data-cart-toggle="acmeroofing.co"]').click();
    assert.equal(await wizard.locator('[data-cart-toggle="acmeroofing.net"]').count(),0,'a taken name cannot be added');
    await wizard.locator('[data-cart]').getByText('$50.00').waitFor();
    assert.deepEqual(await page.evaluate(()=>calls[0]),['quote',['acmeroofing.com','acmeroofing.net','acmeroofing.co']]);
    assert.ok(await wizard.evaluate(node=>node.scrollWidth<=innerWidth),'the cart fits the phone');
    await wizard.getByRole('button',{name:/Continue/}).click();
    for(const [name,value] of Object.entries({first_name:'Ada',last_name:'Owner',address1:'1 Main St',city:'Seattle',state:'WA',postal_code:'98101',country:'US',phone:'+12065550100',email:'ada@example.test'}))await wizard.locator(`input[name="${name}"]`).fill(value);
    await wizard.getByRole('button',{name:/Continue/}).click();
    await wizard.getByText('Privacy').waitFor();
    await wizard.getByText('Test mode.').waitFor();
    await wizard.locator('[data-attest]').check();
    await wizard.getByRole('button',{name:/Pay \$50\.00/}).click();
    await wizard.locator('[data-pay-waiting]').waitFor();
    const started=await page.evaluate(()=>calls.filter(call=>call[0]!=='refresh'));
    assert.deepEqual(started.slice(1).map(call=>call[0]),['open','checkout','tab']);
    assert.deepEqual(started[2][1],{items:[{quote_id:'quote-1',domain:'acmeroofing.com'},{quote_id:'quote-1',domain:'acmeroofing.co'}],contact:{first_name:'Ada',last_name:'Owner',org_name:'',address1:'1 Main St',address2:'',city:'Seattle',state:'WA',postal_code:'98101',country:'US',phone:'+12065550100',email:'ada@example.test'},accept_total:'50.00',attestation:true,allow_premium:false});
    assert.equal(started[3][1],'https://checkout.stripe.test/pay','the new tab goes to Stripe');
    await page.evaluate(()=>{window.paid=true;});
    await wizard.getByRole('button',{name:'Check payment'}).click();
    await wizard.locator('[data-purchased]').getByText('acmeroofing.com, acmeroofing.co are yours').waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// GP-147: the Call center's own setup (comms.call_center_setup, `only: 'phone'`): its start explains carrier registration
// (10DLC) with one button into the same registration, no email, and it finishes once registration is submitted. Opened where the phone is already set up,
// it says so. Communications opened where the phone is set up and email is not: "Your phones are already set up", email
// next, or skip it (the setup finishes, and its tour follows).
async function phoneOnlyPage(browser,{status,options}){
  const page=await browser.newPage({viewport:{width:960,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://comms-setup.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
    return route.fulfill({contentType:'text/html',body:'<div class="gxs"><main id="step"></main></div>'});
  });
  await page.goto('https://comms-setup.test/');
  await page.evaluate(({status,options})=>{
    window.__APP={userOrgId:'org-test'};window.calls=[];window.registration='none';window.completed=0;window.changes=[];
    window.PlatformAPI={baseUrl:()=>'/v1/platform',publication:{invoke:async(org,action,target,input)=>{calls.push({action,input});
      if(action==='comms.setup.start'){if(input.channel==='phone'){status.phone={texts:true,registration};status.done.phone=true;}else{status.email={on:true,address:'acme@mail.test'};status.done.email=true;}}
      return {value:structuredClone(status)};}}};
    window.FirstMatePlatformBilling={isEnabled:()=>false};
    window.FirstMateSetupWizard={open(){}};
    window.FirstMateSmsRegistration={open:()=>new Promise(resolve=>{calls.push({action:'registration.open'});window.submitRegistration=()=>{registration='submitted';resolve({id:'profile'});};})};
    window.DomainsAPI={config:async()=>({configured:false})};
    window.__options=options;
  },{status,options});
  await page.evaluate(async()=>{
    const module=await import('/libraries/guided-experiences/comms-setup.js');
    module.mount(document.querySelector('#step'),{options:window.__options,orgId:'org-test',L:(key,fallback)=>fallback,esc:value=>String(value??''),change(value){changes.push(value);},setTitle(){},complete:async()=>{completed++;}});
  });
  return {page,errors};
}
const none=()=>({phone:{texts:false,registration:'none'},email:{on:false,address:''},done:{phone:false,email:false}});

test('Call center setup: texts and calls without email, registration, finished once submitted',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await phoneOnlyPage(browser,{status:none(),options:{only:'phone',finish:'Go to the Call center'}});
    // Nothing to choose: the start says what carrier registration is and how it goes, and one button starts it.
    await page.locator('[data-gxc-register]').waitFor();
    await page.getByText('This is called 10DLC registration.',{exact:false}).waitFor();
    assert.deepEqual(await page.locator('.gxc-steps strong').allTextContents(),['Tell us about your business','Carriers review it','Text and call customers']);
    assert.equal(await page.locator('[data-gxc-way]').count(),0,'no channel cards');
    assert.equal(await page.getByText(/email/i).count(),0,'no email anywhere');
    assert.equal(await page.locator('.gxc-choice').count(),0,'nothing that looks like a choice');
    await page.getByRole('button',{name:'Register for texting'}).click();
    await page.waitForFunction(()=>typeof window.submitRegistration==='function');
    await page.evaluate(()=>submitRegistration());
    await page.waitForFunction(()=>completed===1);
    assert.equal(await page.getByRole('button',{name:/^FirstMate Mail/}).count(),0,'no email page after registration');
    assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.action==='comms.setup.start').map(c=>c.input.channel)),['phone','phone'],'email is never turned on');
    assert.deepEqual(errors,[]);
    await page.close();
    // A registration already started is continued from the same button.
    const draft=await phoneOnlyPage(browser,{status:{phone:{texts:true,registration:'draft'},email:{on:false,address:''},done:{phone:true,email:false}},options:{only:'phone'}});
    await draft.page.getByRole('button',{name:'Continue registration'}).waitFor();
    await draft.page.close();
    // Already set up (in Communications or Phone Settings): the done page says so, phone only, and goes to the Call center.
    const ready=await phoneOnlyPage(browser,{status:{phone:{texts:true,calls:true,numbers:['+12025550100'],registration:'approved'},email:{on:false,address:''},done:{phone:true,email:false}},options:{only:'phone',finish:'Go to the Call center'}});
    await ready.page.getByText('Ready on +12025550100.').waitFor();
    assert.equal(await ready.page.getByText('Add email').count(),0,'email is not offered');
    await ready.page.getByRole('button',{name:'Go to the Call center'}).click();
    await ready.page.waitForFunction(()=>completed===1);
    assert.deepEqual(await ready.page.evaluate(()=>calls.map(c=>c.action)),['comms.setup.status'],'nothing is turned on');
    assert.deepEqual(ready.errors,[]);
  }finally{await browser.close();}
});

test('Communications setup: phones already set up, email next or skip it',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const phonesSet=()=>({phone:{texts:true,calls:false,registration:'submitted'},email:{on:false,address:''},done:{phone:true,email:false}});
  try{
    const {page,errors}=await phoneOnlyPage(browser,{status:phonesSet(),options:{}});
    await page.locator('[data-gxc-phones-ready]').waitFor();
    await page.getByText('Let’s set up your email next, or skip it and use Communications with texts and calls.').waitFor();
    assert.deepEqual(await page.locator('[data-gxc-way] .gxc-way-on').allTextContents(),['Awaiting approval','Awaiting approval'],'texts and calls say where they stand');
    // Email next: the email page, and Back returns here.
    await page.getByRole('button',{name:/^Set up your email/}).click();
    await page.getByRole('button',{name:/^FirstMate Mail/}).waitFor();
    await page.getByRole('button',{name:'Back'}).click();
    await page.locator('[data-gxc-phones-ready]').waitFor();
    await page.getByRole('button',{name:/^Set up your email/}).click();
    await page.getByRole('button',{name:/^FirstMate Mail/}).click();
    await page.locator('[data-gxc-address]',{hasText:'acme@mail.test'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.action==='comms.setup.start').map(c=>c.input.channel)),['email']);
    assert.deepEqual(errors,[]);
    await page.close();
    // Skip: Communications with texts and calls; the setup finishes (its tour follows) and nothing is turned on.
    const skip=await phoneOnlyPage(browser,{status:phonesSet(),options:{}});
    await skip.page.getByRole('button',{name:'Skip, use texts and calls'}).click();
    await skip.page.waitForFunction(()=>completed===1);
    assert.deepEqual(await skip.page.evaluate(()=>calls.map(c=>c.action)),['comms.setup.status']);
    assert.deepEqual(skip.errors,[]);
    await skip.page.close();
    // Phone on but registration not submitted: not "set up", so the usual start.
    const draft=await phoneOnlyPage(browser,{status:{...phonesSet(),phone:{texts:true,registration:'draft'}},options:{}});
    await draft.page.getByText('Where do you want to start?').waitFor();
    assert.equal(await draft.page.locator('[data-gxc-phones-ready]').count(),0);
    assert.deepEqual(draft.errors,[]);
  }finally{await browser.close();}
});
