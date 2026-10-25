import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Guided experiences in the browser (docs/architecture/guided-experiences.md): the held Generate click, the agentic
// setup, the hand-off to the agent tray, the Materials tour overlay, the assistant's questions per tab and the replay.
const read=file=>readFile(new URL('../../'+file,import.meta.url),'utf8');
const sources={core:await read('libraries/guided-experiences/guided-experiences.js'),setup:await read('libraries/guided-experiences/guided-setup.js'),
  assistant:[await read('libraries/window-manager/window-manager.js'),await read('libraries/doc-markdown/firstmate-markdown.js'),await read('libraries/platform-assistant/platform-assistant.js')]};
const t=(key,text)=>({key,text});

const line=(id,name,tier,price,popular=false)=>({id,name,kind:'line',role:'field_shingles',unit:'bundle',price,tier,popular,coverage:0.3333,rule:'field_shingles'});
const OPTIONS={trade:'roofing',catalog:'research',markup:35,region:{id:'south',label:'South'},regions:[{id:'national',label:'National average'},{id:'south',label:'South'}],
  brands:[
    {id:'gaf',name:'GAF',color:'#d71920',tagline:'Timberline',logo:'/images/brands/roofing/gaf.svg',lines:[line('lib-shingle-gaf-hdz','GAF Timberline HDZ','architectural',55,true),line('lib-shingle-gaf-uhdz','GAF Timberline UHDZ','premium_architectural',74)],accessories:[{id:'lib-starter-gaf-prostart',name:'GAF Pro-Start',kind:'accessory',role:'starter',unit:'bundle',price:74}]},
    {id:'owens_corning',name:'Owens Corning',color:'#d6246e',tagline:'Duration',lines:[line('lib-shingle-oc-duration','Owens Corning TruDefinition Duration','architectural',58,true)],accessories:[]},
    {id:'malarkey',name:'Malarkey',color:'#1f6f43',tagline:'Vista',logo:'/images/brands/roofing/missing.png',lines:[line('lib-shingle-malarkey-vista','Malarkey Vista','impact_rated',59)],accessories:[]},
    {id:'certainteed',name:'CertainTeed',color:'#0a5aa5',tagline:'Landmark',lines:[line('lib-shingle-ct-landmark','CertainTeed Landmark','architectural',60)],accessories:[]},
    ...['IKO','Atlas','TAMKO','PABCO'].map(name=>({id:name.toLowerCase(),name,color:'#344054',tagline:'',lines:[line(`lib-shingle-${name.toLowerCase()}`,`${name} Architectural`,'architectural',50)],accessories:[]}))],
  generic:[{id:'lib-drip-edge-alum-white',name:'Drip edge',kind:'generic',role:'flashing',unit:'pc',price:12,rule:'drip_edge'}],
  labor:[{id:'labor-tearoff-layer1',name:'Tear-off',kind:'labor',role:'labor',unit:'sq',price:125,rule:'tear_off'}],
  rules:[{id:'field_shingles',label:'Shingles',explanation:'Every square except the flat part.',formula:'roofSquares - flatRoofSquares',unit:'sq',include_waste:true,measurements:[{key:'roofSquares',label:'Roof squares'},{key:'flatRoofSquares',label:'Flat roof squares'}],manual:false},
    {id:'ice_water',label:'Ice and water barrier',explanation:'Eaves and valleys.',formula:'(eavesLf * 6 + valleyLf * 3) / 100 + pitch2to4Squares',unit:'sq',include_waste:false,measurements:[{key:'eavesLf',label:'Eaves'}],manual:false},
    {id:'pipe_boots',label:'Pipe boots',explanation:'Count them on the report.',formula:null,unit:'ea',include_waste:false,measurements:[],manual:true}],
  waste:{default:'roof',options:[10,12,15,20]},ice_eave_width:{default:6,options:[6,3,0]},sample:{roofSquares:28,flatRoofSquares:2,pitch2to4Squares:1,eavesLf:140,valleyLf:30}};
