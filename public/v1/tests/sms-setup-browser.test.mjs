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
  campaign:{description:'FirstMate uses SMS for customer conversations and appointment updates after customers opt in.',enabledFeatures:['crm_conversations','operations'],featuresConfirmed:false,optInMethod:'VERBAL',
    sample1:'FirstMate: Thanks for contacting us. How can we help? Reply STOP to opt out.',
    sample2:'FirstMate: Your appointment is tomorrow at 10 AM. Reply STOP to opt out.',
    optInDisclosure:'FirstMate sends SMS text messages. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. SMS opt-in data is not shared with third parties for marketing.',
    messageFlow:'Our staff read the consent script to customers, record their agreement, and retain a record before sending SMS.',
    privacyPolicyLink:'https://example.com/privacy',termsAndConditionsLink:'https://example.com/terms',policyContentConfirmed:true,messageFlowConfirmed:true,selectedNumber:'+12068447657'}
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
    await page.getByRole('button',{name:'3. Messages & consent'}).click();
    const disclosure=page.locator('[data-sms-field="campaign.optInDisclosure"]');
    assert.equal(await disclosure.isEnabled(),true);
    await disclosure.fill('Incomplete consent');
    await page.locator('#smsNext').click();
    await page.locator('[data-sms-step-errors]').getByRole('button',{name:/Consent script: name FirstMate/}).waitFor();
    await disclosure.fill(fixture.campaign.optInDisclosure);
    await page.locator('[data-sms-method="WEBSITE_FORM"]').check();
    await page.locator('[data-sms-field="campaign.optInLocationUrl"]').waitFor();
    assert.equal(await page.locator('.sms-signup-card li').count(),5);
    assert.equal(await page.locator('.sms-signup-card>p').last().innerText(),'Marketing consent must be explicit and not required to purchase.');
    assert.equal(await page.locator('.sms-signup-card').getByText('Your SMS signup form must include:').count(),1);
    await page.locator('[data-sms-method="WEBSITE_FORM"]').uncheck();
    assert.equal(await page.locator('[data-sms-field="campaign.optInLocationUrl"]').count(),0);
    assert.equal(await disclosure.inputValue(),fixture.campaign.optInDisclosure);
    await page.locator('#smsNext').click();
    await page.locator('[data-sms-field="campaign.sample1"]').waitFor();
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/messages-desktop.png'});
    await page.getByRole('button',{name:'1. Business'}).click();
    assert.equal(await page.locator('[data-sms-field="brand.companyName"]').isDisabled(),true);
    await page.getByRole('button',{name:'6. Review & submit'}).click();
    assert.equal(await page.locator('[data-sms-consent-ack]').count(),0);
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
    await page.getByRole('button',{name:'6. Review & submit'}).click();
    await page.evaluate(()=>window.failSubmit=false);
    await page.locator('#smsRetrySubmission').click();
    await page.getByText(/Your SMS registration is under review/).waitFor();
    assert.equal(await page.locator('#smsContinueSetup').count(),0);
    assert.equal(await page.locator('.sms-final-features, .sms-review-actions').count(),0);
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
    await page.clock.install();
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

