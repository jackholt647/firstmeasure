import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-553: the appointments setup plays the first time someone opens the Scheduling portal tab, then the Scheduling tour
// points at New Appointment. A skip there only puts it off (`defer`): New Appointment asks again, except in the session
// it was skipped in. The real runtime (tab-guides.js, guided-experiences.js, guided-setup.js) against a fake server
// that keeps progress and the deferral as service.ts does (docs/architecture/guided-experiences.md, "Skipping for later").
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
const LIBS=['tab-guides/tab-guides.js','guided-experiences/guided-experiences.js','guided-experiences/guided-setup.js'];
const t=(key,text)=>({key,text});
const SETUP={id:'appointments.setup',version:1,kind:'modal',scope:'organization',title:t('gx_appt_setup_title','Set up scheduling'),replayable:true,variant:{id:'default',bucket:0.1,unit:'organization:o'},
  intro:t('gx_appt_setup_intro','So we can set up scheduling properly, we need to know a couple of things about how you manage your calendar.'),
  skip_note:t('gx_appt_setup_skip_note','You can still book appointments.'),
  steps:[{id:'types',widget:'test-step',title:t('gx_appt_types_title','Your appointment types'),required:false,say:[],options:{},selects:[]}],
  completion:{action:{id:'appointments.setup.apply',target:'organization',input:{}},screen:'none',say:[],then:[{resume:true},{play:'scheduling.tab_tutorial',held:false}]}};
const TAB_TRIGGER={kind:'tab_opened',tab:'portal.scheduling',once:true,delay_ms:100,skip:'later',skip_note:t('gx_appt_setup_later','We’ll ask again when you make your first appointment.')};
const TOUR={id:'scheduling.tab_tutorial',version:1,kind:'overlay',scope:'person',title:t('gx_sched_tour_title','Scheduling tour'),tab:'portal.scheduling',replayable:true,variant:{id:'tour',bucket:0.1,unit:'person'},
  steps:[{id:'new_appointment',targets:['[data-new-appointment]'],title:t('gx_sched_tour_new_title','Book an appointment'),body:t('gx_sched_tour_new_body','Press here.'),advance:'next',wait_ms:1500}],
  completion:{action:null,say:[],then:[]}};

function server(){
  const state={progress:{},events:[],deferred:null,session:'s1',completes:0};
  const finished=id=>state.progress[id]&&state.progress[id]!=='started';
  const list=()=>{
    const out=[];
    if(!finished(SETUP.id)){
      // As service.ts: a deferral uses up the tab trigger, and in the session it was made in nothing else asks either.
      const quiet=state.deferred===state.session;
      const triggers=[TAB_TRIGGER,{kind:'before_action',action:'appointment.new',selector:'[data-new-appointment]',once:true},{kind:'manual'}]
        .filter(trigger=>!(state.deferred&&trigger.kind==='tab_opened')&&!(quiet&&trigger.kind!=='manual'));
      out.push({...SETUP,triggers,progress:state.progress[SETUP.id]?{status:state.progress[SETUP.id]}:null});
    }
    out.push({...TOUR,triggers:[{kind:'after_experience',experience:SETUP.id}],progress:state.progress[TOUR.id]?{status:state.progress[TOUR.id]}:null});
    return out;
  };
  async function handle(route){
    const request=route.request(),url=new URL(request.url()),body=request.postDataBuffer()?JSON.parse(request.postDataBuffer().toString('utf8')):null;
    const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...data})});
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await lib(url.pathname.slice(11))});
    if(url.pathname==='/portal/')return route.fulfill({contentType:'text/html',body:PAGE});
    if(url.pathname.endsWith('/experiences'))return json({experiences:list(),reveals:[],faqs:null});
    const id=decodeURIComponent(url.pathname.split('/experiences/')[1]?.split('/')[0]||'');
    if(url.pathname.endsWith('/events')){
      // As service.ts: an event names a step of the experience or none (guided_step_unknown).
      const own=[SETUP,TOUR].find(entry=>entry.id===id);
      if(body.step_id&&own&&!own.steps.some(step=>step.id===body.step_id))return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({ok:false,error:'guided_step_unknown'})});
      state.events.push({id,type:body.type,step_id:body.step_id||'',properties:body.properties||{}});
      if(['start','exposure','replay'].includes(body.type)&&(!finished(id)||body.type==='replay'))state.progress[id]='started';
      if(body.type==='complete')state.progress[id]='completed';
      if(body.type==='dismiss')state.progress[id]='dismissed';
      if(body.type==='defer')state.deferred=state.session;
      return json({recorded:true});
    }
    if(url.pathname.endsWith('/complete')){state.completes++;state.progress[id]='completed';return json({result:{}});}
    return route.fulfill({status:404,body:''});
  }
  return {state,handle};
}