const SETUP={id:'materials.pricebook_setup.roofing',version:1,kind:'agentic',scope:'organization',title:t('gx_mps_title','Set up your price book'),tab:'project.materials',replayable:false,variant:{id:'agentic',bucket:0.4,unit:'organization:o'},
  triggers:[{kind:'before_action',action:'materials.generate',selector:'[data-mt-generate-materials],[data-mt-generate-column]',once:true}],
  steps:[
    {id:'brands',widget:'brand-cards',title:t('gx_mps_brands_title','Which shingle manufacturers do you use?'),say:[t('gx_a','Let\u2019s set up your price book.'),t('gx_b','Which shingle manufacturers do you use?')],options:{...OPTIONS,allow_all:true},required:true},
    {id:'lines',widget:'product-lines',title:t('gx_mps_lines_title','What shingles do you usually use?'),say:[t('gx_c','Here are the lines.')],options:{...OPTIONS,allow_all:true},required:true},
    {id:'rules',widget:'measurement-rules',title:t('gx_mps_rules_title','How a roof becomes a materials list'),say:[t('gx_d','Here is the maths.')],options:OPTIONS,required:false},
    {id:'prices',widget:'price-review',title:t('gx_mps_prices_title','Check your prices'),say:[t('gx_e','Last step.')],options:OPTIONS,required:false}],
  completion:{action:{id:'pricebook.setup.apply',target:'organization'},say:[t('gx_f','Your price book is ready.')],then:[{handoff:'assistant_tray'},{resume:true},{play:'materials.tab_tutorial'}]},progress:null};
const TOUR={id:'materials.tab_tutorial',version:1,kind:'overlay',scope:'person',title:t('gx_mt_title','Materials tour'),tab:'project.materials',replayable:true,variant:{id:'tour',bucket:0.1,unit:'person:o:u'},triggers:[],
  steps:[{id:'intro',targets:[],placement:'center',title:t('gx_mt_intro_title','Welcome to Materials'),body:t('gx_x','A quick look around.'),advance:'next',wait_ms:300},
    {id:'generate',targets:['[data-mt-generate-materials]'],placement:'auto',title:t('gx_mt_generate_title','Generate'),body:t('gx_y','Builds the lists again.'),advance:'next',wait_ms:300},
    {id:'missing',targets:['#not-on-this-page'],placement:'auto',title:t('gx_z','Never shown'),body:t('gx_z2','Its target is not here.'),advance:'next',wait_ms:100},
    {id:'lists',targets:['.mt-resource-column'],placement:'auto',title:t('gx_mt_lists_title','Your lists'),body:t('gx_w','Click any quantity.'),advance:'next',wait_ms:300}],
  completion:{action:null,say:[],then:[]},progress:null};
const FAQS={'project.materials':{tab:'project.materials',questions:[{id:'materials.how_generate',text:t('gx_faq_mat_how_generate','How do I generate the materials list?'),action:'ask'},{id:'materials.tour',text:t('gx_faq_mat_tour','Show me the tutorial again'),action:'play',experience:'materials.tab_tutorial'}]},
  'project.photos':{tab:'project.photos',questions:[{id:'photos.add',text:t('gx_faq_photos_add','How do I add photos to this project?'),action:'ask'}]},
  'project.docs':{tab:'project.docs',questions:[...['How do I make a proposal for this project?','How does the customer sign?','Can I send a document by text message?','What happens after the customer signs?','How do I change a price on a sent proposal?','Where do signed documents go?'].map((text,i)=>({id:'docs.q'+i,text:t('gx_faq_docs_'+i,text),action:'ask'})),{id:'docs.tour',text:t('gx_faq_mat_tour','Show me the tutorial again'),action:'play',experience:'materials.tab_tutorial'}]}};

