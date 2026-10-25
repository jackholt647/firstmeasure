import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// The Materials guided flow end to end, the way a person meets it (docs/architecture/guided-experiences.md): the portal
// page and a project window frame, each loading the libraries as the portal does, against one fake server whose
// progress survives reloads. Covers one experience at a time across frames, fast Next/Back, closing mid-tour,
// reopening the tab, reloading, switching projects, the tray's questions and scripted lines shown once.
const lib=file=>readFile(new URL('../../libraries/'+file,import.meta.url),'utf8');
const LIBS=['window-manager/window-manager.js','doc-markdown/firstmate-markdown.js','platform-assistant/platform-assistant.js','tab-guides/tab-guides.js','guided-experiences/guided-experiences.js','guided-experiences/guided-setup.js'];
const t=(key,text)=>({key,text});
const line=(id,name)=>({id,name,kind:'line',role:'field_shingles',unit:'bundle',price:55,tier:'architectural',popular:true,coverage:0.3333,rule:'field_shingles'});
const OPTIONS={markup:35,region:{id:'south',label:'South'},brands:[{id:'gaf',name:'GAF',color:'#d71920',tagline:'Timberline',lines:[line('lib-shingle-gaf-hdz','GAF Timberline HDZ')],accessories:[]},{id:'iko',name:'IKO',color:'#344054',tagline:'',lines:[line('lib-shingle-iko','IKO Cambridge')],accessories:[]}],generic:[],labor:[],rules:[],waste:{default:'roof',options:[10]},ice_eave_width:{default:6,options:[6]},sample:{roofSquares:28}};
const SAY={brands:['Let\u2019s set up your price book.','Which shingle manufacturers do you use?'],lines:['Here are the lines.'],prices:['Last step.'],done:['Your price book is ready.']};
const SETUP={id:'materials.pricebook_setup.roofing',version:1,kind:'agentic',scope:'organization',title:t('gx_mps_title','Set up your price book'),tab:'project.materials',replayable:false,variant:{id:'agentic',bucket:0.2,unit:'organization:o'},
  steps:[{id:'brands',widget:'brand-cards',title:t('gx_mps_brands_title','Which shingle manufacturers do you use?'),say:SAY.brands.map((text,i)=>t('gx_s'+i,text)),options:{...OPTIONS,allow_all:true},required:true},
    {id:'lines',widget:'product-lines',title:t('gx_mps_lines_title','What shingles do you usually use?'),say:SAY.lines.map((text,i)=>t('gx_l'+i,text)),options:OPTIONS,required:true},
    {id:'prices',widget:'price-review',title:t('gx_mps_prices_title','Check your prices'),say:SAY.prices.map((text,i)=>t('gx_p'+i,text)),options:OPTIONS,required:false}],
  completion:{action:{id:'pricebook.setup.apply',target:'organization'},say:SAY.done.map((text,i)=>t('gx_d'+i,text)),then:[{handoff:'assistant_tray'},{resume:true},{play:'materials.tab_tutorial'}]}};
const TOUR={id:'materials.tab_tutorial',version:1,kind:'overlay',scope:'person',title:t('gx_mt_title','Materials tour'),tab:'project.materials',replayable:true,variant:{id:'tour',bucket:0.1,unit:'person'},
  steps:[{id:'intro',targets:[],placement:'center',title:t('gx_a','Welcome to Materials'),body:t('gx_b','A quick look.'),wait_ms:300},
    {id:'generate',targets:['[data-mt-generate-materials]'],title:t('gx_c','Generate'),body:t('gx_d','Builds the lists.'),wait_ms:1500},
    {id:'missing1',targets:['#nowhere-1'],title:t('gx_e','Missing one'),body:t('gx_f','Not here.'),wait_ms:1500},
    {id:'missing2',targets:['#nowhere-2'],title:t('gx_g','Missing two'),body:t('gx_h','Not here.'),wait_ms:1500},
    {id:'lists',targets:['.mt-resource-column'],title:t('gx_i','Your lists'),body:t('gx_j','Click a quantity.'),wait_ms:1500},
    {id:'outro',targets:[],placement:'center',title:t('gx_k','You\u2019re all set'),body:t('gx_l','Ask for the tour again.'),wait_ms:300}],
  completion:{action:null,say:[],then:[]}};
