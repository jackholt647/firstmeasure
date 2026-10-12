import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Exercise the real settings renderers and shared shell without placing paid
// orders or sending a carrier registration from the development account.
const source = await readFile(process.env.SMS_COMPANY_SOURCE || new URL('../../libraries/apps/settings/company.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('    const smsDefaults ='), source.indexOf('    async function renderSmsSettings()'));
const wizard = source.slice(source.indexOf('    function openSmsWizard('), source.indexOf('    function renderPricebook()'));
const styles = source.slice(source.indexOf('      .sms-card{'), source.indexOf('      .li-subtabs{'));
const shell = await readFile(new URL('../../libraries/setup-wizard/setup-wizard.js', import.meta.url), 'utf8');
const fixture = {
  id:'fixture', status:'draft', brand_status:'verified',
  provider_refs:{telnyx_brand_id:'brand-fixture',telnyx_number_order_id:'order-fixture'},
  brand:{displayName:'FirstMate',companyName:'First Mate LLC',ein:'123456789',website:'https://example.com',email:'support@example.com',phone:'+12065515546',street:'707 South Grady Way',city:'Renton',state:'WA',postalCode:'98057'},
  campaign:{enabledFeatures:['crm_conversations','operations'],featuresConfirmed:true,optInMethod:'VERBAL',
    optInDisclosure:'FirstMate sends SMS text messages. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. SMS opt-in data is not shared with third parties for marketing.',
    messageFlow:'Our staff read the consent script to customers, record their agreement, and retain a record before sending SMS.',
    privacyPolicyLink:'https://example.com/privacy',termsAndConditionsLink:'https://example.com/terms',policyContentConfirmed:true,messageFlowConfirmed:true,consentAcknowledged:true,selectedNumber:'+12068447657'}
};

test('SMS setup: editable campaign after verification, actionable errors, safe submission, and mobile layout', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:960}});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.setContent('<style>body{font-family:Arial;margin:0;--primary:#e32b20}*{box-sizing:border-box}.cs-btn{border:1px solid #d0d5dd;background:white;color:#182230}.cs-btn.primary{background:#e32b20;color:white;border-color:#e32b20}.cs-btn:disabled{opacity:.5}</style>');
    await page.addScriptTag({content:shell});
    await page.addStyleTag({content:styles});
    await page.addScriptTag({content:`
      let smsRegistrationLiveMode=true; const state={}; const currentOrgId=()=> 'fixture-org';
      const normalizeOrganizationBusinessAddress=(v)=>v||{};
      const organizationBusinessAddressFromState=()=>({});
      const formatOrganizationBusinessAddress=()=>'';
      const formatPhoneUS=v=>v.replace(/(\\d{3})(\\d{3})(\\d{4})/,'($1) $2-$3');
      const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const readSettingsRoute=()=>({}); const writeSettingsRoute=()=>{};
      const showToast=()=>{}; const renderSmsSettings=()=>{};
      window.requests=[]; window.failSubmit=true; window.saved=${JSON.stringify(fixture)};
      const messagingRequest=async(path,options={})=>{
        window.requests.push({path,...options});
        if(options.method==='PATCH') window.saved={...window.saved,...structuredClone(options.body)};
        if(path.endsWith('/submit-campaign')) {
          await new Promise(r=>setTimeout(r,200));
          if(window.failSubmit) throw Error('Privacy policy must be publicly accessible before campaign submission.');
          window.saved={...window.saved,status:'submitted',campaign_status:'pending',provider_refs:{...window.saved.provider_refs,telnyx_campaign_id:'campaign-fixture'}};
        }
        return {profile:structuredClone(window.saved)};
      };
      ${helpers}
      ${wizard}
      window.start=(profile=window.saved,initialStep='summary')=>openSmsWizard(profile,{initialStep});
      window.issues=p=>smsStepIssues('summary',smsPrefillProfile(p));
      window.resume=p=>smsResumeStep(smsPrefillProfile(p));
    `});
    assert.deepEqual(await page.evaluate(()=>window.issues(window.saved)),[]);
    assert.equal(await page.evaluate(()=>window.resume({})), 'business');
    assert.equal(await page.evaluate(()=>window.resume({...window.saved,provider_refs:{},brand_status:'draft',campaign:{...window.saved.campaign,optInDisclosure:''}})), 'consent');
    await page.evaluate(()=>window.start());
    await page.getByRole('button',{name:'4. Customer consent'}).click();
    const disclosure=page.locator('[data-sms-field="campaign.optInDisclosure"]');
    assert.equal(await disclosure.isEnabled(),true);
    await disclosure.fill('Incomplete consent');
    await page.locator('#smsNext').click();
    await page.locator('[data-sms-step-errors]').getByRole('button',{name:/Consent script: name FirstMate/}).waitFor();
    await disclosure.fill(fixture.campaign.optInDisclosure);
    await page.locator('[data-sms-field="campaign.optInMethod"]').selectOption('WEBSITE_FORM');
    await page.locator('[data-sms-field="campaign.optInLocationUrl"]').waitFor();
    await page.locator('[data-sms-field="campaign.optInMethod"]').selectOption('VERBAL');
    assert.equal(await page.locator('[data-sms-field="campaign.optInLocationUrl"]').count(),0);
    assert.equal(await disclosure.inputValue(),fixture.campaign.optInDisclosure);
    await page.locator('#smsNext').click();
    await page.locator('[data-sms-field="campaign.sample1"]').waitFor();
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/messages-desktop.png'});
    await page.getByRole('button',{name:'1. Business'}).click();
    assert.equal(await page.locator('[data-sms-field="brand.companyName"]').isDisabled(),true);
    await page.getByRole('button',{name:'7. Review & submit'}).click();
    await page.locator('#smsContinueSetup').evaluate(el=>{el.click();el.click();});
    await page.locator('.sms-api-error').waitFor();
    assert.match(await page.locator('.sms-api-error').innerText(),/Privacy policy must be publicly accessible/);
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path.endsWith('/submit-campaign')).length),1);
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.method==='PATCH').every(r=>!('brand' in r.body))),true);
    await page.locator('.sms-api-error button').click();
    await disclosure.waitFor();
    assert.equal(await disclosure.inputValue(),fixture.campaign.optInDisclosure);
    if(process.env.SMS_SCREENSHOTS){await mkdir(process.env.SMS_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/consent-desktop.png'});}
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const pane=await page.locator('.fm-wizard-pane').boundingBox();
    assert.ok(pane.height>300 && pane.width<=390,JSON.stringify(pane));
    assert.equal(await page.locator('.fm-wizard-pane').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/consent-mobile.png'});
    await page.getByRole('button',{name:'7. Review & submit'}).click();
    await page.evaluate(()=>window.failSubmit=false);
    await page.locator('#smsContinueSetup').click();
    await page.getByText('Your campaign is under review',{exact:true}).waitFor();
    assert.equal(await page.locator('#smsContinueSetup').count(),0);
    if(process.env.SMS_SCREENSHOTS){await page.setViewportSize({width:1280,height:960});await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/review-desktop.png'});}
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});



test('registration landing page has one primary action, truthful states, and responsive layout', async () => {
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1150,height:850}});
    await page.route('https://sms-fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
    await page.goto('https://sms-fixture.test/');
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<style>body{font-family:Arial;margin:0;padding:32px;background:#fff;color:#182230}*{box-sizing:border-box}.cs-btn{border:1px solid #d0d5dd;background:white;color:#182230}.cs-btn.primary{background:#e32b20;border-color:#e32b20;color:white}@media(max-width:700px){body{padding:16px}}</style><main id="entry"></main>');
    await page.addStyleTag({content:styles});
    const registration=source.includes('    async function renderSmsRegistration(')
      ? source.slice(source.indexOf('    async function renderSmsRegistration('),source.indexOf('    function openSmsWizard(')).replace('renderSmsRegistration','renderEntry')
      : source.slice(source.indexOf('    async function renderSmsSettings('),source.indexOf('    function openSmsWizard(')).replaceAll('renderSmsSettings','renderEntry');
    await page.addScriptTag({content:`
      const paneSms=document.querySelector('#entry');const activeTab='sms';const state={};const canPlatformBilling=false;
      let smsRegistrationLiveMode=true;
      const currentOrgId=()=> 'fixture';const readSettingsRoute=()=>({});
      const normalizeOrganizationBusinessAddress=v=>v||{};const organizationBusinessAddressFromState=()=>({});const formatOrganizationBusinessAddress=()=>'';
      const formatPhoneUS=v=>v.replace(/(\\d{3})(\\d{3})(\\d{4})/,'($1) $2-$3');
      const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.setup={profiles:[],telnyx:{configured:true,registration_live:true}};
      const messagingRequest=async path=>path.endsWith('/sms/setup') ? window.setup : {profile:window.latestProfile || window.setup.profiles[0]};
      const openSmsWizard=(profile,options)=>window.opened={profile,options};
      ${helpers}
      ${registration}
      window.renderEntry=renderEntry;
    `});
    await page.evaluate(()=>window.renderEntry());
    await page.getByRole('button',{name:'Start registration'}).click();
    assert.equal(await page.evaluate(()=>window.opened.options.initialStep),'business');
    assert.equal(await page.getByText('What you’ll need',{exact:true}).count(),0);
    assert.equal(await page.locator('[data-open-sms-profile]').count(),0);
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/entry-new.png'});
    await page.evaluate(profile=>{window.setup.profiles=[profile];return window.renderEntry();},fixture);
    await page.getByRole('button',{name:'View full application'}).click();
    assert.equal(await page.evaluate(()=>window.opened.options.initialStep),'summary');
    assert.match(await page.locator('.sms-entry-facts').innerText(),/First Mate LLC/);
    assert.equal(await page.getByText('Messaging Profile',{exact:true}).count(),0);
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/entry-business-verified.png'});
    const campaign={...fixture,campaign_status:'pending',provider_refs:{...fixture.provider_refs,telnyx_campaign_id:'campaign'}};
    await page.evaluate(profile=>{window.setup.profiles=[profile];return window.renderEntry();},campaign);
    await page.getByRole('heading',{name:'Your campaign is under review'}).waitFor();
    await page.clock.install();
    await page.evaluate(profile=>{window.latestProfile={...profile,campaign_status:'mno_provisioned',status:'active',provider_refs:{...profile.provider_refs,telnyx_messaging_profile_id:'msg'},autoresponse_state:{status:'configured',desired_hash:'same',applied_hash:'same',messaging_profile_id:'msg'}};},campaign);
    await page.clock.runFor(30001);
    await page.getByRole('heading',{name:'Your business texting is ready'}).waitFor();
    await page.evaluate(profile=>{window.latestProfile=null;window.setup.profiles=[profile];return window.renderEntry();},campaign);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/entry-mobile.png',fullPage:true});
    await page.evaluate(profile=>{window.setup.profiles=[{...profile,campaign_status:'mno_rejected'}];return window.renderEntry();},campaign);
    await page.getByRole('heading',{name:'Your registration needs attention'}).waitFor();
    await page.evaluate(profile=>{window.setup.profiles=[{...profile,campaign_status:'mno_provisioned',status:'active',provider_refs:{...profile.provider_refs,telnyx_messaging_profile_id:'msg'},autoresponse_state:{status:'configured',desired_hash:'same',applied_hash:'same',messaging_profile_id:'msg'}}];return window.renderEntry();},campaign);
    await page.getByRole('heading',{name:'Your business texting is ready'}).waitFor();
    await page.evaluate(profile=>{window.setup.profiles=[profile];return window.renderEntry();},campaign);
    await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/settings/phone.js',import.meta.url),'utf8')});
    await page.evaluate(async()=>{
      window.fetch=async()=>new Response(JSON.stringify({can_manage:true,can_bill:false}),{status:200,headers:{'Content-Type':'application/json'}});
      const host=document.createElement('div');document.body.appendChild(host);
      await window.FirstMatePhoneSettings.mount(host,{orgId:'fixture',initialTab:'registration',registration:body=>body.appendChild(document.querySelector('#entry'))});
    });
    assert.equal(await page.getByRole('button',{name:'SMS registration',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).count(),0);
    assert.equal(await page.getByText('Your progress saves automatically.',{exact:true}).count(),0);
    if(process.env.SMS_SCREENSHOTS){await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/phone-registration-mobile.png',fullPage:true});await page.setViewportSize({width:1280,height:900});await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/phone-registration-desktop.png',fullPage:true});}
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});