// The portal's Scheduling tab as the portal announces it (core.js announcePortalTab), with New Appointment's own handler.
const PAGE=`<!doctype html><html><head><style>body{margin:0;font:14px Arial}.toolbar{padding:20px}</style></head><body>
  <script>window.__APP={userOrgId:'o',platformApiBase:'https://fm.test/v1/platform'};window.route={tab:'scheduling'};
    window.Portal={navigation:{read:()=>window.route},can:()=>true,util:{currentBranchId:()=>'default'}};window.opened=0;</script>
  ${LIBS.map(file=>`<script src="/libraries/${file}"></script>`).join('')}
  <div class="toolbar"><button type="button" data-new-appointment>+ Appointment</button></div>
  <script>
    FirstMateGuidedSetup.registerWidget('test-step',{render(el){el.innerHTML='<p>Your appointment types</p>';}});
    document.querySelector('[data-new-appointment]').addEventListener('click',()=>{window.opened++;});
    setTimeout(()=>FirstMateTabGuides.opened({appId:'portal.scheduling',tabId:'scheduling',container:document.body,isActive:()=>true}),50);
  </script></body></html>`;

const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
async function open(browser,srv){
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://fm.test/**',route=>srv.handle(route));
  await page.goto('https://fm.test/portal/');
  return {page,errors};
}