test('business identity switches paths, formats EIN and website, and preserves unit and brand choices', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<style>body{font-family:Arial;margin:0}*{box-sizing:border-box}</style>');
    await page.addScriptTag({content:shell});await page.addStyleTag({content:styles});
    await page.addScriptTag({content:`
      let smsRegistrationLiveMode=true;const state={};const currentOrgId=()=> 'fixture-org';
      const normalizeOrganizationBusinessAddress=v=>v||{};const organizationBusinessAddressFromState=()=>({});const formatOrganizationBusinessAddress=()=>'';
      const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const formatPhoneUS=v=>v;const readSettingsRoute=()=>({});const writeSettingsRoute=()=>{};const showToast=()=>{};const renderSmsSettings=()=>{};
      window.saved=${JSON.stringify({...fixture,brand_status:'draft',provider_refs:{},campaign:{...fixture.campaign,description:'',selectedNumber:'',sample1:'',sample2:''}})};
      window.requests=[];
      const messagingRequest=async(path,options={})=>{
        window.requests.push({path,...options});
        if(options.method==='PATCH')window.saved={...window.saved,...structuredClone(options.body)};
        if(path.includes('/available-numbers')){if(window.deferSearch)await new Promise(resolve=>window.releaseSearch=resolve);return {numbers:[{phone_number:'+12065550101',locality:'Seattle',region:'WA',monthly_cost:'1.00'},{phone_number:'+12065550102',locality:'Seattle',region:'WA',monthly_cost:'1.00'}]};}
        if(path.endsWith('/select-number'))window.saved={...window.saved,campaign:{...window.saved.campaign,selectedNumber:options.body.phone_number}};
        if(path.endsWith('/add-number'))window.saved={...window.saved,provider_refs:{...window.saved.provider_refs,additional_numbers:[...(window.saved.provider_refs.additional_numbers||[]),{phone_number:options.body.phone_number,status:'pending',assignment_status:'pending'}]}};
        if(path.endsWith('/evidence'))return {url:window.longEvidenceUrl ? 'https://example.com/'+'x'.repeat(2000) : 'https://example.com/'+options.body.file_name};
        return {profile:structuredClone(window.saved)};
      };
      ${helpers}
      ${wizard}
      window.start=()=>openSmsWizard(window.saved,{initialStep:'business'});
      window.usecase=brand=>smsGeneratedCampaign(mergeSmsProfile({brand})).usecase;
      window.fieldState=smsFieldLiveState;window.generated=smsGeneratedCampaign;window.stepState=smsStepStatus;
      window.einValid=smsValidEin; window.defaultFeatures=()=>smsSelectedFeatures(mergeSmsProfile({}));
    `});
    await page.evaluate(()=>window.start());
    assert.equal(await page.locator('[data-sms-field]').first().getAttribute('data-sms-field'),'brand.entityType');
    assert.equal(await page.locator('[data-sms-field="campaign.description"]').count(),1);
    assert.equal(await page.locator('[data-sms-field="campaign.description"]').getAttribute('maxlength'),'600');
    assert.equal(await page.locator('[data-sms-field="campaign.description"]').inputValue(),'');
    assert.equal(await page.getByText('See an example campaign description',{exact:true}).count(),1);
    const copy=await page.evaluate(()=>window.generated({brand:{displayName:'x'.repeat(75)},campaign:{enabledFeatures:['crm_conversations','operations','customer_growth']}}).optinMessage);
    assert.match(copy,/Subscribed to customer care, updates, marketing texts/);assert.match(copy,/Consent is not a condition of purchase/);assert.ok(copy.length<=255);
    const frozen=await page.evaluate(()=>window.generated({provider_refs:{telnyx_campaign_id:'submitted'},campaign:{optinMessage:'Already registered reply'}}).optinMessage);assert.equal(frozen,'Already registered reply');
    assert.equal(await page.evaluate(()=>window.stepState({id:'number',note:'Sending line'},4,0,{campaign:{}}).label),'');
    assert.equal(await page.locator('[data-sms-field="brand.vertical"] option').count(),23);
    assert.equal(await page.locator('[data-sms-field="brand.vertical"] option[value="PROFESSIONAL"]').innerText(),'Professional services');
    const ein=page.locator('[data-sms-field="brand.ein"]');
    await ein.fill('123456789012');assert.equal(await ein.inputValue(),'12-3456789012');
    assert.match(await page.locator('#sms-brand-ein-help').innerText(),/9 digits.*12/);
    await ein.fill('123456789');assert.equal(await ein.inputValue(),'12-3456789');
    assert.equal(await ein.getAttribute('aria-invalid'),'false');
    assert.equal(await page.evaluate(()=>window.einValid('*****6789')),true);
    const website=page.locator('[data-sms-field="brand.website"]');await website.fill('example.com');await website.blur();
    assert.equal(await website.inputValue(),'https://example.com');
    assert.equal(await page.locator('#sms-brand-website-help').innerText(),'');
    await page.locator('[data-sms-field="brand.sameAsLegalName"]').check();
    await page.locator('[data-sms-field="brand.companyName"]').fill('Updated Legal LLC');
    assert.equal(await page.locator('[data-sms-field="brand.displayName"]').inputValue(),'Updated Legal LLC');
    assert.equal(await page.locator('[data-sms-field="brand.displayName"]').isDisabled(),true);
    await page.locator('[data-sms-field="brand.entityType"]').selectOption('SOLE_PROPRIETOR');
    assert.equal(await ein.count(),0);assert.equal(await page.locator('[data-sms-field="brand.companyName"]').count(),0);
    await page.locator('[data-sms-field="brand.firstName"]').fill('Jane');await page.locator('[data-sms-field="brand.lastName"]').fill('Smith');
    assert.equal(await page.locator('[data-sms-field="brand.displayName"]').inputValue(),'Jane Smith');
    assert.equal(await page.evaluate(()=>window.usecase({entityType:'SOLE_PROPRIETOR'})),'SOLE_PROPRIETOR');
    await page.getByRole('button',{name:'2. Contact'}).click();
    await page.locator('[data-sms-field="brand.mobilePhone"]').waitFor();
    await page.locator('[data-sms-field="brand.address2"]').fill('Suite 200');
    await page.getByRole('button',{name:'1. Business'}).click();
    assert.equal(await page.evaluate(()=>window.saved.brand.address2),'Suite 200');
    await page.locator('[data-sms-field="brand.entityType"]').selectOption('PRIVATE_PROFIT');
    assert.equal(await page.locator('[data-sms-field="brand.companyName"]').inputValue(),'Updated Legal LLC');
    assert.equal(await ein.inputValue(),'12-3456789');
    await page.locator('[data-sms-field="brand.sameAsLegalName"]').uncheck();
    assert.equal(await page.locator('[data-sms-field="brand.displayName"]').isEnabled(),true);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('.fm-wizard-pane').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    if(process.env.SMS_SCREENSHOTS) {await mkdir(process.env.SMS_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/identity-mobile.png'});}
    assert.equal(await page.evaluate(()=>window.defaultFeatures().length),3);
    await page.getByRole('button',{name:'3. Messages & consent'}).click();
    assert.equal(await page.getByRole('heading',{name:'Texting Policies'}).count(),1);
    assert.equal(await page.getByRole('heading',{name:'How will your business use texting?'}).count(),1);
    await page.locator('[data-sms-method="WEBSITE_FORM"]').check();
    assert.equal(await page.locator('[data-sms-method="VERBAL"]').isChecked(),true);
    await page.locator('[data-sms-method="KEYWORD"]').check();
    const signup=page.locator('[data-sms-field="campaign.optInLocationUrl"]');await signup.fill('example.com/signup');await signup.blur();assert.equal(await signup.inputValue(),'https://example.com/signup');
    assert.equal(await page.getByText('Your signup form should include',{exact:true}).count(),0);
    assert.equal(await page.locator('[data-sms-field="campaign.optInDisclosure"]').getAttribute('maxlength'),'600');
    assert.equal(await page.locator('[data-sms-field="campaign.messageFlow"]').getAttribute('maxlength'),'600');
    assert.equal(await page.locator('[data-sms-field="campaign.websiteFormConfirmed"]').count(),0);
    assert.equal(await page.locator('[data-sms-field="campaign.policyContentConfirmed"]').count(),0);
    await page.getByText('See an example privacy policy: SMS section',{exact:true}).click();
    assert.equal(await page.getByText(/collects your mobile number and SMS consent record/).count(),1);
    assert.equal(await page.locator('[data-sms-feature-confirm]').count(),0);
    assert.equal(await page.locator('.sms-feature-icon').count(),0);
    await page.locator('.sms-evidence').scrollIntoViewIfNeeded();
    const scrollBefore=await page.locator('.fm-wizard-pane').evaluate(el=>el.scrollTop);
    assert.ok(scrollBefore>200);
    const screenshot=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlPpN8AAAAASUVORK5CYII=','base64');
    await page.locator('[data-sms-evidence-upload]').setInputFiles([{name:'example.png',mimeType:'image/png',buffer:screenshot},{name:'second.png',mimeType:'image/png',buffer:screenshot}]);
    await page.waitForFunction(()=>window.saved.campaign.optInEvidence?.length===2);
    assert.equal(await page.locator('[data-sms-add-link]').count(),0);
    assert.ok(Math.abs(await page.locator('.fm-wizard-pane').evaluate(el=>el.scrollTop)-scrollBefore)<40);
    assert.equal(await page.locator('.sms-evidence-list a').count(),2);
    await page.evaluate(()=>window.longEvidenceUrl=true);
    await page.locator('[data-sms-evidence-upload]').setInputFiles([{name:'third.png',mimeType:'image/png',buffer:screenshot}]);
    await page.getByText(/Maximum screenshots submitted/).waitFor();
    assert.equal(await page.evaluate(()=>window.saved.campaign.optInEvidence.length),2);
    await page.locator('[data-sms-remove-evidence="0"]').click();
    await page.waitForFunction(()=>window.saved.campaign.optInEvidence?.length===1 && window.saved.campaign.optInEvidenceUrl==='https://example.com/second.png');
    assert.equal(await page.locator('[data-fm-note]').isVisible(),false);
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/consent-new-mobile.png'});
    await page.setViewportSize({width:1280,height:960});
    if(process.env.SMS_SCREENSHOTS){await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/consent-new-desktop.png'});await page.locator('.sms-evidence').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/evidence-desktop.png'});}
    await page.locator('[data-sms-feature="customer_growth"]').check();
    await page.getByRole('button',{name:'4. Message examples'}).click();
    assert.equal(await page.locator('[data-sms-field="campaign.description"]').count(),0);
    assert.equal(await page.locator('[data-sms-field="campaign.sample4"]').isVisible(),true);
    assert.equal(await page.locator('[data-sms-field="campaign.sample4"]').inputValue(),'');
    assert.equal(await page.locator('[data-sms-field="campaign.sample4"]').count(),1);
    assert.equal(await page.locator('[data-sms-field="campaign.sample1"]').inputValue(),'');
    await page.getByText('See an example message',{exact:true}).first().click();
    assert.equal(await page.locator('[data-sms-field="campaign.sample1"]').inputValue(),'');
    await page.locator('[data-sms-field="campaign.sample1"]').fill('My actual customer conversation');
    await page.getByRole('button',{name:'3. Messages & consent'}).click();
    await page.getByRole('button',{name:'4. Message examples'}).click();
    assert.equal(await page.locator('[data-sms-field="campaign.sample1"]').inputValue(),'My actual customer conversation');
    await page.locator('[data-sms-field="campaign.sample1"]').fill('');
    await page.getByRole('button',{name:'5. Number'}).click();
    await page.locator('#sms-number-search').fill('427');
    await page.getByText('No numbers found.',{exact:true}).waitFor();
    assert.ok((await page.locator('#sms-number-search').boundingBox()).width<=180);
    await page.locator('#sms-number-search').fill('206');
    await page.locator('[data-sms-choose-number="+12065550101"]').waitFor();
    assert.match(await page.locator('.sms-number-grid').innerText(),/Seattle, WA/);
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/numbers-new.png'});
    assert.doesNotMatch(await page.locator('.sms-number-grid').innerText(),/SMS|MMS|\$|month/);
    await page.locator('[data-sms-choose-number="+12065550101"]').click();
    await page.getByRole('button',{name:'Choose a different number'}).click();
    const search=page.locator('#sms-number-search');
    assert.equal(await search.inputValue(),'');
    assert.equal(await page.getByText('Enter desired area code',{exact:true}).count(),1);
    await search.fill('06'); await page.waitForTimeout(450);
    assert.equal(await search.isVisible(),true);assert.equal(await search.inputValue(),'06');
    await search.fill(''); await page.waitForTimeout(450);
    assert.equal(await search.isVisible(),true);assert.equal(await search.inputValue(),'');
    await page.evaluate(()=>window.deferSearch=true);
    await search.fill('425');await page.waitForFunction(()=>!!window.releaseSearch);
    await search.fill('2');await page.evaluate(()=>{window.deferSearch=false;window.releaseSearch();});
    await page.waitForTimeout(450);assert.equal(await search.inputValue(),'2');assert.equal(await search.isVisible(),true);
    await search.fill('206');await page.locator('[data-sms-choose-number="+12065550102"]').waitFor();
    assert.equal(await search.isVisible(),true);
    assert.equal(await page.getByText('Your choice',{exact:true}).count(),0);
    await page.locator('[data-sms-choose-number="+12065550102"]').click();
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path.endsWith('/select-number')).length),0);
    let numberDialogs=0;page.on('dialog',dialog=>{numberDialogs++;dialog.dismiss();});
    await page.locator('#smsNext').click();
    await page.waitForFunction(()=>window.saved.campaign.selectedNumber==='+12065550102');
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.path.endsWith('/select-number')).length),1);
    assert.equal(numberDialogs,0);
    await page.locator('[data-sms-summary-checklist]').waitFor();
    assert.equal(await page.locator('.sms-timeline').count(),0);
    await page.getByRole('button',{name:'3. Messages & consent'}).click();
    await page.locator('[data-sms-field="campaign.termsAndConditionsLink"]').fill('');
    await page.getByRole('button',{name:'6. Review & submit'}).click();
    assert.equal(await page.getByRole('button',{name:'Add SMS terms'}).count(),1);
    assert.match(await page.locator('[data-sms-summary-checklist]').innerText(),/missing fields/);
    assert.equal(await page.getByText('Select an item to go straight to it.',{exact:true}).count(),0);
    assert.equal(await page.locator('.sms-review-section').last().evaluate(el=>el.compareDocumentPosition(document.querySelector('[data-sms-summary-checklist]')) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false),true);
    if(process.env.SMS_SCREENSHOTS)await page.screenshot({path:process.env.SMS_SCREENSHOTS+'/summary-missing.png',fullPage:true});
    await page.getByRole('button',{name:'Add SMS terms'}).click();
    assert.equal(await page.locator('[data-sms-field="campaign.termsAndConditionsLink"]').isVisible(),true);
    await page.evaluate(()=>{
      document.querySelector('[data-fm-wizard="sms-workflow"]')?.remove();
      window.saved={...window.saved,status:'active',campaign_status:'mno_provisioned',phone_number_status:'success',phone_number_campaign_status:'assigned',brand:{...window.saved.brand,entityType:'PRIVATE_PROFIT'},provider_refs:{...window.saved.provider_refs,telnyx_campaign_id:'campaign-fixture',telnyx_messaging_profile_id:'msg-fixture',additional_numbers:[]},autoresponse_state:{status:'configured',desired_hash:'same',applied_hash:'same',messaging_profile_id:'msg-fixture'}};
      openSmsWizard(window.saved,{initialStep:'number'});
    });
    await page.getByRole('button',{name:'Add another number'}).click();
    await page.locator('#sms-number-search').fill('206');
    await page.locator('[data-sms-choose-number="+12065550101"]').click();
    await page.getByRole('button',{name:'Reserve additional number'}).click();
    await page.waitForFunction(()=>window.requests.some(request=>request.path.endsWith('/add-number')));
    assert.equal(await page.evaluate(()=>window.saved.campaign.selectedNumber),'+12065550102');
    assert.equal(await page.evaluate(()=>window.saved.provider_refs.additional_numbers[0].phone_number),'+12065550101');
    assert.equal(await page.getByText('Activating',{exact:true}).count()>0,true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