const FAQS={tab:'project.materials',questions:[{id:'materials.how',text:t('gx_faq_mat_how_generate','How do I generate the materials list?'),action:'ask'},{id:'materials.tour',text:t('gx_faq_mat_tour','Show me the tutorial again'),action:'play',experience:'materials.tab_tutorial'}]};

/** The fake server: progress, events, the project conversation. Lives in Node, so it survives page reloads. */
function server(){
  const state={progress:{},events:[],thread:[],generated:0};
  const finished=id=>state.progress[id]&&state.progress[id]!=='started';
  const list=()=>{
    const out=[];
    if(!finished(SETUP.id))out.push({...SETUP,triggers:[{kind:'before_action',action:'materials.generate',selector:'[data-mt-generate-materials]',once:true}],progress:state.progress[SETUP.id]?{status:state.progress[SETUP.id]}:null});
    out.push({...TOUR,triggers:finished(SETUP.id)&&!finished(TOUR.id)?[{kind:'tab_opened',tab:'project.materials',delay_ms:200}]:[],progress:state.progress[TOUR.id]?{status:state.progress[TOUR.id]}:null});
    return out;
  };
  async function handle(route){
    const request=route.request(),url=new URL(request.url()),body=request.postDataBuffer()?JSON.parse(request.postDataBuffer().toString('utf8')):null;
    const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...data})});
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await lib(url.pathname.slice(11))});
    if(url.pathname==='/portal/')return route.fulfill({contentType:'text/html',body:page('portal')});
    if(url.pathname.startsWith('/project/'))return route.fulfill({contentType:'text/html',body:page('project',url.pathname.split('/')[2])});
    if(url.pathname.endsWith('/experiences'))return json({experiences:list(),faqs:url.searchParams.get('tab')==='project.materials'?FAQS:null});
    const id=decodeURIComponent(url.pathname.split('/experiences/')[1]?.split('/')[0]||'');
    if(url.pathname.endsWith('/events')){
      state.events.push({id,...body,at:Date.now()});
      if(['start','exposure','replay'].includes(body.type)&&(!finished(id)||body.type==='replay'))state.progress[id]='started';
      if(body.type==='complete')state.progress[id]='completed';
      if(body.type==='dismiss')state.progress[id]='dismissed';
      return json({recorded:true});
    }
    if(url.pathname.endsWith('/complete')){state.progress[id]='completed';return json({result:{items:3}});}
    if(url.pathname.endsWith('/conversation')){
      // As the server: every scripted line has a stable key and is written once.
      const at=body.step_id||'done',keys=new Set(state.thread.map(m=>m.data?.line_key).filter(Boolean));
      const lines=[...(body.choice?[{role:'user',content:body.choice,key:`${id}:${at}:choice:${body.choice}`}]:[]),...(SAY[at]||[]).map((content,i)=>({role:'assistant',content,key:`${id}:${at}:say:${i}`}))];
      for(const l of lines)if(!keys.has(l.key))state.thread.push({id:'m'+state.thread.length,role:l.role,content:l.content,data:{source:'guided_experience',line_key:l.key}});
      return json({thread_id:'t1'});
    }
    if(url.pathname==='/mock-assistant/thread')return json({thread:{id:'t1',subject_id:'project:p1'},messages:state.thread});
    if(url.pathname==='/mock-assistant/send'){const reply={id:'r'+state.thread.length,role:'assistant',content:'Architectural shingles are the layered kind.'};state.thread.push({id:'u'+state.thread.length,role:'user',content:body.message},reply);return json({thread:{id:'t1'},assistant_message:reply});}
    if(url.pathname==='/mock-generate'){state.generated++;return json({});}
    return route.fulfill({status:404,body:''});
  }
  return {state,handle};
}

