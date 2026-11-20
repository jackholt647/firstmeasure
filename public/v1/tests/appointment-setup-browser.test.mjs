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
    return route.fulfill({contentType:'text/html',body:'<div class="gxs" data-kind="modal"><div class="gxs-step"><div class="gxs-titlebar"><h2>Step</h2></div><main id="step"></main></div></div>'});
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
    await page.locator('[data-gxk-kind="meeting"] [data-category="production"]').click();
    assert.equal(await page.locator('[data-gxk-kind="meeting"]').getAttribute('data-on'),'true');
    await page.locator('[data-gxk-kind="sales"] .gxk-pick').click();
    await page.getByRole('textbox').fill('Estimate');
    await page.getByRole('textbox').press('Enter');
    await page.locator('[data-gxk-kind="custom_estimate"] [data-category="sales"]').click();
    assert.deepEqual(await page.evaluate(()=>handle.answer()),{kinds:[{id:'repair',category:'production'},{id:'meeting',category:'production'},{id:'custom_estimate',label:'Estimate',category:'sales'}]});
    await page.locator('[data-gxk-kind="repair"] .gxk-pick').click(); await page.locator('[data-gxk-kind="meeting"] .gxk-pick').click(); await page.locator('[data-gxk-kind="custom_estimate"] .gxk-pick').click();
    assert.equal(await page.evaluate(()=>handle.valid()),false,'at least one kind');
    // On a phone the pills sit under the name, inside the row.
    const row=await page.locator('[data-gxk-kind="repair"]').boundingBox(),pills=await page.locator('[data-gxk-kind="repair"] .gxk-pills').boundingBox();
    assert.ok(pills.x+pills.width<=row.x+row.width+0.5,'the pills fit the row');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the kinds: two columns; a company with no sales gets no sales kinds and no pills (GP-85)',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser,960);
    await page.evaluate(async L=>{
      const copy=(key,text)=>({key,text});
      const kinds=[['sales','Sales appointment','sales'],['inspection','Inspection','sales'],['installation','Installation','production'],['repair','Repair appointment','production'],['delivery','Material delivery','production'],['meeting','Team meeting','other']];
      window.catalog={kinds:kinds.map(([id,text,category])=>({id,label:copy('gx_appt_kind_'+id,text),category})),
        categories:[{id:'sales',label:copy('a','Sales')},{id:'production',label:copy('b','Production')},{id:'other',label:copy('c','Other')}],suggested:['sales','installation','repair','delivery']};
      window.module=await import('/libraries/setup-steps/appointment-kinds.js');
      window.answer={};
      window.mountKinds=(status)=>{window.handle?.destroy();document.querySelector('#step').innerHTML='';window.handle=module.mount(document.querySelector('#step'),{options:{},answer,L:eval(L),esc,read:async(provider,name)=>name==='catalog'?catalog:status,change(patch){Object.assign(answer,patch);},advance(){}});};
      mountKinds({kinds:[],no_sales:false});
    },L);
    await page.getByText('Team meeting').waitFor();
    assert.deepEqual((await page.evaluate(()=>handle.answer())).kinds.map(kind=>kind.id),['sales','installation','repair','delivery'],'an inspection starts off; a delivery starts on');
    const first=await page.locator('[data-gxk-kind="sales"]').boundingBox(),second=await page.locator('[data-gxk-kind="installation"]').boundingBox();
    assert.ok(Math.abs(first.y-second.y)<1&&second.x>first.x+first.width,'two columns side by side');
    // Back to "who sells" and "no sales appointments": the list starts again, without the sales kinds or the pills.
    await page.evaluate(()=>mountKinds({kinds:[],no_sales:true}));
    await page.getByText('Team meeting').waitFor();
    assert.equal(await page.locator('[data-gxk-kind="sales"],[data-gxk-kind="inspection"]').count(),0);
    assert.equal(await page.locator('.gxk-pills').first().isVisible(),false,'no sales or production to choose');
    assert.deepEqual(await page.evaluate(()=>handle.answer()),{kinds:[{id:'installation',category:'production'},{id:'repair',category:'production'},{id:'delivery',category:'production'}]});
    // And back to a sales team: the sales appointment is picked again, with what was picked before.
    await page.evaluate(()=>mountKinds({kinds:[{id:'installation',category:'production'}],no_sales:false}));
    await page.locator('[data-gxk-kind="sales"]').waitFor();
    assert.deepEqual((await page.evaluate(()=>handle.answer())).kinds.map(kind=>kind.id),['sales','installation','repair','delivery']);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the kinds: the picked ones first, kept in place while tapping; retired kinds only for who picked them (GP-135)',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser,433);
    await page.evaluate(async L=>{
      const copy=(key,text)=>({key,text});
      const kinds=[['sales','Sales appointment','sales'],['inspection','Inspection','sales',true],['installation','Installation','production'],['repair','Repair appointment','production'],['service_call','Service call','production',true],['maintenance','Maintenance visit','production'],['delivery','Material delivery','production'],['walkthrough','Final walkthrough','production'],['meeting','Team meeting','other']];
      window.catalog={kinds:kinds.map(([id,text,category,retired])=>({id,label:copy('gx_appt_kind_'+id,text),category,...(retired?{retired:true}:{})})),
        categories:[{id:'sales',label:copy('a','Sales')},{id:'production',label:copy('b','Production')},{id:'other',label:copy('c','Other')}],suggested:['sales','installation','repair','delivery']};
      window.module=await import('/libraries/setup-steps/appointment-kinds.js');
      window.mountKinds=(status,answer={})=>{window.handle?.destroy();document.querySelector('#step').innerHTML='';window.handle=module.mount(document.querySelector('#step'),{options:{},answer,L:eval(L),esc,read:async(provider,name)=>name==='catalog'?catalog:status,change(){},advance(){}});};
      mountKinds({kinds:[],no_sales:false});
    },L);
    await page.getByText('Team meeting').waitFor();
    const order=()=>page.evaluate(()=>[...document.querySelectorAll('[data-gxk-kind]')].map(node=>node.dataset.gxkKind));
    assert.deepEqual(await order(),['sales','installation','repair','delivery','maintenance','walkthrough','meeting'],'the suggestions first; no inspection or service call');
    await page.locator('[data-gxk-kind="meeting"] .gxk-pick').click();
    await page.locator('[data-gxk-kind="repair"] .gxk-pick').click();
    assert.deepEqual(await order(),['sales','installation','repair','delivery','maintenance','walkthrough','meeting'],'rows do not jump while the person taps');
    // An organization that picked a retired kind before keeps it, first with its other picks.
    await page.evaluate(()=>mountKinds({kinds:[{id:'service_call',label:'Service call',category:'production'},{id:'walkthrough',label:'Final walkthrough',category:'production'}],no_sales:false}));
    await page.locator('[data-gxk-kind="service_call"]').waitFor();
    assert.deepEqual(await order(),['service_call','walkthrough','sales','installation','repair','maintenance','delivery','meeting']);
    assert.deepEqual((await page.evaluate(()=>handle.answer())).kinds.map(kind=>kind.id),['service_call','walkthrough']);
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
        attendees:[{id:'me',label:copy('w1','Me')},{id:'sales_team',label:copy('w2','A salesperson')},{id:'crews',label:copy('w3','A crew')},{id:'subcontractors',label:copy('w5','A subcontractor')},{id:'anyone',label:copy('w4','Whoever is free')},{id:'technician',label:copy('w6','A repair technician')}]};
      const setup={attendees:['me','sales_team','crews','anyone'],kinds:[{id:'sales',label:'Sales appointment',category:'sales',reminder:true,on_my_way:true,attendee:'sales_team',attendees:['sales_team'],offered:['me','sales_team']},{id:'repair',label:'Repair appointment',category:'production',reminder:true,on_my_way:true,attendee:'crews',attendees:['crews','subcontractors'],offered:['technician','crews','subcontractors','me','sales_team']}]};
      window.FirstMateGuides={experience:id=>id==='operations.workforce.setup'?{id}:null};
      window.backs=0;window.guidesRun=[];
      const module=await import('/libraries/guided-experiences/appointments-setup.js');
      window.handle=module.mount(document.querySelector('#step'),{options:{},orgId:'org-test',L:eval(L),esc,setTitle:value=>{window.title=value;},read:async(provider,name)=>name==='catalog'?catalog:setup,change:patch=>Object.assign(selections,patch),complete:async()=>{completed++;},
        canBack:()=>true,back:()=>{backs++;},syncBack(){},runGuide:async id=>{guidesRun.push(id);return {status:'completed'};}});
    },L);
    await page.locator('[data-gxa-kind="sales"]').waitFor();
    assert.equal(await page.evaluate(()=>title),'Sales appointment');
    // GP-85: Back on the first kind goes to the step before (the kinds of appointments).
    await page.locator('[data-gxa-back]').click();
    assert.equal(await page.evaluate(()=>backs),1);
    assert.equal(await page.evaluate(()=>handle.back()),false,'the first page leaves the step to the player');
    // Sales offers me or a salesperson; + shows everyone else. Several can go; the last one picked stays.
    assert.deepEqual(await page.locator('[data-gxa-who]').evaluateAll(nodes=>nodes.map(node=>node.dataset.gxaWho)),['me','sales_team']);
    await page.getByRole('checkbox',{name:'Me'}).click();
    await page.getByRole('checkbox',{name:'A salesperson'}).click();
    await page.getByRole('checkbox',{name:'Me'}).click();
    assert.equal(await page.getByRole('checkbox',{name:'Me'}).getAttribute('aria-checked'),'true','someone has to go');
    await page.locator('[data-gxa-more]').click();
    assert.deepEqual(await page.locator('[data-gxa-who]').evaluateAll(nodes=>nodes.map(node=>node.dataset.gxaWho)),['me','sales_team','crews','subcontractors','anyone','technician']);
    await page.getByRole('switch',{name:/before it starts/}).click();
    await page.getByRole('button',{name:'Continue'}).click();
    assert.equal(await page.evaluate(()=>title),'Repair appointment');
    assert.equal(await page.evaluate(()=>handle.backDepth()),1,'the phone back walks the kinds first');
    assert.deepEqual(await page.locator('[data-gxa-who][aria-checked=true]').evaluateAll(nodes=>nodes.map(node=>node.textContent.trim())),['Crews','Subcontractors'],'who goes starts from who does the work, named by the terminology');
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
    // Before scheduling, the workforce setup is offered; it plays, then the setup finishes as usual.
    await page.locator('[data-gxa-teams]').click();
    await page.waitForFunction(()=>completed===1);
    assert.deepEqual(await page.evaluate(()=>guidesRun),['operations.workforce.setup']);
    assert.deepEqual(await page.evaluate(()=>selections.appointment_types),[{id:'sales',reminder:false,on_my_way:true,attendees:['me']},{id:'repair',reminder:true,on_my_way:true,attendees:['crews','subcontractors']}]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
