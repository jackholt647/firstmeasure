import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-515: the appointment setup's pages against a stubbed publication layer: who sells (one choice), the kinds of
// appointments with their sales/production pills and one of the person's own, then each kind's texts and who goes,
// the texting offer (the shared texting-setup.js flow, the same as the Communications setup) and the finish.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function open(browser,width=960){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://appointment-setup.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
    return route.fulfill({contentType:'text/html',body:'<div class="gxs"><div class="gxs-step"><div class="gxs-titlebar"><h2>Step</h2></div><main id="step"></main></div></div>'});
  });
  await page.goto('https://appointment-setup.test/');
  await page.addScriptTag({content:`window.esc=${esc.toString()};`});
  return {page,errors};
}
const L=`(key,fallback)=>typeof key==='object'&&key?key.text:fallback`;

test('who sells: one choice, saved as the answer',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser);
    await page.evaluate(async L=>{
      const team=(id,text,hint,isTeam)=>({id,label:{key:'gx_sales_team_'+id,text},hint:{key:'gx_sales_team_'+id+'_hint',text:hint},team:isTeam});
      const catalog={company_types:[],services:[],sales_teams:[team('just_me','Just me','I sell',false),team('small_team','A small sales team','A few',true)],workforces:[]};
      window.changes=[];
      const module=await import('/libraries/setup-steps/company-profile.js');
      window.handle=module.mount(document.querySelector('#step'),{options:{part:'sales_team'},answer:{},L:eval(L),esc,read:async(provider,name)=>name==='catalog'?catalog:{},change:(patch,summary)=>changes.push([patch,summary])});
    },L);
    await page.getByRole('radio',{name:/A small sales team/}).click();
    assert.equal(await page.evaluate(()=>handle.valid()),true);
    assert.deepEqual(await page.evaluate(()=>handle.answer()),{sales_team:'small_team'});
    assert.equal(await page.evaluate(()=>handle.summary()),'A small sales team');
    assert.equal(await page.getByRole('radio',{name:/Just me/}).getAttribute('aria-checked'),'false');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the kinds: suggestions picked, pills say sales or production, the person adds their own',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser,390);
    await page.evaluate(async L=>{
      const copy=(key,text)=>({key,text});
      const catalog={kinds:[{id:'sales',label:copy('gx_appt_kind_sales','Sales appointment'),category:'sales'},{id:'repair',label:copy('gx_appt_kind_repair','Repair appointment'),category:'production'},{id:'meeting',label:copy('gx_appt_kind_meeting','Team meeting'),category:'other'}],
        categories:[{id:'sales',label:copy('a','Sales')},{id:'production',label:copy('b','Production')},{id:'other',label:copy('c','Other')}],suggested:['sales','repair']};
      const module=await import('/libraries/setup-steps/appointment-kinds.js');
      window.handle=module.mount(document.querySelector('#step'),{options:{},answer:{},L:eval(L),esc,read:async(provider,name)=>name==='catalog'?catalog:{kinds:[]},change(){},advance(){}});
    },L);
    await page.getByText('Team meeting').waitFor();
    assert.deepEqual(await page.evaluate(()=>handle.answer()),{kinds:[{id:'sales',category:'sales'},{id:'repair',category:'production'}]},'the suggestions start picked');
    // A pill picks the kind it belongs to.
    await page.locator('[data-kind="meeting"] [data-category="production"]').click();
    assert.equal(await page.locator('[data-kind="meeting"]').getAttribute('data-on'),'true');
    await page.locator('[data-kind="sales"] .gxk-pick').click();
    await page.getByRole('textbox').fill('Estimate');
    await page.getByRole('textbox').press('Enter');
    await page.locator('[data-kind="custom_estimate"] [data-category="sales"]').click();
    assert.deepEqual(await page.evaluate(()=>handle.answer()),{kinds:[{id:'repair',category:'production'},{id:'meeting',category:'production'},{id:'custom_estimate',label:'Estimate',category:'sales'}]});
    await page.locator('[data-kind="repair"] .gxk-pick').click(); await page.locator('[data-kind="meeting"] .gxk-pick').click(); await page.locator('[data-kind="custom_estimate"] .gxk-pick').click();
    assert.equal(await page.evaluate(()=>handle.valid()),false,'at least one kind');
    // On a phone the pills sit under the name, inside the row.
    const row=await page.locator('[data-kind="repair"]').boundingBox(),pills=await page.locator('[data-kind="repair"] .gxk-pills').boundingBox();
    assert.ok(pills.x+pills.width<=row.x+row.width+0.5,'the pills fit the row');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('each kind, texting through the shared flow, then the finish with the answers',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser);
    await page.evaluate(async L=>{
      window.__APP={userOrgId:'org-test'};window.calls=[];window.selections={};window.completed=0;
      const status={phone:{registration:'none'},email:{},done:{phone:false,email:false}};
      window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{calls.push(action);
        if(action==='comms.setup.start'){status.done.phone=true;status.phone.registration=window.registered?'approved':'none';}
        return {value:structuredClone(status)};}}};
      window.FirstMateSetupWizard={open(){}};
      window.FirstMateSmsRegistration={open:()=>new Promise(resolve=>{calls.push('registration.open');window.submit=()=>{window.registered=true;resolve({});};})};
      const copy=(key,text)=>({key,text});
      const catalog={kinds:[{id:'sales',label:copy('k1','Sales appointment'),category:'sales'},{id:'repair',label:copy('k2','Repair appointment'),category:'production'}],
        categories:[{id:'sales',label:copy('a','Sales')},{id:'production',label:copy('b','Production')},{id:'other',label:copy('c','Other')}],
        attendees:[{id:'me',label:copy('w1','Me')},{id:'sales_team',label:copy('w2','Our sales team')},{id:'crews',label:copy('w3','A crew')},{id:'anyone',label:copy('w4','Whoever is free')}]};
      const setup={attendees:['me','sales_team','crews','anyone'],kinds:[{id:'sales',label:'Sales appointment',category:'sales',reminder:true,on_my_way:true,attendee:'sales_team'},{id:'repair',label:'Repair appointment',category:'production',reminder:true,on_my_way:true,attendee:'crews'}]};
      const module=await import('/libraries/guided-experiences/appointments-setup.js');
      window.handle=module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:eval(L),esc,setTitle:value=>{window.title=value;},read:async(provider,name)=>name==='catalog'?catalog:setup,change:patch=>Object.assign(selections,patch),complete:async()=>{completed++;}});
    },L);
    await page.locator('[data-gxa-kind="sales"]').waitFor();
    assert.equal(await page.evaluate(()=>title),'Sales appointment');
    await page.getByRole('radio',{name:'Me'}).click();
    await page.getByRole('switch',{name:/before it starts/}).click();
    await page.getByRole('button',{name:'Continue'}).click();
    assert.equal(await page.evaluate(()=>title),'Repair appointment');
    assert.equal(await page.getByRole('radio',{name:'A crew'}).getAttribute('aria-checked'),'true','who goes starts from who does the work');
    await page.getByRole('button',{name:'Continue'}).click();
    // A text was asked for and texting is not set up: offered, the same flow as the Communications setup.
    await page.getByRole('button',{name:'Set up texting'}).click();
    await page.waitForFunction(()=>calls.includes('registration.open'));
    assert.equal(await page.locator('.gxs').evaluate(sheet=>getComputedStyle(sheet).visibility+(sheet.inert?' inert':'')),'hidden inert','the setup steps aside while registration is open');
    await page.evaluate(()=>submit());
    await page.getByText('Your appointment types are ready').or(page.locator('[data-gxa-finish]')).first().waitFor();
    assert.deepEqual(await page.evaluate(()=>calls),['comms.setup.status','comms.setup.start','registration.open','comms.setup.start']);
    assert.equal(await page.locator('.gxs').evaluate(sheet=>getComputedStyle(sheet).visibility),'visible');
    assert.equal(await page.locator('[data-gxa-type]').count(),2);
    await page.locator('[data-gxa-finish]').click();
    await page.waitForFunction(()=>completed===1);
    assert.deepEqual(await page.evaluate(()=>selections.appointment_types),[{id:'sales',reminder:false,on_my_way:true,attendee:'me'},{id:'repair',reminder:true,on_my_way:true,attendee:'crews'}]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