async function load(browser,{width=1280,height=800,reduced=false}={}){
  const page=await browser.newPage({viewport:{width,height}}),errors=[];
  if(reduced)await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));
  // A real origin, so the logo request and the assistant's storage behave as on the portal.
  await page.route('https://fm.test/**',route=>{const url=route.request().url();
    if(url.endsWith('/gaf.svg'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#d71920"/></svg>'});
    if(url.includes('/images/'))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:'text/html',body:'<html></html>'});});
  await page.goto('https://fm.test/portal/');
  await page.setContent(`<style>body{margin:0;font:14px Arial}#rOverlay{position:fixed;inset:0;display:flex;flex-direction:column}.fm-project-tray-tabs{display:flex;justify-content:flex-end}.fm-project-content{flex:1;display:grid;grid-template-columns:1fr 0}.mt{padding:20px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.mt-resource-column{width:260px;height:200px;border:1px solid #ccc;border-radius:8px}</style>
    <div id="rOverlay"><nav class="fm-project-tray-tabs"><button type="button" data-tray="agent" aria-selected="false">Agent</button></nav>
    <div class="fm-project-content"><div class="mt"><button type="button" data-mt-generate-materials>Generate</button><div class="mt-resource-column">Materials</div><button data-mt-open-pricebook>Price book</button></div><aside class="fm-project-tray"></aside></div></div>
    <div class="fma-drawer" id="faqHost"><div data-fma="composer"><div class="fma-compose-shell"><textarea></textarea></div></div></div><main class="main"><div id="mainPanels"></div></main>`);
  await page.evaluate(({SETUP,TOUR,FAQS})=>{
    window.__APP={userOrgId:'o',platformApiBase:'http://fm.test/v1/platform'};
    window.route={project:'p1',projectTab:'materials'};
    window.Portal={navigation:{read:()=>window.route},can:()=>true,tabs:{activateTab(){}},util:{currentBranchId:()=>'default'}};
    window.calls=[];window.generated=0;window.trayOpened=0;
    document.querySelector('[data-mt-generate-materials]').addEventListener('click',()=>{window.generated++;});
    document.querySelector('[data-tray=agent]').addEventListener('click',e=>{window.trayOpened++;e.currentTarget.setAttribute('aria-selected','true');});
    const progress={};
    const list=()=>[SETUP,TOUR].map(e=>({...e,progress:progress[e.id]||null})).filter(e=>!(e.progress&&e.progress.status!=='started'&&!e.replayable)).map(e=>e.progress&&e.progress.status!=='started'?{...e,triggers:[]}:e);
    window.fetch=async(url,options={})=>{
      const u=new URL(url),method=(options.method||'GET').toUpperCase(),body=options.body?JSON.parse(options.body):null;
      window.calls.push({path:u.pathname,method,body});
      const json=d=>new Response(JSON.stringify({ok:true,...d}),{status:200,headers:{'Content-Type':'application/json'}});
      if(method==='GET'&&u.pathname.endsWith('/experiences')){const tab=u.searchParams.get('tab');return json({experiences:list(),faqs:FAQS[tab]||null});}
      const id=decodeURIComponent(u.pathname.split('/experiences/')[1]?.split('/')[0]||'');
      if(u.pathname.endsWith('/events')){if(body.type==='complete')progress[id]={status:'completed'};if(body.type==='dismiss')progress[id]={status:'dismissed'};if(body.type==='replay')progress[id]={status:'started'};return json({recorded:true,progress:progress[id]||null});}
      if(u.pathname.endsWith('/complete')){progress[id]={status:'completed'};return json({result:{items:12,default_line:'lib-shingle-gaf-hdz'},progress:progress[id]});}
      // The server stores the scripted turn in the person's project conversation.
      if(u.pathname.endsWith('/conversation')){const step=SETUP.steps.find(s=>s.id===body.step_id);if(body.choice)window.thread.push({id:'m'+window.thread.length,role:'user',content:body.choice,data:{source:'guided_experience'}});for(const line of (step?step.say:body.phase==='done'?SETUP.completion.say:[]))window.thread.push({id:'m'+window.thread.length,role:'assistant',content:line.text,data:{source:'guided_experience'}});return json({thread_id:'thread_1',messages:1});}
      return new Response('{}',{status:404});
    };
    window.thread=[];const projectThread={id:'thread_1',subject_id:'project:p1'};
    window.AssistantAPI={context:async()=>({main_thread:{id:'main',subject_id:'main'},threads:[],agents:[],dashboard:[]}),projectConversation:async()=>({thread:projectThread}),thread:async()=>({thread:projectThread,messages:window.thread.slice()}),
      send:async(org,thread,body)=>{window.calls.push({path:'assistant',thread,body});const reply={id:'r'+window.thread.length,role:'assistant',content:'Architectural shingles are the thicker, layered kind.'};window.thread.push({id:'u'+window.thread.length,role:'user',content:body.message},reply);return {thread:projectThread,assistant_message:reply};}};
  },{SETUP,TOUR,FAQS});
  for(const content of sources.assistant)await page.addScriptTag({content});
  await page.addScriptTag({content:sources.core});
  await page.addScriptTag({content:sources.setup});
  await page.waitForFunction(()=>window.FirstMateGuides?.experiences().length===2);
  return {page,errors};
}
// GX_SHOTS=<dir> saves screenshots of each stage for a visual check.
const shot=(page,name)=>process.env.GX_SHOTS?page.screenshot({path:`${process.env.GX_SHOTS}/${name}.png`}):null;
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('the first Generate plays the agentic setup, hands the conversation to the agent tray, then the tour',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs[data-kind=agentic] .gxs-sheet');
    assert.equal(await page.evaluate(()=>window.generated),0,'the click is held while the setup plays');
    assert.equal(await page.locator('.gxs').getAttribute('data-fmr-ignore'),'','the setup is left out of session replays');
    assert.ok(Number(await page.locator('.gxs').evaluate(el=>getComputedStyle(el).zIndex))>2147483200,'above the project window');
    // The agent is the platform assistant itself, in the project conversation, saying the step's lines.
    await page.waitForSelector('.gxs-chat .gxs-assistant .fma-drawer.fma-embedded [data-fma=composer]');
    await page.waitForFunction(()=>[...document.querySelectorAll('.gxs-assistant .fma-msg.assistant')].some(el=>/Which shingle manufacturers/.test(el.textContent)));
    const lines=await page.locator('.gxs-assistant .fma-msg.assistant').allInnerTexts();
    assert.equal(lines.filter(text=>/Which shingle manufacturers/.test(text)).length,1,'a line the server also stored is shown once');
    assert.equal(await page.locator('.gxs-assistant .gx-faqs').count(),0,'no tab questions inside a setup');
    assert.equal(await page.locator('.gxs-step h2').innerText(),'Which shingle manufacturers do you use?');
    // One close, top right of the whole sheet, by the agent column.
    assert.equal(await page.locator('[data-gxs=close]').count(),1);
    assert.equal(await page.locator('.gxs-head [data-gxs=close]').count(),0);
    const [sheet,close,chatBox]=await Promise.all([page.locator('.gxs-sheet').boundingBox(),page.locator('.gxs-close').boundingBox(),page.locator('.gxs-chat').boundingBox()]);
    assert.ok(sheet.x+sheet.width-(close.x+close.width)<16&&close.y-sheet.y<16,'top right');
    assert.ok(close.x>chatBox.x,'over the agent column');
    // Eight brands in an even grid; a logo where there is one, the wordmark otherwise or when it fails.
    assert.equal(await page.locator('.gxs-card').count(),8);
    await page.waitForFunction(()=>document.querySelector('[data-brand=gaf] img')?.naturalWidth>0);
    await page.waitForFunction(()=>!document.querySelector('[data-brand=malarkey] img')&&document.querySelector('[data-brand=malarkey] .gxs-wordmark')?.textContent==='Malarkey');
    assert.equal(await page.locator('[data-brand=gaf] .gxs-wordmark').count(),0);
    assert.equal(await page.locator('[data-brand=iko] .gxs-wordmark').innerText(),'IKO');
    const logo=await page.locator('[data-brand=gaf] img').boundingBox();
    assert.ok(logo.height<=48,'logos share one box');
    const heights=new Set(await page.locator('.gxs-card').evaluateAll(cards=>cards.map(card=>Math.round(card.getBoundingClientRect().height))));
    assert.equal(heights.size,1,'every card is the same height');
    await page.waitForTimeout(process.env.GX_SHOTS?700:0);await shot(page,'1-brands');
    assert.equal(await page.locator('[data-gxs=next]').isDisabled(),true,'a brand is needed first');
    await page.click('[data-all]');
    assert.equal(await page.locator('.gxs-card[aria-pressed=true]').count(),8,'Use all picks every brand');
    await page.click('[data-gxs=next]');
    await page.waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent==='What shingles do you usually use?');
    await page.waitForFunction(()=>[...document.querySelectorAll('.gxs-assistant .fma-msg.user')].some(el=>el.textContent==='All of them'),null,{timeout:4000});
    // Popular lines start ticked; include-all and the star set the default.
    assert.equal(await page.locator('.gxs-row[aria-checked=true]').count(),2);
    await page.click('.gxs-allbar [data-all]');
    assert.equal(await page.locator('.gxs-row[aria-checked=true]').count(),9);
    await page.click('[data-star="lib-shingle-gaf-uhdz"]');
    await shot(page,'2-lines');
    // Typing switches to the real assistant for one turn, then back to the steps.
    await page.fill('.gxs-assistant [data-fma=input]','What is an architectural shingle?');
    await page.click('.gxs-assistant [data-fma=send]');
    await page.waitForFunction(()=>document.querySelector('.gxs-assistant .fma-msgs')?.innerText.includes('thicker, layered'));
    const asked=await page.evaluate(()=>window.calls.find(c=>c.path==='assistant'));
    assert.equal(asked.thread,'thread_1','asked in the setup conversation');
    assert.equal(asked.body.ui_context.tab,'project.materials');
    await page.waitForFunction(()=>document.querySelector('.gxs-assistant .fma-msgs').innerText.includes('carry on with the step'));
    assert.ok(await page.evaluate(()=>window.calls.some(c=>c.body?.type==='question')),'the question is recorded');
    // The skip confirmation sits on one row at desktop width.
    await page.click('.gxs-close');
    const row=await page.locator('.gxs-confirm').evaluate(bar=>[...bar.children].map(el=>{const r=el.getBoundingClientRect();return {top:Math.round(r.top+r.height/2),h:r.height};}));
    assert.ok(row.every(item=>Math.abs(item.top-row[0].top)<=3),'sentence and both buttons on one line: '+JSON.stringify(row));
    await shot(page,'1b-skip');
    await page.click('[data-gxs=keep]');
    assert.equal(await page.locator('.gxs-confirm').count(),0);
    await page.click('[data-gxs=next]');
    await page.waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent==='How a roof becomes a materials list');
    assert.match(await page.locator('.gxs-rule').first().innerText(),/Shingles/);
    assert.match(await page.locator('.gxs-rule').first().innerText(),/Roof squares\s*28\s*−\s*Flat roof squares\s*2/,'flat squares are taken away, in plain words');
    assert.match(await page.locator('.gxs-rule').nth(2).innerText(),/Counted by hand/,'pipe boots are entered by hand');
    await page.click('[data-waste="15"]');
    await page.click('[data-rule="ice_water"]');
    await page.click('[data-width="3"]');
    await shot(page,'3-rules');
    await page.click('[data-gxs=next]');
    await page.waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent==='Check your prices');
    assert.match(await page.locator('[data-gxs=next]').innerText(),/Build my price book/);
    await page.waitForTimeout(process.env.GX_SHOTS?700:0);await shot(page,'4-prices');
    await page.fill('[data-price="lib-shingle-gaf-hdz"]','61.5');
    await page.locator('[data-price="lib-shingle-gaf-hdz"]').dispatchEvent('change');
    await page.click('[data-gxs=next]');
    await page.waitForSelector('.gxs-done');
    await page.waitForTimeout(process.env.GX_SHOTS?900:0);await shot(page,'5-done');
    const complete=await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/complete')));
    assert.deepEqual(complete.body.selections.brands,['gaf','owens_corning','malarkey','certainteed','iko','atlas','tamko','pabco']);
    assert.equal(complete.body.selections.default_line,'lib-shingle-gaf-uhdz');
    assert.equal(complete.body.selections.waste,15);
    assert.equal(complete.body.selections.ice_eave_width,3);
    assert.equal(complete.body.selections.prices['lib-shingle-gaf-hdz'],61.5);
    assert.equal(complete.body.project_id,'p1');
    // The conversation flies to the right and becomes the agent tray; the held click goes through; the tour starts.
    await page.waitForFunction(()=>window.trayOpened===1,null,{timeout:8000});
    await page.waitForFunction(()=>!document.querySelector('.gxs'),null,{timeout:8000});
    await page.waitForFunction(()=>window.generated===1,null,{timeout:4000});
    const turns=await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/conversation')).map(c=>c.body.step_id||c.body.phase));
    assert.deepEqual(turns.filter((v,i,a)=>a.indexOf(v)===i),['brands','lines','rules','prices','done'],'every scripted turn is written into the project conversation');
    await page.waitForSelector('.gx-pop',{timeout:6000});
    assert.equal(await page.locator('.gx-pop h3').innerText(),'Welcome to Materials');
    assert.equal(await page.locator('.gx-ov').getAttribute('data-fmr-ignore'),'');
    await page.click('.gx-pop [data-gx=next]');
    await page.waitForFunction(()=>document.querySelector('.gx-pop h3')?.textContent==='Generate');
    await page.waitForTimeout(process.env.GX_SHOTS?600:0);await shot(page,'6-tour');
    // The target is undimmed: the dim path has a hole over the button, and the ring sits on it.
    await page.waitForTimeout(500);
    const geometry=await page.evaluate(()=>{const b=document.querySelector('[data-mt-generate-materials]').getBoundingClientRect(),r=document.querySelector('.gx-ov-ring').getBoundingClientRect();return {holes:(document.querySelector('.gx-ov-dim').getAttribute('d').match(/M/g)||[]).length,dx:Math.abs(r.left+6-b.left),dy:Math.abs(r.top+6-b.top),hit:document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.matches('[data-mt-generate-materials]'),dimmed:!!document.elementFromPoint(5,700)?.closest('.gx-ov')};});
    assert.equal(geometry.holes,2,'the page plus one hole');
    assert.ok(geometry.dx<2&&geometry.dy<2,'the ring is on the button');
    assert.equal(geometry.hit,true,'the highlighted button can still be pressed');
    assert.equal(geometry.dimmed,true,'the rest of the page is dimmed and blocked');
    await page.click('.gx-pop [data-gx=skip]');
    // The missing target is skipped.
    await page.waitForFunction(()=>document.querySelector('.gx-pop h3')?.textContent==='Your lists');
    await page.click('.gx-pop [data-gx=back]');
    await page.waitForFunction(()=>document.querySelector('.gx-pop h3')?.textContent==='Generate');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('.gx-pop'));
    // Events go out in the background, in order.
    await page.waitForFunction(()=>window.calls.some(c=>c.path.includes('materials.tab_tutorial')&&c.body?.type==='dismiss'));
    const events=await page.evaluate(()=>window.calls.filter(c=>c.path.includes('materials.tab_tutorial')&&c.path.endsWith('/events')).map(c=>c.body.type));
    for(const type of ['exposure','start','step_view','step_done','step_skip','back','dismiss'])assert.ok(events.includes(type),`${type} recorded`);
    // A second Generate goes straight through: the setup is done.
    await page.click('[data-mt-generate-materials]');
    assert.equal(await page.evaluate(()=>window.generated),2);
    assert.equal(await page.locator('.gxs').count(),0);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the assistant suggests questions for the open tab, and "Show me the tutorial again" replays the tour',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.evaluate(()=>{window.asked=[];window.FirstMateGuides.attachAssistant(document.querySelector('.fma-drawer'),{getContext:()=>({surface:'project',projectId:'p1',tab:window.route.projectTab}),ask:text=>window.asked.push(text)});});
    await page.waitForSelector('.gx-faqs:not([hidden]) .gx-faq');
    assert.deepEqual(await page.locator('.gx-faq').allInnerTexts(),['Show me the tutorial again','How do I generate the materials list?'],'the replay leads');
    assert.ok(await page.evaluate(()=>document.querySelector('.gx-faqs-wrap').nextElementSibling.classList.contains('fma-compose-shell')),'just above the composer');
    await page.click('text=How do I generate the materials list?');
    assert.deepEqual(await page.evaluate(()=>window.asked),['How do I generate the materials list?']);
    await page.click('text=Show me the tutorial again');
    await page.waitForSelector('.gx-pop');
    assert.equal(await page.locator('.gx-pop h3').innerText(),'Welcome to Materials');
    assert.ok(await page.evaluate(()=>window.calls.some(c=>c.path.includes('materials.tab_tutorial')&&c.body?.type==='replay')),'recorded as a replay');
    await page.click('.gx-pop [data-gx=close]');
    await page.waitForFunction(()=>!document.querySelector('.gx-pop'));
    await page.evaluate(()=>{window.route={project:'p1',projectTab:'photos'};window.dispatchEvent(new CustomEvent('fm:route-state:updated'));});
    await page.waitForFunction(()=>document.querySelector('.gx-faq')?.textContent==='How do I add photos to this project?');
    assert.equal(await page.locator('.gx-faq').count(),1,'Photos questions on the Photos tab');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('at phone width the setup fills the screen with the conversation folded below, and reduced motion still works',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser,{width:390,height:780,reduced:true});
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs-sheet');
    const box=await page.locator('.gxs-sheet').boundingBox();
    assert.ok(Math.abs(box.width-390)<1&&box.x===0,'full width');
    assert.ok((await page.locator('.gxs-chat').boundingBox()).height<=50,'conversation folded');
    await shot(page,'7-phone');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=390),'no sideways scroll');
    await page.click('.gxs-chat-handle');
    await page.waitForFunction(()=>document.querySelector('.gxs-chat').getBoundingClientRect().height>200);
    assert.ok(await page.locator('.gxs-assistant [data-fma=input]').isVisible(),'the assistant composer, unfolded');
    await page.click('.gxs-chat-handle');
    await page.click('[data-gxs=close]');
    // At phone width the sentence takes its own line and the two buttons share the next.
    const [text,keep,skip]=await page.locator('.gxs-confirm > *').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON()));
    assert.ok(Math.abs(keep.top-skip.top)<=2&&keep.top>=text.bottom-1,'buttons together under the sentence');
    assert.ok(skip.right<=390,'nothing runs off the screen');
    await shot(page,'7b-phone-skip');
    await page.click('[data-gxs=dismiss]');
    await page.waitForFunction(()=>!document.querySelector('.gxs'));
    await page.waitForFunction(()=>window.generated===1,null,{timeout:3000});
    assert.ok(await page.evaluate(()=>window.calls.some(c=>c.body?.type==='dismiss'&&c.path.includes('pricebook_setup'))),'skipping the setup is recorded and lets Generate run');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('every suggested question is visible at once in wrapped rows, with More for the rest, the replay first',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser,{width:390,height:780});
    await page.evaluate(()=>{const host=document.querySelector('#faqHost');host.style.cssText='width:360px;position:fixed;left:15px;bottom:0;background:#fff';window.route={project:'p1',projectTab:'docs'};window.FirstMateGuides.attachAssistant(host,{getContext:()=>({tab:'docs'}),ask(){}});});
    await page.waitForSelector('#faqHost .gx-faq');
    const box=await page.evaluate(()=>{const strip=document.querySelector('#faqHost .gx-faqs'),r=strip.getBoundingClientRect();return {sideways:strip.scrollWidth>strip.clientWidth+1,height:r.height,inside:[...strip.children].every(c=>c.getBoundingClientRect().right<=r.right+1&&c.getBoundingClientRect().left>=r.left-1),first:strip.firstElementChild.textContent,icon:!!strip.firstElementChild.querySelector('.fa-circle-play')};});
    assert.equal(box.sideways,false,'no sideways scrolling');
    assert.ok(box.inside,'every chip fits the width');
    assert.ok(box.height<=70,`two rows at most before More (${box.height})`);
    assert.equal(box.first,'Show me the tutorial again');assert.ok(box.icon);
    assert.equal(await page.locator('#faqHost .gx-faq-more').isVisible(),true);
    assert.equal(await page.locator('#faqHost .gx-faq-more').innerText(),'More');
    await page.click('#faqHost .gx-faq-more');
    const open=await page.evaluate(()=>{const strip=document.querySelector('#faqHost .gx-faqs');return {all:strip.scrollHeight<=strip.clientHeight+6,label:document.querySelector('#faqHost .gx-faq-more').textContent};});
    assert.deepEqual(open,{all:true,label:'Less'});
    await shot(page,'8-faqs');
    // A short list needs no More.
    await page.evaluate(()=>{window.route={project:'p1',projectTab:'materials'};window.FirstMateGuides.attachAssistant(document.querySelector('.fma-drawer:not(#faqHost)')||document.body,{});});
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the tour draws an arrow only against a target, pointing at it',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.evaluate(()=>{window.FirstMateGuides.play('materials.tab_tutorial',{replay:true});});
    await page.waitForSelector('.gx-pop');
    assert.equal(await page.locator('.gx-pop h3').innerText(),'Welcome to Materials');
    assert.equal(await page.locator('.gx-pop .gx-arrow').count(),0,'the centred welcome has no arrow');
    await page.click('.gx-pop [data-gx=next]');
    await page.waitForFunction(()=>document.querySelector('.gx-pop h3')?.textContent==='Generate');
    await page.waitForTimeout(600);
    const arrow=await page.evaluate(()=>{const a=document.querySelector('.gx-pop .gx-arrow').getBoundingClientRect(),b=document.querySelector('[data-mt-generate-materials]').getBoundingClientRect();return {ax:a.left+a.width/2,ay:a.top+a.height/2,left:b.left,right:b.right,bottom:b.bottom};});
    assert.ok(arrow.ax>=arrow.left-2&&arrow.ax<=arrow.right+2,'the arrow sits under the button it points at');
    assert.ok(Math.abs(arrow.ay-arrow.bottom)<30,'right by it');
    await page.click('.gx-pop [data-gx=close]');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
