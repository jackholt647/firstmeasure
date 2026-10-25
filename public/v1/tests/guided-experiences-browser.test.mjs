import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// Guided experiences in the browser (docs/architecture/guided-experiences.md): the held Generate click, the agentic
// setup, the hand-off to the agent tray, the Materials tour overlay, the assistant's questions per tab and the replay.
const read=file=>readFile(new URL('../../'+file,import.meta.url),'utf8');
const sources={core:await read('libraries/guided-experiences/guided-experiences.js'),setup:await read('libraries/guided-experiences/guided-setup.js'),suppliers:await read('libraries/guided-experiences/supplier-columns.js'),
  assistant:[await read('libraries/window-manager/window-manager.js'),await read('libraries/doc-markdown/firstmate-markdown.js'),await read('libraries/platform-assistant/platform-assistant.js')]};
const t=(key,text)=>({key,text});

const line=(id,name,tier,price,visibility='visible',extra={})=>({id,name,kind:'line',role:'field_shingles',unit:'bundle',price,tier,popular:visibility==='default',visibility,coverage:0.3333,rule:'field_shingles',...extra});
const accessory=(id,name,role,price,extra={})=>({id,name,kind:'accessory',role,unit:'bundle',price,coverage:120,rule:role,...extra});
const OPTIONS={trade:'roofing',catalog:'research',region:{id:'south',label:'South'},regions:[{id:'national',label:'National average'},{id:'south',label:'South'}],
  brands:[
    {id:'gaf',name:'GAF',color:'#d71920',tagline:'Timberline',logo:'/images/brands/roofing/gaf.svg',lines:[
      line('lib-shingle-gaf-ns','GAF Timberline NS','architectural',38,'default'),line('lib-shingle-gaf-hdz','GAF Timberline HDZ','architectural',41,'default'),line('lib-shingle-gaf-uhdz','GAF Timberline UHDZ','premium_architectural',55,'default'),
      line('lib-shingle-gaf-grand-sequoia','GAF Grand Sequoia','designer',54,'default',{reveals_starter:true}),line('lib-shingle-gaf-royal-sovereign','GAF Royal Sovereign','3_tab',33,'visible'),line('lib-shingle-gaf-hdz-rs','GAF Timberline HDZ RS Reflector','architectural',45,'more')],
      accessories:[accessory('lib-starter-gaf-prostart','GAF Pro-Start','starter',55),accessory('lib-starter-gaf-startermatch','GAF StarterMatch','starter',62,{colored_starter:true})]},
    {id:'owens_corning',name:'Owens Corning',color:'#de222c',tagline:'Duration',lines:[line('lib-shingle-oc-duration','Owens Corning TruDefinition Duration','architectural',43,'default'),line('lib-shingle-oc-supreme','Owens Corning Supreme','3_tab',33,'visible')],accessories:[]},
    {id:'malarkey',name:'Malarkey',color:'#1f6f43',tagline:'Vista',logo:'/images/brands/roofing/missing.png',lines:[line('lib-shingle-malarkey-vista','Malarkey Vista','impact_rated',44,'default')],accessories:[]},
    {id:'certainteed',name:'CertainTeed',color:'#0a5aa5',tagline:'Landmark',lines:[line('lib-shingle-ct-landmark','CertainTeed Landmark','architectural',44,'default')],accessories:[]},
    ...['IKO','Atlas','TAMKO','PABCO'].map(name=>({id:name.toLowerCase(),name,color:'#344054',tagline:'',lines:[line(`lib-shingle-${name.toLowerCase()}`,`${name} Architectural`,'architectural',40,'default')],accessories:[]}))],
  generic:[{id:'lib-drip-edge-alum-white',name:'Drip edge',kind:'generic',role:'flashing',unit:'pc',price:9,rule:'drip_edge'},{id:'lib-coil-nails-1.25',name:'Coil nails',kind:'generic',role:'fasteners',unit:'box',price:50,rule:'roofing_nails'}],
  labor:[{id:'labor-tearoff-layer1',name:'Tear-off',kind:'labor',role:'labor',unit:'sq',price:125,rule:'tear_off'}],
  materials:[
    {key:'shingles',label:'Architectural shingles',group:'Roof covering',source:'report',can_report:true,terms:[{measurement:'roof.squares',label:'Roof squares',unit:'roofing_square',factor:1},{measurement:'roof.flat_squares',label:'Flat roof squares',unit:'roofing_square',factor:-1}],waste:'roof',package:{unit:'bundle',coverage:0.3333},explanation:''},
    {key:'starter',label:'Starter strip',group:'Edges and ridges',source:'report',can_report:true,terms:[{measurement:'roof.eave_length',label:'Eaves',unit:'ft',factor:1},{measurement:'roof.rake_length',label:'Rakes',unit:'ft',factor:1}],waste:5,package:{unit:'bundle',coverage:120},explanation:'',reveal_note:true},
    {key:'ice_water',label:'Ice and water shield',group:'Underlayment',source:'report',can_report:true,terms:[{measurement:'roof.eave_length',label:'Eaves',unit:'ft',factor:2},{measurement:'roof.valley_length',label:'Valleys',unit:'ft',factor:1}],waste:10,package:{unit:'roll',coverage:66.67},explanation:'',eave_width:true},
    {key:'pipe_boots',label:'Pipe boots',group:'penetrations',source:'hand',can_report:false,terms:[],waste:0,package:null,explanation:'Every plumbing vent pipe gets a new boot. Count them on the roof report.'},
    {key:'decking_allowance',label:'Decking replacement',group:'decking',source:'hand',can_report:false,terms:[],waste:0,package:null,explanation:'An allowance written into the contract.'}],
  ice_eave_width:{default:6,options:[6,3,0]},
  suppliers:[{id:'abc_supply',name:'ABC Supply',kind:'distributor',color:'#C8102E',manufacturers:['gaf','owens_corning','certainteed'],line_scope:'full_range',regions:'United States',prices:{}},
    {id:'home_depot',name:'The Home Depot',kind:'big_box',color:'#F96302',manufacturers:['gaf','owens_corning'],line_scope:'retail_core',regions:'United States and Canada',prices:{'lib-shingle-gaf-hdz':37.98}},
    {id:'lowes',name:'Lowes',kind:'big_box',color:'#004990',manufacturers:['gaf'],line_scope:'retail_core',regions:'United States',prices:{}},
    {id:'convoy_supply',name:'Convoy Supply',kind:'distributor',color:'#D2232A',manufacturers:['gaf','malarkey'],line_scope:'full_range',regions:'Pacific Northwest',prices:{}}]};