test('first view plays the setup; a skip there is put off, and New Appointment asks again only in a new session',async()=>{
  const browser=await launch(),srv=server();
  try{
    const {page,errors}=await open(browser,srv);
    await page.locator('.gxs').waitFor();
    assert.match(await page.locator('.gxs-intro').innerText(),/how you manage your calendar/,'the first page says why it asks');
    await page.locator('[data-gxs=close]').click();
    assert.match(await page.locator('#gxs-ask-text').innerText(),/ask again when you make your first appointment/,'the skip says when it comes back');
    await page.locator('.gxs-ask [data-gxs=dismiss]').click();
    await page.locator('.gxs').waitFor({state:'detached'});
    // Recorded as put off, never dismissed: the setup is still to do.
    await page.waitForTimeout(300);
    assert.ok(srv.state.events.some(event=>event.id===SETUP.id&&event.type==='defer'));
    assert.equal(srv.state.events.some(event=>event.id===SETUP.id&&event.type==='dismiss'),false);
    assert.equal(srv.state.progress[SETUP.id],'started');
    // The same session: New Appointment opens at once, with no setup and no tour.
    await page.locator('[data-new-appointment]').click();
    assert.equal(await page.evaluate(()=>window.opened),1);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.gxs,.gx-pop').count(),0);
    // A new session (a later visit): the first New Appointment asks, and its click goes through once it is skipped.
    srv.state.session='s2';
    await page.reload();
    await page.waitForFunction(()=>FirstMateGuides.experiences().some(e=>e.id==='appointments.setup'&&e.triggers.some(t=>t.kind==='before_action')));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.gxs').count(),0,'the tab does not ask again');
    await page.locator('[data-new-appointment]').click();
    await page.locator('.gxs').waitFor();
    assert.equal(await page.evaluate(()=>window.opened),0,'the click is held while the setup plays');
    await page.locator('[data-gxs=close]').click();
    assert.doesNotMatch(await page.locator('#gxs-ask-text').innerText(),/ask again/,'a skip here is final');
    assert.match(await page.locator('#gxs-ask-text').innerText(),/still book appointments/);
    await page.locator('.gxs-ask [data-gxs=dismiss]').click();
    await page.waitForFunction(()=>window.opened===1);
    await page.waitForTimeout(300);
    assert.equal(srv.state.progress[SETUP.id],'dismissed');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('finished on first view, the Scheduling tour follows and points at New Appointment; finished from New Appointment, it does not',async()=>{
  const browser=await launch();
  try{
    const srv=server(),{page,errors}=await open(browser,srv);
    await page.locator('.gxs').waitFor();
    await page.locator('[data-gxs=next]').click();
    await page.locator('.gx-pop').waitFor({timeout:5000});
    assert.equal(await page.locator('.gx-pop h3').innerText(),'Book an appointment');
    assert.equal(srv.state.completes,1);
    assert.equal(await page.evaluate(()=>window.opened),0,'nothing was held, nothing is pressed');
    assert.deepEqual(errors,[]);
    await page.close();

    // Put off on the tab in an earlier session, then finished from New Appointment: the dialog opens, with no tour over it.
    const later=server();later.state.deferred='s0';later.state.session='s2';later.state.progress[SETUP.id]='started';
    const second=await open(browser,later);
    await second.page.waitForFunction(()=>FirstMateGuides.experiences().some(e=>e.id==='appointments.setup'));
    await second.page.waitForTimeout(300);
    assert.equal(await second.page.locator('.gxs').count(),0);
    await second.page.locator('[data-new-appointment]').click();
    await second.page.locator('.gxs').waitFor();
    await second.page.locator('[data-gxs=next]').click();
    await second.page.waitForFunction(()=>window.opened===1);
    await second.page.waitForTimeout(1500);
    assert.equal(await second.page.locator('.gx-pop').count(),0,'no tour after a held click');
    assert.equal(later.state.events.some(event=>event.id===TOUR.id),false);
    assert.deepEqual(second.errors,[]);
  }finally{await browser.close();}
});

// GP-54: with a welcome on its tab trigger, the setup first says what Scheduling is for. Set up now goes on to the
// questions; Back puts the setup off (as a skip there does) and returns to the portal tab the person came from.
test('a welcome comes first: Set up now goes to the questions, Back puts it off and returns to the previous tab',async()=>{
  const welcome={title:t('gx_appt_welcome_title','Welcome to Scheduling'),body:t('gx_appt_welcome_body','Every appointment on one calendar.'),
    points:[t('gx_appt_welcome_p1','Book sales appointments')],note:t('gx_appt_welcome_note','A few questions.'),start:t('gx_appt_welcome_start','Set up now'),back:t('gx_appt_welcome_back','Back')};
  const browser=await launch(),original={...TAB_TRIGGER};
  Object.assign(TAB_TRIGGER,{welcome});
  try{
    const srv=server(),{page,errors}=await open(browser,srv);
    await page.evaluate(()=>{window.activated=[];Portal.tabs={previous:()=>'projects',activateTab:(id,initial,options)=>activated.push([id,options?.source])};});
    await page.locator('.gxs [data-gx-step=welcome]').waitFor();
    assert.equal(await page.locator('[data-gx-step=welcome] h2').innerText(),'Welcome to Scheduling');
    assert.match(await page.locator('.gxs-welcome').innerText(),/Every appointment on one calendar[\s\S]*Book sales appointments[\s\S]*A few questions/);
    assert.equal(await page.locator('.gxs-intro').count(),0,'no question yet');
    assert.equal(await page.locator('[data-gxs=next]').innerText(),'Set up now');
    assert.equal(await page.locator('[data-gxs=back]').isVisible(),true);
    assert.equal(await page.locator('[data-gxs=skip]').isVisible(),false);
    // Set up now: the first question, with the setup's intro and the sheet's own Back hidden on it.
    await page.locator('[data-gxs=next]').click();
    await page.locator('.gxs [data-gx-step=types]').waitFor();
    assert.match(await page.locator('[data-gx-step=types] .gxs-intro').innerText(),/how you manage your calendar/);
    assert.equal(await page.locator('[data-gxs=back]').isVisible(),false);
    assert.equal(await page.locator('[data-gxs=back]').innerText(),'Back');
    assert.equal(await page.locator('[data-gxs=next]').innerText(),'Done');
    assert.deepEqual(errors,[]);
    await page.close();

    // Back: put off (defer, never dismiss), and the previous tab opens.
    const second=server(),other=await open(browser,second);
    await other.page.evaluate(()=>{window.activated=[];Portal.tabs={previous:()=>'projects',activateTab:(id,initial,options)=>activated.push([id,options?.source])};});
    await other.page.locator('.gxs [data-gx-step=welcome]').waitFor();
    await other.page.locator('[data-gxs=back]').click();
    await other.page.locator('.gxs').waitFor({state:'detached'});
    await other.page.waitForFunction(()=>activated.length===1);
    assert.deepEqual(await other.page.evaluate(()=>activated),[['projects','guided-welcome-back']]);
    await other.page.waitForTimeout(300);
    assert.ok(second.state.events.some(event=>event.id===SETUP.id&&event.type==='defer'&&event.properties.welcome==='back'));
    assert.equal(second.state.events.some(event=>event.id===SETUP.id&&event.type==='dismiss'),false);
    // Scheduling again in this session: put off, so nothing plays.
    await other.page.evaluate(()=>{FirstMateTabGuides.opened({appId:'portal.projects',tabId:'projects',container:document.body,isActive:()=>true});});
    await other.page.waitForTimeout(200);
    await other.page.evaluate(()=>{FirstMateTabGuides.opened({appId:'portal.scheduling',tabId:'scheduling',container:document.body,isActive:()=>true});});
    await other.page.waitForTimeout(1200);
    assert.equal(await other.page.locator('.gxs').count(),0,'not asked again in the session it was put off in');
    assert.equal(second.state.progress[SETUP.id],'started');
    assert.equal(await other.page.locator('.gx-pop').count(),0,'no tour after Back');
    assert.deepEqual(other.errors,[]);
    await other.page.close();

    // The X on the welcome puts it off too, and stays on Scheduling.
    const third=server(),closed=await open(browser,third);
    await closed.page.evaluate(()=>{window.activated=[];Portal.tabs={previous:()=>'projects',activateTab:(id)=>activated.push([id])};});
    await closed.page.locator('.gxs [data-gx-step=welcome]').waitFor();
    await closed.page.locator('[data-gxs=close]').click();
    await closed.page.locator('.gxs').waitFor({state:'detached'});
    await closed.page.waitForTimeout(300);
    assert.deepEqual(await closed.page.evaluate(()=>activated),[]);
    assert.ok(third.state.events.some(event=>event.id===SETUP.id&&event.type==='defer'));
    assert.deepEqual(closed.errors,[]);
  }finally{for(const key of Object.keys(TAB_TRIGGER))delete TAB_TRIGGER[key];Object.assign(TAB_TRIGGER,original);await browser.close();}
});