test('automatic registration checks poll the provider, pause when hidden, back off, and discard stale results', async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage();await page.setContent('<div id="watch">Status</div>');
    await page.clock.install({time:new Date('2026-10-12T00:00:00Z')});
    await page.addScriptTag({content:`
      const currentOrgId=()=> 'fixture';
      window.current=${JSON.stringify({...fixture,phone_number_status:'success',campaign_status:'pending',provider_refs:{...fixture.provider_refs,telnyx_campaign_id:'campaign'}})};
      window.remote=structuredClone(window.current);window.requests=[];window.applied=0;window.fail=false;window.error='';
      const messagingRequest=async(path,options={})=>{
        window.requests.push({path,method:options.method||'GET'});
        if(window.fail)throw Error('Temporary provider outage');
        if(window.defer)await new Promise(resolve=>window.releaseRequest=resolve);
        return {profile:structuredClone(window.remote)};
      };
      ${helpers}
      window.begin=()=>smsWatchRegistrationStatus({root:document.querySelector('#watch'),getProfile:()=>window.current,
        onProfile:profile=>{window.current=profile;window.applied++;document.querySelector('#watch').textContent=profile.campaign_status;},onError:message=>window.error=message});
      window.stop=window.begin();
    `});
    await page.clock.runFor(1);
    await page.waitForFunction(()=>window.requests.length===2 && window.applied===1);
    assert.equal(await page.evaluate(()=>window.requests[1].method),'POST');
    await page.clock.runFor(30000);
    await page.waitForFunction(()=>window.requests.length===4);
    await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'}));
    await page.clock.runFor(60000);
    assert.equal(await page.evaluate(()=>window.requests.length),4);
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(()=>window.requests.length===6);
    await page.evaluate(()=>window.fail=true);
    await page.clock.runFor(30000);
    await page.waitForFunction(()=>window.error.includes('Retrying automatically'));
    const failedCount=await page.evaluate(()=>window.requests.length);
    await page.clock.runFor(30000);
    assert.equal(await page.evaluate(()=>window.requests.length),failedCount);
    await page.evaluate(()=>window.fail=false);
    await page.clock.runFor(30000);
    await page.waitForFunction(()=>window.error==='');
    await page.evaluate(()=>{window.defer=true;window.before=window.applied;});
    await page.clock.runFor(30000);
    await page.waitForFunction(()=>typeof window.releaseRequest==='function');
    await page.evaluate(()=>{window.current={...window.current,campaign:{...window.current.campaign,description:'New unsaved answer'}};window.defer=false;window.releaseRequest();});
    await page.clock.runFor(1);
    assert.equal(await page.evaluate(()=>window.applied),await page.evaluate(()=>window.before));
    assert.equal(await page.evaluate(()=>window.current.campaign.description),'New unsaved answer');
    await page.evaluate(()=>{window.remote={...window.remote,status:'active',campaign_status:'mno_provisioned',provider_refs:{...window.remote.provider_refs,telnyx_messaging_profile_id:'msg'},autoresponse_state:{status:'configured',messaging_profile_id:'msg',desired_hash:'same',applied_hash:'same'}};});
    await page.clock.runFor(30000);
    await page.waitForFunction(()=>window.current.status==='active');
    const posts=await page.evaluate(()=>window.requests.filter(r=>r.method==='POST').length);
    await page.clock.runFor(30000);
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.method==='POST').length),posts);
    await page.evaluate(()=>document.querySelector('#watch').remove());
    const finalCount=await page.evaluate(()=>window.requests.length);
    await page.clock.runFor(60000);
    assert.equal(await page.evaluate(()=>window.requests.length),finalCount);
  } finally {await browser.close();}
});