const SETUP={id:'materials.pricebook_setup.roofing',version:1,kind:'agentic',scope:'organization',title:t('gx_mps_title','Set up your price book'),tab:'project.materials',replayable:false,variant:{id:'agentic',bucket:0.4,unit:'organization:o'},
  triggers:[{kind:'before_action',action:'materials.generate',selector:'[data-mt-generate-materials],[data-mt-generate-column]',once:true}],
  steps:[
    {id:'brands',widget:'brand-cards',title:t('gx_mps_brands_title','Which shingle manufacturers do you use?'),subtitle:t('gx_mps_brands_subtitle','Pick every brand you install.'),say:[t('gx_a','Let’s set up your price book.'),t('gx_b','Which shingle manufacturers do you use?')],options:{...OPTIONS,allow_all:true},required:true},
    {id:'lines',widget:'product-lines',title:t('gx_mps_lines_title','What shingles do you usually use?'),subtitle:t('gx_mps_lines_subtitle','Tick the lines you install.'),say:[t('gx_c','Here are the lines.')],options:{...OPTIONS,allow_all:true},required:true},
    {id:'rules',widget:'measurement-rules',title:t('gx_mps_rules_title','How a roof becomes a materials list'),subtitle:t('gx_mps_rules_subtitle','Each material comes from the measurement report.'),say:[t('gx_d','Here is how each material is worked out.')],options:OPTIONS,required:false},
    {id:'suppliers',widget:'supplier-columns',title:t('gx_mps_suppliers_title','Who provides your materials?'),subtitle:t('gx_su','Pick every supplier you buy from.'),say:[t('gx_sv','Who do you buy from?'),t('gx_mps_price_sheet_say','If you have a price sheet from your supplier, you can upload it here and I’ll set it up for you.')],
      upload:{line:'gx_mps_price_sheet_say',button:t('gx_mps_price_sheet_button','Upload a price sheet'),message:t('gx_mps_price_sheet_message','Here’s my supplier price sheet. Please update my material prices from it.'),accept:'.csv,.xlsx,.xls,.pdf,.txt'},options:OPTIONS,required:false},
    {id:'labor_prices',widget:'price-review',title:t('gx_mps_labor_prices_title','Check your labor prices'),subtitle:t('gx_l','Optional.'),say:[t('gx_g','Optional: typical labor rates.')],options:{...OPTIONS,kinds:['labor'],optional:true,skip_sets:{include_labor:false}},required:false}],
  completion:{action:{id:'pricebook.setup.apply',target:'organization',input:{trade:'roofing'}},say:[t('gx_f','Your price book is ready.')],then:[{handoff:'assistant_tray'},{resume:true},{play:'materials.tab_tutorial'}]},progress:null};
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
    if(url.endsWith('/gaf.svg'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#d71920"/></svg>'});
    if(url.includes('/images/'))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:'text/html',body:'<html></html>'});});
  await page.goto('https://fm.test/portal/');
  await page.setContent(`<style>body{margin:0;font:14px Arial}#rOverlay{position:fixed;inset:0;display:flex;flex-direction:column}.fm-project-tray-tabs{display:flex;justify-content:flex-end}.fm-project-content{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 0px;transition:grid-template-columns .32s cubic-bezier(.22,1,.36,1);min-height:0}.fm-project-content[data-tray-open=true]{grid-template-columns:minmax(0,1fr) min(380px,45%)}.fm-project-tray{min-width:0;overflow:hidden;display:flex;flex-direction:column;min-height:0}.mt-resource-column{flex:1 1 auto!important}.mt{padding:20px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.mt-resource-column{width:260px;height:200px;border:1px solid #ccc;border-radius:8px}</style>
    <div id="rOverlay"><nav class="fm-project-tray-tabs"><button type="button" data-tray="agent" aria-selected="false">Agent</button></nav>
    <div class="fm-project-content"><div class="mt"><button type="button" data-mt-generate-materials>Generate</button><div class="mt-resource-column">Materials</div><button data-mt-open-pricebook>Price book</button></div><aside class="fm-project-tray"></aside></div></div>
    <div class="fma-drawer" id="faqHost"><div data-fma="composer"><div class="fma-compose-shell"><textarea></textarea></div></div></div><main class="main"><div id="mainPanels"></div></main>`);
  await page.evaluate(({SETUP,TOUR,FAQS})=>{
    window.__APP={userOrgId:'o',platformApiBase:'http://fm.test/v1/platform'};
    window.route={project:'p1',projectTab:'materials'};
    window.Portal={navigation:{read:()=>window.route},can:()=>true,tabs:{activateTab(){}},util:{currentBranchId:()=>'default'}};
    window.calls=[];window.generated=0;window.trayOpened=0;
    document.querySelector('[data-mt-generate-materials]').addEventListener('click',()=>{window.generated++;});
    // As project-trays.js: the tab opens the tray's space (a grid column) and mounts the real assistant on the project conversation.
    document.querySelector('[data-tray=agent]').addEventListener('click',e=>{window.trayOpened++;e.currentTarget.setAttribute('aria-selected','true');const content=document.querySelector('.fm-project-content');content.dataset.trayOpen='true';if(!window.tray)window.tray=PlatformAssistant.mountProject(document.querySelector('.fm-project-tray'),{projectId:'p1'});});
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
    // The setup saves its draft through the completion action before a price sheet goes to the agent.
    window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{window.calls.push({path:'invoke',action,target,input});return {value:{suppliers:(input.suppliers||[]).map((entry,i)=>({id:'sup_'+i,name:entry.name}))}};}}};
    window.thread=[];const projectThread={id:'thread_1',subject_id:'project:p1'};
    window.AssistantAPI={upload:async(org,thread,file)=>({attachment:{media_id:'media_'+file.name,file_name:file.name}}),context:async()=>({main_thread:{id:'main',subject_id:'main'},threads:[],agents:[],dashboard:[]}),projectConversation:async()=>({thread:projectThread}),thread:async()=>({thread:projectThread,messages:window.thread.slice()}),
      send:async(org,thread,body)=>{window.calls.push({path:'assistant',thread,body});const reply={id:'r'+window.thread.length,role:'assistant',content:'Architectural shingles are the thicker, layered kind.'};window.thread.push({id:'u'+window.thread.length,role:'user',content:body.message},reply);return {thread:projectThread,assistant_message:reply};}};
  },{SETUP,TOUR,FAQS});
  for(const content of sources.assistant)await page.addScriptTag({content});
  await page.addScriptTag({content:sources.core});
  await page.addScriptTag({content:sources.setup});
  await page.addScriptTag({content:sources.suppliers});
  await page.waitForFunction(()=>window.FirstMateGuides?.experiences().length===2);
  return {page,errors};
}
// GX_SHOTS=<dir> saves screenshots of each stage for a visual check.
const shot=(page,name)=>process.env.GX_SHOTS?page.screenshot({path:`${process.env.GX_SHOTS}/${name}.png`}):null;
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