function page(kind,project='p1'){
  const boot=`window.__APP={userOrgId:'o',platformApiBase:'https://fm.test/v1/platform'};
    window.route={project:${JSON.stringify(kind==='project'?project:'')},projectTab:${JSON.stringify(kind==='project'?'materials':'')}};
    window.Portal={navigation:{read:()=>window.route},can:()=>true,tabs:{activateTab(){}},util:{currentBranchId:()=>'default'}};
    const thread={id:'t1',subject_id:'project:p1'},get=async p=>(await fetch(p)).json(),post=async(p,b)=>(await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
    window.AssistantAPI={context:async()=>({main_thread:{id:'main'},threads:[],agents:[],dashboard:[]}),projectConversation:async()=>({thread}),thread:async()=>get('/mock-assistant/thread'),send:async(o,t,b)=>post('/mock-assistant/send',b)};`;
  const scripts=LIBS.map(file=>`<script src="/libraries/${file}"></script>`).join('');
  if(kind==='portal')return `<!doctype html><html><head><style>body{margin:0;font:14px Arial}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body><main class="main"><div id="mainPanels"></div></main><script>${boot}</script>${scripts}<iframe id="project" src="/project/p1"></iframe></body></html>`;
  return `<!doctype html><html><head><style>body{margin:0;font:14px Arial}#rOverlay{position:fixed;inset:0;display:flex;flex-direction:column}.fm-project-tray-tabs{display:flex;justify-content:flex-end}.fm-project-content{flex:1;display:grid;grid-template-columns:1fr 380px}.mt{padding:20px;display:flex;gap:12px;align-items:flex-start}.mt-resource-column{width:240px;height:160px;border:1px solid #ccc}.fm-project-tray{display:flex;flex-direction:column;min-height:0}</style></head><body>
    <div id="rOverlay"><nav class="fm-project-tray-tabs"><button type="button" data-tray="agent" aria-selected="false">Agent</button></nav>
    <div class="fm-project-content"><div class="mt"><button type="button" data-mt-generate-materials>Generate</button><div class="mt-resource-column">Materials</div></div><aside class="fm-project-tray"></aside></div></div>
    <script>${boot}</script>${scripts}
    <script>
      document.querySelector('[data-mt-generate-materials]').addEventListener('click',()=>fetch('/mock-generate',{method:'POST'}));
      document.querySelector('[data-tray=agent]').addEventListener('click',e=>{e.currentTarget.setAttribute('aria-selected','true');if(!window.tray)window.tray=PlatformAssistant.mountProject(document.querySelector('.fm-project-tray'),{projectId:${JSON.stringify(project)}});});
      // The project window announces its active tab, as project-request/app.js does through tab guides.
      setTimeout(()=>FirstMateTabGuides.opened({appId:'project.materials',tabId:'materials',container:document.querySelector('.fm-project-content'),delay:50}),50);
    </script></body></html>`;
}