const heading=page=>page.evaluate(()=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.childNodes[0]?.textContent?.trim()||document.querySelector('.gxs-step:not(.gxs-above) h2')?.textContent);
const onStep=(page,title)=>page.waitForFunction(title=>{const h=document.querySelector('.gxs-step:not(.gxs-above) h2');return (h?.childNodes[0]?.textContent||'').trim()===title;},title);
const press=async page=>{await page.waitForTimeout(300);await page.click('[data-gxs=next]');};

test('the setup: logo grid, lines in tiers, materials list, costs and a price sheet, then a smooth hand-off to the tray and the tour',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs[data-kind=agentic] .gxs-sheet');
    assert.equal(await page.evaluate(()=>window.generated),0,'the click is held while the setup plays');
    assert.equal(await page.locator('.gxs').getAttribute('data-fmr-ignore'),'');
    // The agent is the platform assistant, saying the step's lines.
    await page.waitForFunction(()=>[...document.querySelectorAll('.gxs-assistant .fma-msg.assistant')].some(el=>/Which shingle manufacturers/.test(el.textContent)));
    // A compact header: the title, with its explanation in a tooltip rather than a paragraph.
    assert.equal(await page.locator('.gxs-step .gxs-sub').count(),0);
    assert.equal(await page.locator('.gxs-step h2 [data-gxs-info]').getAttribute('aria-label'),'Pick every brand you install.');
    await page.waitForTimeout(600);
    await page.hover('.gxs-step h2 [data-gxs-info]');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.gxs-info-tip')).opacity==='1');
    // One close, top right of the whole sheet.
    assert.equal(await page.locator('[data-gxs=close]').count(),1);
    // Logos only: eight compact tiles, no text or border, all visible without scrolling; the wordmark when a logo is missing.
    assert.equal(await page.locator('.gxs-logo-tile').count(),8);
    await page.waitForFunction(()=>document.querySelector('[data-brand=gaf] img')?.naturalWidth>0);
    await page.waitForFunction(()=>document.querySelector('[data-brand=malarkey] .gxs-wordmark')?.textContent==='Malarkey');
    const tiles=await page.evaluate(()=>{const stage=document.querySelector('.gxs-step:not(.gxs-above)');const all=[...document.querySelectorAll('.gxs-logo-tile')];return {fits:stage.scrollHeight<=stage.clientHeight+1,text:all.filter(t=>t.querySelector('img')).map(t=>t.innerText.replace(/✓/g,'').trim()).join(''),border:getComputedStyle(all[0]).borderTopWidth,heights:[...new Set(all.map(t=>Math.round(t.getBoundingClientRect().height)))]};});
    assert.equal(tiles.fits,true,'all eight fit without scrolling');
    assert.equal(tiles.text,'','no text beside the logos');
    assert.equal(tiles.border,'0px');
    assert.equal(tiles.heights.length,1);
    // The logo fills the tile: a square logo is most of its height.
    const logo=await page.evaluate(()=>{const tile=document.querySelector('[data-brand=gaf]'),img=tile.querySelector('img');return {img:img.getBoundingClientRect().height,tile:tile.getBoundingClientRect().height};});
    assert.ok(logo.img>=90&&logo.img>=logo.tile*0.7,`logo ${logo.img}px in a ${logo.tile}px tile`);
    assert.equal(await page.locator('[data-gxs=next]').isDisabled(),true,'a brand is needed first');
    await page.click('[data-brand=gaf]');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-brand=gaf] .gxs-badge-check')).opacity==='1');
    await page.click('[data-brand=owens_corning]');
    await shot(page,'1-logos');
    await press(page);
    await onStep(page,'What shingles do you usually use?');
    // Two columns; the usual lines ticked, the common rest shown, specialty lines behind More; a search across all.
    const columns=await page.evaluate(()=>new Set([...document.querySelectorAll('.gxs-cols>section')].map(s=>Math.round(s.getBoundingClientRect().left))).size);
    assert.equal(columns,2,'two columns');
    const ticked=await page.evaluate(()=>[...document.querySelectorAll('.gxs-line[aria-checked=true] strong')].map(s=>s.textContent));
    assert.deepEqual(ticked,['Timberline NS','Timberline HDZ','Timberline UHDZ','Grand Sequoia','TruDefinition Duration']);
    assert.equal(await page.locator('[data-line="lib-shingle-gaf-royal-sovereign"]').getAttribute('aria-checked'),'false','visible but off');
    assert.equal(await page.locator('[data-line="lib-shingle-gaf-hdz-rs"]').count(),0,'Reflector is behind More');
    await page.click('[data-more=gaf]');
    assert.equal(await page.locator('[data-line="lib-shingle-gaf-hdz-rs"]').getAttribute('aria-checked'),'false');
    await page.fill('.gxs-search','supreme');
    assert.deepEqual(await page.locator('.gxs-line strong').allInnerTexts(),['Supreme']);
    await page.fill('.gxs-search','');
    await page.click('[data-star="lib-shingle-gaf-grand-sequoia"]');
    await shot(page,'2-lines');
    // Typing hands this turn to the real model.
    await page.fill('.gxs-assistant [data-fma=input]','What is an architectural shingle?');
    await page.click('.gxs-assistant [data-fma=send]');
    await page.waitForFunction(()=>document.querySelector('.gxs-assistant .fma-msgs')?.innerText.includes('thicker, layered'));
    await page.waitForFunction(()=>document.querySelector('.gxs-assistant .fma-msgs').innerText.includes('carry on with the step'));
    await press(page);
    await onStep(page,'How a roof becomes a materials list');
    // One row per material and where its amount comes from.
    const rows=await page.evaluate(()=>[...document.querySelectorAll('.gxs-mat')].map(row=>[row.querySelector('strong').textContent,row.querySelector('.gxs-source').textContent]));
    assert.equal(await page.evaluate(()=>new Set([...document.querySelectorAll('.gxs-mat')].map(row=>Math.round(row.getBoundingClientRect().left))).size),2,'two columns');
    assert.deepEqual(rows,[['Architectural shingles','From measurement report'],['Starter strip','From measurement report'],['Ice and water shield','From measurement report'],['Pipe boots','Entered by hand'],['Decking replacement','Entered by hand']]);
    // Hover: the rule in plain words, never a sample roof's amount.
    await page.hover('[data-mat=shingles] [data-mat-toggle]');
    await page.waitForFunction(()=>document.querySelector('.gxs-tip')?.dataset.show==='true');
    const plain=await page.locator('.gxs-tip').innerText();
    assert.match(plain,/3 bundles for every square of roof steeper than 2\/12, plus waste from the measurement report\./);
    assert.doesNotMatch(plain,/28/);
    // Click to edit: waste from the report by default, or by hand.
    await page.click('[data-mat=starter] [data-mat-toggle]');
    await page.waitForSelector('[data-mat=starter][data-open=true] [data-plain]');
    assert.match(await page.locator('[data-mat=starter] [data-plain]').innerText(),/One bundle for every 120 ft of eaves plus rakes, plus 5% extra\. When the job.s shingle shows its starter course .* a coloured starter is used instead\./);
    await page.click('[data-mat=shingles] [data-mat-toggle]');
    assert.equal(await page.locator('[data-mat=shingles] [data-waste=roof]').getAttribute('aria-pressed'),'true','waste comes from the report by default');
    await page.fill('[data-mat=shingles] [data-waste-input]','15');
    await page.locator('[data-mat=shingles] [data-waste-input]').dispatchEvent('change');
    assert.match(await page.locator('[data-mat=shingles] [data-plain]').innerText(),/plus 15% extra/);
    await page.click('[data-mat=ice_water] [data-mat-toggle]');
    await page.click('[data-mat=ice_water] [data-width="3"]');
    assert.match(await page.locator('[data-mat=ice_water] [data-plain]').innerText(),/3 ft up from eaves/);
    await page.click('[data-mat=pipe_boots] [data-mat-toggle]');
    assert.equal(await page.locator('[data-mat=pipe_boots] [data-source=report]').count(),0,'the report does not count pipe boots');
    await shot(page,'3-materials');
    await press(page);
    await onStep(page,'Who provides your materials?');
    // Researched suppliers as pills, your own as a tag; one brand-coloured column each, two at a time.
    assert.equal(await page.locator('.gxs-supplier-pill').count(),4);
    for(const id of ['home_depot','abc_supply','lowes'])await page.click(`[data-preset=${id}]`);
    await page.fill('.gxs-supplier-input','Smith Roofing Supply');
    await page.press('.gxs-supplier-input','Enter');
    await page.waitForTimeout(500);
    const cols=await page.evaluate(()=>{const view=document.querySelector('.gxsc-viewport').getBoundingClientRect();return [...document.querySelectorAll('.gxsc-col')].map(col=>{const r=col.getBoundingClientRect();return {name:col.querySelector('strong').textContent,accent:getComputedStyle(col).borderTopColor,inView:r.left>=view.left-1&&r.right<=view.right+1,carried:[...col.querySelectorAll('[data-carry]:checked')].map(box=>box.dataset.carry)};});});
    assert.deepEqual(cols.map(c=>c.name),['The Home Depot','ABC Supply','Lowes','Smith Roofing Supply']);
    assert.deepEqual(cols.map(c=>c.inView),[false,false,true,true],'two visible: the row slides to the one just added');
    assert.equal(cols[0].accent,'rgb(249, 99, 2)','Home Depot orange');
    assert.ok(cols[0].carried.includes('lib-shingle-gaf-hdz')&&cols[0].carried.includes('lib-shingle-oc-duration')&&cols[0].carried.includes('lib-drip-edge-alum-white'));
    assert.ok(!cols[0].carried.includes('lib-starter-gaf-startermatch')&&cols[1].carried.includes('lib-starter-gaf-startermatch'),'a big-box store: mainstream lines and plain accessories only');
    assert.ok(!cols[2].carried.includes('lib-shingle-oc-duration'),'this Lowes stocks GAF only');
    assert.deepEqual(cols[3].carried,[],'your own supplier starts empty');
    assert.equal(await page.locator('[data-supplier=home_depot] [data-cost="lib-shingle-gaf-hdz"]').inputValue(),'37.98','the price seen there');
    // A native scroller with arrows on the sides: each shows only while there is more that way, and follows the scroll.
    const nav=()=>page.evaluate(()=>{const v=document.querySelector('.gxsc-viewport'),r=v.getBoundingClientRect(),[prev,next]=['prev','next'].map(d=>document.querySelector(`.gxsc-arrow[data-dir=${d}]`));const box=b=>b.getBoundingClientRect();return {left:Math.round(v.scrollLeft),max:v.scrollWidth-v.clientWidth,overflow:getComputedStyle(v).overflowX,prev:prev.dataset.off!=='true',next:next.dataset.off!=='true',prevSide:box(prev).left<r.left+20,nextSide:box(next).right>r.right-20};});
    let at=await nav();
    assert.equal(at.overflow,'auto');
    assert.ok(at.left>=at.max-1&&at.max>0,'scrolled to the one just added');
    assert.deepEqual([at.prev,at.next],[true,false],'at the end only the left arrow');
    assert.ok(at.prevSide&&at.nextSide,'arrows on the left and right edges');
    await page.click('.gxsc-arrow[data-dir=prev]');await page.waitForTimeout(700);
    at=await nav();
    assert.ok(at.left>0&&at.left<at.max,'one column back');
    assert.deepEqual([at.prev,at.next],[true,true],'in the middle both arrows');
    // Scrolling by hand (a trackpad or shift-wheel) moves it too, and the arrows follow.
    await page.hover('.gxsc-viewport');
    await page.mouse.wheel(-2000,0);await page.waitForTimeout(700);
    at=await nav();
    assert.equal(at.left,0);
    assert.deepEqual([at.prev,at.next],[false,true],'at the start only the right arrow');
    await page.click('.gxsc-arrow[data-dir=next]');await page.waitForTimeout(700);
    const step=await page.evaluate(()=>{const c=document.querySelectorAll('.gxsc-col');return c[1].getBoundingClientRect().left-c[0].getBoundingClientRect().left;});
    assert.ok(Math.abs((await nav()).left-step)<=2,'one column at a time');
    await page.click('.gxsc-arrow[data-dir=prev]');await page.waitForTimeout(700);
    assert.equal((await nav()).left,0);
    // What a supplier carries can change.
    await page.uncheck('[data-supplier=home_depot] [data-carry="lib-shingle-gaf-hdz"]');
    // A supplier's price sheet goes to the agent with that supplier named, after the draft saves it.
    const [sheetChooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('[data-sheet=home_depot]')]);
    await sheetChooser.setFiles({name:'home-depot.csv',mimeType:'text/csv',buffer:Buffer.from('sku,description,price\n1001,Timberline UHDZ,51.00\n')});
    await page.waitForFunction(()=>window.calls.some(c=>c.path==='assistant'&&/The Home Depot/.test(c.body.message)));
    const toAgent=await page.evaluate(()=>window.calls.filter(c=>c.path==='assistant').at(-1));
    assert.match(toAgent.body.message,/The Home Depot \(supplier id sup_0\)/);
    assert.match(toAgent.body.message,/no markup/);
    assert.deepEqual(toAgent.body.attachments,['media_home-depot.csv']);
    const draft=await page.evaluate(()=>window.calls.find(c=>c.path==='invoke'));
    assert.equal(draft.action,'pricebook.setup.apply');
    assert.equal(draft.input.trade,'roofing');
    assert.deepEqual(draft.input.suppliers.map(entry=>entry.name),['The Home Depot','ABC Supply','Lowes','Smith Roofing Supply']);
    // Costs are typed per supplier; they become the price book costs.
    await page.fill('[data-supplier=home_depot] [data-cost="lib-shingle-gaf-uhdz"]','39.5');
    await page.locator('[data-supplier=home_depot] [data-cost="lib-shingle-gaf-uhdz"]').dispatchEvent('change');
    assert.equal(await page.locator('[data-markup]').count(),0,'no markup');
    // The general price sheet: the agent offers it in this step; the file goes to the model with the setup's message.
    await page.waitForSelector('.gxs-assistant [data-fma-upload]');
    assert.equal(await page.locator('.gxs-assistant .fma-msg.assistant',{hasText:/price sheet from your supplier/}).count(),1,'the agent offers it once');
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('.gxs-assistant [data-fma-upload]')]);
    await chooser.setFiles({name:'abc-supply.csv',mimeType:'text/csv',buffer:Buffer.from('sku,description,price\n0489180,Timberline HDZ,36.40\n')});
    await page.waitForFunction(()=>window.calls.some(c=>c.path==='assistant'&&/update my material prices/.test(c.body.message)));
    const sent=await page.evaluate(()=>window.calls.filter(c=>c.path==='assistant').at(-1));
    assert.deepEqual(sent.body.attachments,['media_abc-supply.csv'],'the file goes with it');
    assert.ok(await page.evaluate(()=>window.calls.some(c=>c.body?.type==='question'&&c.body.properties?.upload)));
    await shot(page,'4-suppliers');
    await press(page);
    await onStep(page,'Check your labor prices');
    await page.waitForTimeout(600);assert.deepEqual(await page.locator('.gxs-step:not(.gxs-above) .gxs-prices h3').allInnerTexts(),['LABOR AND SERVICES']);
    // The labor list uses the full width, and its explanation is a tooltip.
    const wide=await page.evaluate(()=>{const step=document.querySelector('.gxs-step:not(.gxs-above)'),body=step.querySelector('.gxs-body').getBoundingClientRect(),rows=step.querySelector('.gxs-price-rows').getBoundingClientRect();return {ratio:rows.width/body.width,sub:step.querySelectorAll('.gxs-sub').length,tip:!!step.querySelector('h2 [data-gxs-info] .gxs-info-tip')};});
    assert.ok(wide.ratio>0.95,`full width (${wide.ratio})`);
    assert.equal(wide.sub,0,'no wrapped subtitle');
    assert.equal(wide.tip,true);
    assert.equal(await page.locator('[data-gxs=skip]').isVisible(),true,'an optional page has a clear Skip');
    await page.waitForTimeout(300);
    // Record the hand-off frame by frame.
    await page.evaluate(()=>{
      window.frames=[];
      const tick=()=>{const card=document.querySelector('.gxs-flying'),scrim=document.querySelector('.gxs-scrim'),tray=document.querySelector('.fm-project-tray'),drawer=tray?.querySelector('.fma-drawer'),mt=document.querySelector('.mt-resource-column');
        window.frames.push({t:performance.now(),card:card?card.getBoundingClientRect().toJSON():null,cardOpacity:card?Number(getComputedStyle(card).opacity):null,scrim:scrim?.isConnected?Number(getComputedStyle(scrim).opacity):null,tray:tray.getBoundingClientRect().width,trayReady:!!(drawer&&drawer.getBoundingClientRect().width>0&&drawer.querySelector('.fma-msg')),content:mt.getBoundingClientRect().right,setup:!!document.querySelector('.gxs')});
        if(window.frames.length<400)requestAnimationFrame(tick);};
      requestAnimationFrame(tick);
    });
    await page.click('[data-gxs=next]');
    await page.waitForSelector('.gxs-done');
    const complete=await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/complete')));
    assert.deepEqual(complete.body.selections.brands,['gaf','owens_corning']);
    assert.equal(complete.body.selections.default_line,'lib-shingle-gaf-grand-sequoia');
    assert.equal(complete.body.selections.rules.shingles.waste,15);
    assert.equal(complete.body.selections.ice_eave_width,3);
    assert.equal(complete.body.selections.suppliers.find(entry=>entry.preset==='home_depot').prices['lib-shingle-gaf-uhdz'],39.5,'the cost typed for that supplier');
    assert.equal(complete.body.selections.markup,undefined,'no markup is sent');
    const depot=complete.body.selections.suppliers.find(entry=>entry.preset==='home_depot');
    assert.ok(depot&&!depot.item_ids.includes('lib-shingle-gaf-hdz')&&depot.item_ids.includes('lib-shingle-gaf-uhdz'),'the unticked item left that supplier');
    assert.deepEqual(complete.body.selections.suppliers.find(entry=>!entry.preset),{name:'Smith Roofing Supply',item_ids:[],prices:{}});
    await page.waitForFunction(()=>window.trayOpened===1,null,{timeout:8000});
    await page.waitForFunction(()=>!document.querySelector('.gxs')&&!document.querySelector('.gxs-flying'),null,{timeout:8000});
    await page.waitForTimeout(400);
    const frames=await page.evaluate(()=>window.frames);
    const moving=frames.filter(f=>f.card&&f.cardOpacity===1);
    assert.ok(moving.length>=8,`the card animates over several frames (${moving.length})`);
    const mono=(values,dir)=>values.every((v,i)=>i===0||(dir>0?v>=values[i-1]-0.5:v<=values[i-1]+0.5));
    assert.ok(mono(moving.map(f=>f.card.left+f.card.width),1)||mono(moving.map(f=>f.card.left),1),'the card moves one way');
    const scrims=frames.filter(f=>f.scrim!==null).map(f=>f.scrim);
    assert.ok(mono(scrims,-1),'the backdrop only fades');
    const trays=frames.map(f=>f.tray);
    assert.ok(mono(trays,1),'the tray only opens');
    const firstMove=frames.findIndex(f=>f.card),firstTray=frames.findIndex(f=>f.tray>0);
    assert.ok(Math.abs(firstMove-firstTray)<=2||Math.abs(frames[firstMove].t-frames[firstTray].t)<=50,`card and tray start together (${firstMove} vs ${firstTray}, ${Math.round(Math.abs(frames[firstMove].t-frames[firstTray].t))} ms)`);
    const settledCard=moving.at(-1),trayEnd=frames.findIndex(f=>f.tray>=Math.max(...trays)-0.5);
    assert.ok(Math.abs(frames.indexOf(settledCard)-trayEnd)<=4,'they end together');
    assert.ok(frames.every(f=>f.card||f.trayReady||!f.setup&&f.trayReady||f.setup&&!f.card&&frames.indexOf(f)<firstMove),'no frame where the card has gone before the tray shows the conversation');
    const after=frames.filter(f=>!f.card&&!f.setup).map(f=>f.content);
    assert.ok(after.length&&after.every(v=>Math.abs(v-after[0])<1),'the project content does not jump once it ends');
    // The tray holds the same conversation.
    assert.match(await page.locator('.fm-project-tray .fma-msgs').innerText(),/Your price book is ready\./);
    await page.waitForFunction(()=>window.generated===1,null,{timeout:4000});
    await page.waitForSelector('.gx-pop',{timeout:6000});
    assert.equal(await page.locator('.gx-pop h3').innerText(),'Welcome to Materials');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('rapid Continue and Back never leave more than one step on screen',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs-logo-tile');
    await page.click('[data-brand=gaf]');
    await page.waitForTimeout(300);
    // Ten presses in well under a second, Continue and Back mixed, as a person hammering the buttons.
    const took=await page.evaluate(async()=>{const t0=performance.now();for(let i=0;i<10;i++){document.querySelector(i%3===2?'[data-gxs=back]':'[data-gxs=next]')?.click();await new Promise(r=>setTimeout(r,60));}return performance.now()-t0;});
    assert.ok(took<1000,`ten presses in ${Math.round(took)} ms`);
    assert.ok(await page.evaluate(()=>document.querySelectorAll('.gxs-step').length)<=2,'at most the one leaving and the one arriving');
    await page.waitForTimeout(700);
    const panes=await page.evaluate(()=>[...document.querySelectorAll('.gxs-step')].map(el=>({title:el.querySelector('h2')?.childNodes[0]?.textContent?.trim(),visible:el.getBoundingClientRect().height>0&&getComputedStyle(el).opacity==='1'})));
    assert.equal(panes.length,1,`exactly one step: ${JSON.stringify(panes)}`);
    assert.equal(panes[0].visible,true);
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.gxs-step h2').length),1,'one title on screen');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the X asks in a dialog over the setup: Keep going returns to the same step, Skip setup closes it',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs-logo-tile');
    await page.click('[data-brand=gaf]');
    await press(page);
    await onStep(page,'What shingles do you usually use?');
    await page.waitForTimeout(500);
    const footer=await page.locator('.gxs-foot').innerText();
    await page.click('[data-gxs=close]');
    await page.waitForSelector('.gxs-sheet .gxs-ask .gxs-ask-box[role=alertdialog]');
    assert.equal(await page.locator('.gxs-ask h3').innerText(),'Skip setup for now?');
    assert.match(await page.locator('.gxs-ask p').innerText(),/Materials settings/);
    assert.equal(await page.locator('.gxs-foot').innerText(),footer,'the footer does not change');
    await page.waitForTimeout(250);
    const placed=await page.evaluate(()=>{const s=document.querySelector('.gxs-sheet').getBoundingClientRect(),b=document.querySelector('.gxs-ask-box').getBoundingClientRect(),scrim=document.querySelector('.gxs-ask-scrim').getBoundingClientRect();return {dx:Math.abs((b.left+b.right)/2-(s.left+s.right)/2),dy:Math.abs((b.top+b.bottom)/2-(s.top+s.bottom)/2),covers:scrim.width>=s.width-1&&scrim.height>=s.height-1,focus:document.activeElement?.textContent?.trim()};});
    assert.ok(placed.dx<2&&placed.dy<2,'centred on the setup');
    assert.ok(placed.covers,'the dim covers the setup');
    assert.equal(placed.focus,'Keep going','Keep going is focused');
    // Keep going, Escape and a click on the dim each return to the same step.
    await page.click('.gxs-ask-box [data-gxs=keep]');
    await page.waitForFunction(()=>!document.querySelector('.gxs-ask'));
    assert.equal(await heading(page),'What shingles do you usually use?');
    await page.click('[data-gxs=close]');await page.waitForSelector('.gxs-ask-box');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('.gxs-ask'));
    await page.click('[data-gxs=close]');await page.waitForSelector('.gxs-ask-box');
    const sheet=await page.locator('.gxs-sheet').boundingBox();
    await page.mouse.click(sheet.x+24,sheet.y+sheet.height-24);
    await page.waitForFunction(()=>!document.querySelector('.gxs-ask'));
    assert.equal(await heading(page),'What shingles do you usually use?');
    assert.ok(await page.locator('.gxs').isVisible());
    await page.click('[data-gxs=close]');await page.waitForSelector('.gxs-ask-box');
    await page.click('.gxs-ask-box [data-gxs=dismiss]');
    await page.waitForFunction(()=>!document.querySelector('.gxs'));
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.body?.type==='dismiss').length),1);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the labor page can be skipped, which leaves labor out',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs-logo-tile');
    await page.click('[data-brand=gaf]');
    for(const title of ['What shingles do you usually use?','How a roof becomes a materials list','Who provides your materials?']){await press(page);await onStep(page,title);}
    await press(page);
    await onStep(page,'Check your labor prices');
    assert.equal(await page.locator('[data-gxs=next]').innerText(),'Build my price book');
    await page.waitForTimeout(300);
    await page.click('[data-gxs=skip]');
    await page.waitForSelector('.gxs-done');
    assert.equal((await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/complete')))).body.selections.include_labor,false,'skipped: no labor lines');
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
    // At phone width the dialog fits the screen, its two buttons side by side.
    await page.waitForSelector('.gxs-ask-box');
    const [keep,skip]=await page.locator('.gxs-ask-actions > button').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON()));
    assert.ok(Math.abs(keep.top-skip.top)<=2,'buttons together');
    assert.ok(skip.right<=390&&keep.left>=0,'nothing runs off the screen');
    await shot(page,'7b-phone-skip');
    await page.click('[data-gxs=dismiss]');
    await page.waitForFunction(()=>!document.querySelector('.gxs'));
    await page.waitForFunction(()=>window.generated===1,null,{timeout:3000});
    assert.ok(await page.evaluate(()=>window.calls.some(c=>c.body?.type==='dismiss'&&c.path.includes('pricebook_setup'))),'skipping the setup is recorded and lets Generate run');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the first three questions show inline, with More at the end of their row, close above the composer',async()=>{
  const browser=await launch();
  try{
    for(const [viewport,host] of [[1280,380],[390,360]]){
      const {page,errors}=await load(browser,{width:viewport,height:780});
      await page.evaluate(host=>{const box=document.querySelector('#faqHost');box.style.cssText=`width:${host}px;position:fixed;right:0;bottom:0;background:#fff;padding:0 8px;box-sizing:border-box`;window.route={project:'p1',projectTab:'docs'};window.FirstMateGuides.attachAssistant(box,{getContext:()=>({tab:'docs'}),ask(){}});},host);
      await page.waitForSelector('#faqHost .gx-faq');
      await page.waitForTimeout(500);
      const box=await page.evaluate(()=>{const strip=document.querySelector('#faqHost .gx-faqs'),wrap=document.querySelector('#faqHost .gx-faqs-wrap'),r=strip.getBoundingClientRect();const shown=[...strip.querySelectorAll('.gx-faq:not([hidden])')];const more=strip.querySelector('.gx-faq-more').getBoundingClientRect();const chip=shown[0].getBoundingClientRect();
        return {count:shown.length,first:shown[0].textContent,icon:!!shown[0].querySelector('.fa-circle-play'),height:r.height,chip:chip.height,moreRow:shown.some(c=>Math.abs(c.getBoundingClientRect().top-more.top)<2),sideways:strip.scrollWidth>strip.clientWidth+1,gap:wrap.nextElementSibling.getBoundingClientRect().top-r.bottom,label:strip.querySelector('.gx-faq-more').textContent,title:shown[1].title};});
      assert.equal(box.count,3,'three at once');
      assert.equal(box.first,'Show me the tutorial again');assert.ok(box.icon);
      assert.ok(box.moreRow,'More sits on a row with the questions, not on its own line');
      assert.ok(box.height<=box.chip*2+8,`about two rows (${box.height} for ${box.chip} chips)`);
      assert.ok(box.chip<=28,`compact chips (${box.chip})`);
      assert.equal(box.sideways,false);
      assert.ok(box.gap<=6,`close above the composer (${box.gap})`);
      assert.equal(box.title,'How do I make a proposal for this project?','a shortened question keeps its full text');
      await shot(page,`8-faqs-${host}`);
      const before=await page.evaluate(()=>document.querySelector('#faqHost .gx-faqs').getBoundingClientRect().height);
      await page.click('#faqHost .gx-faq-more');
      await page.waitForTimeout(400);
      const open=await page.evaluate(()=>({shown:document.querySelectorAll('#faqHost .gx-faq:not([hidden])').length,label:document.querySelector('#faqHost .gx-faq-more').textContent,height:document.querySelector('#faqHost .gx-faqs').getBoundingClientRect().height}));
      assert.equal(open.shown,7);assert.equal(open.label,'Less');assert.ok(open.height>before);
      assert.deepEqual(errors,[]);
      await page.close();
    }
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

test('the Materials settings mount: saved suppliers as columns, saved through the suppliers writer, with a price sheet each',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.evaluate(()=>{
      const host=document.createElement('div');host.id='tools';host.style.width='700px';document.body.appendChild(host);
      window.saves=[];window.sheets=[];
      const suppliers=[{id:'s1',name:'The Home Depot',revision:2,offerings:[{item_id:'i1',sku:'A',price_cents:3798},{item_id:'i2',sku:'',price_cents:null}]},{id:'s2',name:'Smith Roofing Supply',revision:1,offerings:[{item_id:'i2',sku:'',price_cents:4100}]},{id:'s3',name:'Convoy Supply',revision:1,offerings:[]}];
      window.MaterialsAPI={suppliers:{list:async()=>({suppliers:structuredClone(suppliers)}),save:async(org,id,input)=>{window.saves.push({org,id,input});return {supplier:{...suppliers.find(s=>s.id===id),...input,revision:9}};}}};
      window.PlatformAssistant.open=()=>{};window.PlatformAssistant.sendWithFiles=async(message,files)=>{window.sheets.push({message,files:files.map(f=>f.name)});};
      const pricebook={getState:()=>({items:[{id:'i1',name:'GAF Timberline HDZ',unit:'bundle',internal_cost:41,category:'Shingles'},{id:'i2',name:'Drip edge',unit:'pc',internal_cost:9,category:'Flashing'}]})};
      window.tools=window.FirstMateSupplierTools.mount(host,{orgId:'o',pricebook,toast(){},surface:'materials_settings',reload(){window.reloaded=(window.reloaded||0)+1;}});
    });
    await page.waitForSelector('#tools .gxsc-col');
    const cols=await page.evaluate(()=>[...document.querySelectorAll('#tools .gxsc-col')].map(col=>({name:col.querySelector('strong').textContent,accent:getComputedStyle(col).borderTopColor,carried:[...col.querySelectorAll('[data-carry]:checked')].map(b=>b.dataset.carry)})));
    assert.deepEqual(cols.map(c=>c.name),['The Home Depot','Smith Roofing Supply','Convoy Supply']);
    assert.equal(cols[0].accent,'rgb(249, 99, 2)');
    assert.deepEqual(cols.map(c=>c.carried),[['i2','i1'],['i2'],[]]);
    assert.equal(await page.locator('#tools [data-supplier=s1] [data-cost=i1]').inputValue(),'37.98','the saved cost');
    assert.equal(await page.locator('#tools .gxsc-arrow[data-dir=next]').getAttribute('data-off'),'false','three suppliers: an arrow to the third');
    await page.uncheck('#tools [data-supplier=s1] [data-carry=i2]');
    await page.fill('#tools [data-supplier=s1] [data-cost=i1]','36.5');
    await page.locator('#tools [data-supplier=s1] [data-cost=i1]').dispatchEvent('change');
    await page.waitForFunction(()=>window.saves.length>=1&&window.reloaded>=1,null,{timeout:4000});
    const saved=await page.evaluate(()=>window.saves.at(-1));
    assert.deepEqual(saved,{org:'o',id:'s1',input:{name:'The Home Depot',offerings:[{item_id:'i1',sku:'A',price_cents:3650}],expected_revision:2}});
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('#tools [data-sheet=s2]')]);
    await chooser.setFiles({name:'smith.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4')});
    await page.waitForFunction(()=>window.sheets.length===1);
    const sheet=await page.evaluate(()=>window.sheets[0]);
    assert.match(sheet.message,/Smith Roofing Supply \(supplier id s2\)/);
    assert.deepEqual(sheet.files,['smith.pdf']);
    await page.evaluate(()=>window.tools.destroy());
    assert.equal(await page.locator('#tools .gxsc-col').count(),0);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