async function open(browser,srv,{width=1280,height=800}={}){
  const tab=await browser.newPage({viewport:{width,height}}),errors=[];
  tab.on('pageerror',error=>errors.push(error.message));
  await tab.route('https://fm.test/**',route=>srv.handle(route));
  await tab.goto('https://fm.test/portal/');
  const frame=()=>tab.frames().find(f=>f.url().includes('/project/'));
  await tab.waitForFunction(()=>document.querySelector('#project')?.contentWindow?.FirstMateGuides?.experiences().length>0);
  return {tab,errors,frame};
}
/** Every guided overlay or setup on the page, in either document. */
const showing=async(tab,frame)=>({outer:await tab.evaluate(()=>document.querySelectorAll('.gx-pop,.gxs').length),inner:await frame().evaluate(()=>({pops:document.querySelectorAll('.gx-pop').length,setups:document.querySelectorAll('.gxs').length}))});
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('one experience at a time, fast Next and Back, close mid-tour, reopen, reload and switch projects',async()=>{
  const browser=await launch(),srv=server();
  try{
    let {tab,errors,frame}=await open(browser,srv);
    // Opening Materials before the setup plays nothing.
    await tab.waitForTimeout(500);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:0,setups:0}});
    // The first Generate is held for the setup, in the project window only.
    await frame().click('[data-mt-generate-materials]');
    await frame().waitForSelector('.gxs[data-kind=agentic]');
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:0,setups:1}});
    assert.equal(srv.state.generated,0);
    // Spamming Continue before choosing does nothing; after choosing it moves one step at a time, at once.
    for(let i=0;i<6;i++)await frame().click('[data-gxs=next]',{force:true});
    assert.equal(await frame().locator('.gxs-step:not(.gxs-above) h2').innerText(),'Which shingle manufacturers do you use?');
    await frame().click('[data-all]');
    const started=Date.now();
    await frame().click('[data-gxs=next]');
    await frame().waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent==='What shingles do you usually use?');
    assert.ok(Date.now()-started<900,`Continue answers at once (${Date.now()-started} ms)`);
    // A burst of presses counts once, so it cannot skip steps.
    await frame().waitForTimeout(400);
    await frame().evaluate(()=>{for(let i=0;i<8;i++)document.querySelector('[data-gxs=next]').click();});
    await frame().waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent==='Check your prices');
    assert.equal(await frame().locator('.gxs-step:not(.gxs-above) h2').innerText(),'Check your prices','one step per burst, never past the last');
    await frame().click('[data-gxs=back]');
    await frame().waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent==='What shingles do you usually use?');
    await frame().waitForTimeout(500);
    await frame().click('[data-gxs=next]');
    await frame().waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent==='Check your prices');
    // Every scripted line is in the setup's assistant once, even though the lines step was shown twice.
    await frame().waitForFunction(()=>[...document.querySelectorAll('.gxs-assistant .fma-msg.assistant')].some(el=>el.textContent.includes('Last step.')));
    const setupLines=await frame().locator('.gxs-assistant .fma-msg.assistant').allInnerTexts();
    assert.equal(setupLines.filter(text=>text.includes('Here are the lines.')).length,1,JSON.stringify(setupLines));
    await frame().waitForTimeout(500);
    await frame().click('[data-gxs=next]');
    // Hand-off to the tray, the held Generate, then the tour: one overlay, in the project window.
    await frame().waitForSelector('.gx-pop',{timeout:10000});
    await tab.waitForTimeout(800);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:1,setups:0}});
    assert.equal(srv.state.generated,1,'the held Generate ran once');
    // The tray holds the conversation, each line once, drawn like any other assistant message.
    await frame().waitForSelector('.fm-project-tray .fma-msg.assistant',{state:'attached'});
    const trayLines=await frame().locator('.fm-project-tray .fma-msg.assistant').allInnerTexts();
    for(const text of [...SAY.brands,...SAY.lines,...SAY.prices,...SAY.done])assert.equal(trayLines.filter(entry=>entry.trim()===text).length,1,`"${text}" once in the tray: ${JSON.stringify(trayLines)}`);
    assert.equal(srv.state.thread.filter(m=>m.content==='Here are the lines.').length,1,'stored once');
    // The tray's questions are styled chips in the project window's document.
    await frame().waitForSelector('.fm-project-tray .gx-faq');
    const chip=await frame().locator('.fm-project-tray .gx-faq').first().evaluate(el=>{const s=getComputedStyle(el);return {radius:s.borderTopLeftRadius,height:el.getBoundingClientRect().height,bg:s.backgroundColor};});
    assert.equal(chip.radius,'999px');assert.ok(chip.height>=28&&chip.height<=34);assert.equal(chip.bg,'rgb(255, 255, 255)');
    // Fast Next through the tour: every press is one step, missing targets are skipped without waiting.
    const titles=[];
    // Seconds of lag was the bug; these bounds leave room for a busy test machine. Timed in the page: the click to the new step's title, without waiting for the popover to stop sliding.
    const press=action=>frame().evaluate(async action=>{const before=document.querySelector('.gx-pop h3').textContent,t0=performance.now();document.querySelector(`.gx-pop [data-gx=${action}]`).click();while(document.querySelector('.gx-pop h3')?.textContent===before&&performance.now()-t0<3000)await new Promise(r=>setTimeout(r,10));return {ms:performance.now()-t0,title:document.querySelector('.gx-pop h3')?.textContent};},action);
    for(let i=0;i<3;i++){const step=await press('next');titles.push(step.title);assert.ok(step.ms<600,`Next answers at once (${Math.round(step.ms)} ms)`);}
    assert.deepEqual(titles,['Generate','Your lists','You\u2019re all set']);
    for(let i=0;i<4;i++)await frame().click('.gx-pop [data-gx=back]').catch(()=>{});
    assert.equal(await frame().locator('.gx-pop h3').innerText(),'Welcome to Materials','Back works at any point');
    assert.equal((await showing(tab,frame)).inner.pops,1,'never two popovers');
    // Close mid-tour.
    await frame().click('.gx-pop [data-gx=next]');
    await frame().click('.gx-pop [data-gx=close]');
    await frame().waitForFunction(()=>!document.querySelector('.gx-pop'));
    // Reopening the tab, Generate and a reload start nothing again.
    await frame().evaluate(()=>FirstMateTabGuides.opened({appId:'project.materials',tabId:'materials',delay:10}));
    await frame().click('[data-mt-generate-materials]');
    await tab.waitForTimeout(700);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:0,setups:0}});
    assert.equal(srv.state.generated,2,'Generate now goes straight through');
    await tab.reload();
    await tab.waitForFunction(()=>document.querySelector('#project')?.contentWindow?.FirstMateGuides?.experiences().length>0);
    await tab.waitForTimeout(700);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:0,setups:0}},'nothing plays after a reload');
    // Another project: still nothing; asking for the tour plays it once even when asked from both documents.
    await tab.evaluate(()=>{document.querySelector('#project').src='/project/p2';});
    await tab.waitForFunction(()=>document.querySelector('#project')?.contentWindow?.location.pathname==='/project/p2'&&document.querySelector('#project').contentWindow.FirstMateGuides?.experiences().length>0);
    await tab.waitForTimeout(500);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:0,setups:0}});
    await Promise.all([frame().evaluate(()=>{FirstMateGuides.play('materials.tab_tutorial',{replay:true});}),frame().evaluate(()=>{FirstMateGuides.play('materials.tab_tutorial',{replay:true});}),tab.evaluate(()=>{FirstMateGuides.play('materials.tab_tutorial',{replay:true});})]);
    await frame().waitForSelector('.gx-pop');
    await tab.waitForTimeout(600);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:1,setups:0}},'one tour, not three');
    await frame().click('.gx-pop [data-gx=close]');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the tour after the setup and the tab trigger never stack',async()=>{
  const browser=await launch(),srv=server();
  srv.state.progress[SETUP.id]='completed';
  try{
    // The tab's own trigger (setup already done) and a second request race: one tour.
    const {tab,errors,frame}=await open(browser,srv);
    await frame().evaluate(()=>{FirstMateGuides.play('materials.tab_tutorial');});
    await frame().waitForSelector('.gx-pop');
    await tab.waitForTimeout(900);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:1,setups:0}});
    // Ten fast presses of Next (30 ms apart) walk the tour to its end once: no stacking, one completion.
    await frame().evaluate(async()=>{for(let i=0;i<10;i++){document.querySelector('.gx-pop [data-gx=next]')?.click();await new Promise(r=>setTimeout(r,30));}});
    await frame().waitForFunction(()=>!document.querySelector('.gx-pop'),null,{timeout:5000});
    await tab.waitForTimeout(400);
    assert.deepEqual(await showing(tab,frame),{outer:0,inner:{pops:0,setups:0}},'the queued request for the same tour does not play it again');
    assert.equal(srv.state.events.filter(e=>e.id===TOUR.id&&e.type==='complete').length,1);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
