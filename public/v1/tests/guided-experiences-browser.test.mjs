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
const generic=(id,name,rule,price,extra={})=>({id,name,kind:'generic',role:'misc',unit:'ea',price,rule,...extra});
const system=(id,label,standard,parts)=>({id,label,components:standard+4,standard,parts});
// The setup's options as pricebook/setups/roofing.ts roofingSetupOptions gives them, cut down.
const OPTIONS={trade:'roofing',catalog:'research',region:{id:'south',label:'South'},regions:[{id:'national',label:'National average'},{id:'south',label:'South'}],
  roof_types:[{id:'shingle',label:'Shingle',catalog:true,systems:[]},{id:'shake',label:'Shake',catalog:false,systems:[system('wood_shake','Wood shake',10,['Shakes','Interlayment'])]},
    {id:'metal',label:'Metal',catalog:false,systems:[system('metal_standing_seam','Standing seam metal',19,['Standing seam panels','High-temperature synthetic underlayment','Standing seam clips']),system('metal_exposed_fastener','Exposed-fastener metal (corrugated / R-panel)',17,['Panels','Panel screws']),system('stone_coated_steel','Stone-coated steel',12,['Panels'])]},
    {id:'tile',label:'Tile',catalog:false,systems:[system('tile_concrete_clay','Concrete / clay tile',15,['Tiles'])]},{id:'slate',label:'Slate',catalog:false,systems:[system('slate','Slate',12,['Slate'])]},
    {id:'tpo',label:'TPO',catalog:false,low_slope:true,systems:[system('tpo','TPO',12,['TPO membrane'])]},{id:'pvc',label:'PVC',catalog:false,low_slope:true,systems:[system('pvc','PVC',11,['PVC membrane'])]},
    {id:'epdm',label:'EPDM',catalog:false,low_slope:true,systems:[system('epdm','EPDM',13,['EPDM membrane'])]},{id:'mod_bit',label:'Torch-down / modified bitumen',catalog:false,low_slope:true,systems:[system('modified_bitumen','Modified bitumen / torch-down',10,['Cap sheet','Base sheet'])]}],
  brands:[
    {id:'gaf',name:'GAF',color:'#d71920',tagline:'Timberline',logo:'/images/brands/roofing/gaf.svg',lines:[
      line('lib-shingle-gaf-ns','GAF Timberline NS','architectural',38,'default'),line('lib-shingle-gaf-hdz','GAF Timberline HDZ','architectural',41,'default',{flagship:true}),line('lib-shingle-gaf-uhdz','GAF Timberline UHDZ','premium_architectural',55,'default'),
      line('lib-shingle-gaf-grand-sequoia','GAF Grand Sequoia','designer',54,'default',{reveals_starter:true}),line('lib-shingle-gaf-royal-sovereign','GAF Royal Sovereign','3_tab',33,'visible'),line('lib-shingle-gaf-hdz-rs','GAF Timberline HDZ RS Reflector','architectural',45,'more')],
      accessories:[accessory('lib-starter-gaf-prostart','GAF Pro-Start','starter',55),accessory('lib-starter-gaf-startermatch','GAF StarterMatch','starter',62,{colored_starter:true}),
        accessory('lib-underlay-gaf-feltbuster','GAF FeltBuster Synthetic Underlayment','underlayment',119),accessory('lib-underlay-gaf-tiger-paw','GAF Tiger Paw Premium Synthetic Underlayment','underlayment',139,{setup_default:true}),
        accessory('lib-iws-gaf-weatherwatch','GAF WeatherWatch Mineral-Surfaced Leak Barrier','ice_water',99),accessory('lib-ridge-vent-cobra-rigid','GAF Cobra Rigid Vent 3 (4 ft)','ridge_vent',15),
        accessory('lib-intake-gaf-cobra-intakepro','GAF Cobra IntakePro Roof Deck Intake Vent (4 ft)','intake_vent',16,{provisional:true}),accessory('lib-boxvent-gaf-masterflow-slantback','GAF Master Flow Slant Back Roof Louver','box_vent',24,{provisional:true}),
        accessory('lib-boot-gaf-masterflow','GAF Master Flow Pipe Boot (1-1/2 to 3 in)','pipe_boot',14,{provisional:true}),accessory('lib-lowslope-gaf-everguard-tpo-60','GAF EverGuard TPO 60 mil membrane (10 x 100 ft)','low_slope_membrane',560,{system:'tpo',provisional:true})]},
    {id:'owens_corning',name:'Owens Corning',color:'#de222c',tagline:'Duration',lines:[line('lib-shingle-oc-duration','Owens Corning TruDefinition Duration','architectural',43,'default',{flagship:true}),line('lib-shingle-oc-supreme','Owens Corning Supreme','3_tab',33,'visible')],
      accessories:[accessory('lib-underlay-oc-proarmor','Owens Corning ProArmor Synthetic Underlayment','underlayment',125),accessory('lib-iws-oc-weatherlock-g','Owens Corning WeatherLock G Granulated Ice & Water Barrier','ice_water',105),accessory('lib-ridge-vent-oc-ventsure','Owens Corning VentSure 4 ft Strip Heat & Moisture Ridge Vent','ridge_vent',16)]},
    {id:'malarkey',name:'Malarkey',color:'#1f6f43',tagline:'Vista',logo:'/images/brands/roofing/missing.png',lines:[line('lib-shingle-malarkey-vista','Malarkey Vista','impact_rated',44,'default',{flagship:true})],accessories:[]},
    {id:'certainteed',name:'CertainTeed',color:'#0a5aa5',tagline:'Landmark',lines:[line('lib-shingle-ct-landmark','CertainTeed Landmark','architectural',44,'default',{flagship:true})],accessories:[]},
    ...['IKO','Atlas','TAMKO','PABCO'].map(name=>({id:name.toLowerCase(),name,color:'#344054',tagline:'',lines:[line(`lib-shingle-${name.toLowerCase()}`,`${name} Architectural`,'architectural',40,'default',{flagship:true})],accessories:[]}))],
  generic:[generic('lib-drip-edge-alum-white','Drip edge','drip_edge',9),generic('lib-coil-nails-1.25','Coil nails','roofing_nails',50),generic('lib-pipe-boot-1.5-3','Pipe boot 1-1/2 to 3 in (neoprene)','pipe_boots',9.85),
    generic('lib-pipe-boot-lead-3','Lead pipe boot (3 in)','pipe_boots',28,{setup_default:true,provisional:true}),generic('lib-boxvent-generic','Box vent, aluminum slant back (generic)','box_vents',18,{provisional:true}),generic('lib-intake-generic','Intake vent strip (generic, 4 ft)','intake_vent',12,{provisional:true})],
  labor:[{id:'labor-tearoff-layer1',name:'Tear-off',kind:'labor',role:'labor',unit:'sq',price:125,rule:'tear_off'}],
  low_slope:{tpo:{cap:{id:'rtc-tpo-membrane',name:'TPO membrane (60 mil)',kind:'component',unit:'roll'}},pvc:{cap:{id:'rtc-pvc-membrane',name:'PVC membrane (50 mil)',kind:'component',unit:'roll'}},epdm:{cap:{id:'rtc-epdm-membrane',name:'EPDM membrane (60 mil)',kind:'component',unit:'roll'}},
    mod_bit:{cap:{id:'rtc-modified-bitumen-cap-sheet',name:'Granulated cap sheet',kind:'component',unit:'roll'},base:{id:'rtc-modified-bitumen-base-sheet',name:'Base sheet',kind:'component',unit:'roll'}}},
  ice_coverage:{default:'perimeter_18_valleys',options:['perimeter_18_valleys','eaves_36_valleys','eaves_72_valleys','eaves_36','valleys','none']},
  suppliers:[{id:'abc_supply',name:'ABC Supply',kind:'distributor',color:'#C8102E',manufacturers:['gaf','owens_corning','certainteed'],line_scope:'full_range',regions:'United States',prices:{}},
    {id:'home_depot',name:'The Home Depot',kind:'big_box',color:'#F96302',manufacturers:['gaf','owens_corning'],line_scope:'retail_core',regions:'United States and Canada',prices:{'lib-shingle-gaf-hdz':37.98}},
    {id:'lowes',name:'Lowes',kind:'big_box',color:'#004990',manufacturers:['gaf'],line_scope:'retail_core',regions:'United States',prices:{}},
    {id:'convoy_supply',name:'Convoy Supply',kind:'distributor',color:'#D2232A',manufacturers:['gaf','malarkey'],line_scope:'full_range',regions:'Pacific Northwest',prices:{}}]};
// The labor step's options as labor/labor-setup.ts laborSetupOptions gives them.
const LABOR={assignees:[{ref:{type:'resource_group',id:'g1'},kind:'resource_group',name:'North crew',type_id:'crew',members:3,pay:{sheet_id:'s1',name:'North pay',lines:1,simple:{method:'hourly',rate:45}}},
    {ref:{type:'organization_connection',id:'c1'},kind:'organization_connection',name:'Summit Roofing',type_id:'work_provider',members:0,pay:{sheet_id:'s2',name:'Summit rates',lines:4,simple:null}}],
  group_types:[{id:'crew',name:'Crew'},{id:'install',name:'Install team'}],company_types:[{id:'work_provider',name:'Subcontractor'}],
  measurements:[{id:'roof.squares',label:'Roof squares',unit:'roofing_square'},{id:'roof.ridge_length',label:'Ridge length',unit:'ft'}],methods:['per_measurement','hourly','per_job']};
// The definition's steps (guided-experiences/definitions/materials.ts), with its branch after the roof types.
const SETUP={id:'materials.pricebook_setup.roofing',version:1,kind:'agentic',scope:'organization',title:t('gx_mps_title','Set up your price book'),tab:'project.materials',replayable:false,variant:{id:'agentic',bucket:0.4,unit:'organization:o'},
  triggers:[{kind:'before_action',action:'materials.generate',selector:'[data-mt-generate-materials],[data-mt-generate-column]',once:true}],
  steps:[
    {id:'roof_types',widget:'roof-types',title:t('gx_mps_types_title','What kinds of roofs do you install?'),subtitle:t('gx_mps_types_subtitle','Pick every kind you install.'),say:[t('gx_a','Let’s set up your price book.'),t('gx_b','What kinds of roofs do you install?')],options:OPTIONS,required:true,
      next:{branches:[{when:{field:'selections.roof_types',operator:'contains',value:'shingle'},to:'brands'}],otherwise:'material'}},
    {id:'brands',widget:'brand-cards',title:t('gx_mps_makers_title','What roofing manufacturers do you use?'),subtitle:t('gx_mps_makers_subtitle','Pick every brand you use.'),say:[t('gx_c','Which roofing manufacturers do you use?')],options:{...OPTIONS,allow_all:true},required:true},
    {id:'defaults',widget:'material-defaults',title:t('gx_mps_defaults_title','Set your default materials'),subtitle:t('gx_mps_defaults_subtitle','What a new materials list uses.'),say:[t('gx_d','Here’s what I’ll use by default.')],options:{...OPTIONS,skip_sets:{defaults:{}}},required:false,next:'suppliers'},
    {id:'material',widget:'default-material',title:t('gx_mps_material_title','What’s your default roofing material?'),subtitle:t('gx_mps_material_subtitle','A new materials list starts with this.'),say:[t('gx_e','Which of these do you install most?')],options:OPTIONS,required:true},
    {id:'suppliers',widget:'supplier-columns',title:t('gx_mps_suppliers_title','Who provides your materials?'),subtitle:t('gx_su','Pick every supplier you buy from.'),say:[t('gx_sv','Who do you buy from?'),t('gx_mps_price_sheet_say','If you have a price sheet from your supplier, you can upload it here and I’ll set it up for you.')],
      upload:{line:'gx_mps_price_sheet_say',button:t('gx_mps_price_sheet_button','Upload a price sheet'),message:t('gx_mps_price_sheet_message','Here’s my supplier price sheet. Please update my material prices from it.'),accept:'.csv,.xlsx,.xls,.pdf,.txt'},options:OPTIONS,required:false},
    {id:'labor',widget:'labor-assignees',title:t('gx_mps_labor_title','Who does your labor?'),subtitle:t('gx_lt','Add your groups and subcontractors, and how each is paid.'),say:[t('gx_ls','Who installs your roofs?')],options:{...LABOR,optional:true,skip_sets:{include_labor:false,labor:{assignees:[],skipped:true}}},required:false}],
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

// GX_SIZE=1600x1000 plays the walkthrough at another size (screenshots for review).
const [SIZE_W,SIZE_H]=(process.env.GX_SIZE||'1280x800').split('x').map(Number);
async function load(browser,{width=SIZE_W,height=SIZE_H,reduced=false}={}){
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
    // The organization's words (the terminology system): this one calls a group of users a crew.
    window.PlatformTerminology={get:(path,fallback)=>({'workforce.resource_group_singular':'Crew','workforce.organization_connection_singular':'Subcontractor'})[path]||fallback};
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
      // As the server: the step after the roof types is decided from the selections (service.ts nextStep).
      if(u.pathname.endsWith('/events')){if(body.type==='complete')progress[id]={status:'completed'};if(body.type==='dismiss')progress[id]={status:'dismissed'};if(body.type==='replay')progress[id]={status:'started'};
        const next=body.type==='step_done'&&body.step_id==='roof_types'?{next_step:(body.selections?.roof_types||[]).includes('shingle')?'brands':'material'}:{};return json({recorded:true,progress:progress[id]||null,...next});}
      if(u.pathname.endsWith('/complete')){progress[id]={status:'completed'};const shingle=(body.selections?.roof_types||[]).includes('shingle');return json({result:{items:2,default_line:'lib-shingle-oc-duration',item_ids:shingle?['lib-shingle-oc-duration','lib-shingle-gaf-hdz']:['rtc-metal-exposed-fastener-panels']},progress:progress[id]});}
      // The server stores the scripted turn in the person's project conversation.
      if(u.pathname.endsWith('/conversation')){const step=SETUP.steps.find(s=>s.id===body.step_id);if(body.choice)window.thread.push({id:'m'+window.thread.length,role:'user',content:body.choice,data:{source:'guided_experience'}});for(const line of (step?step.say:body.phase==='done'?SETUP.completion.say:[]))window.thread.push({id:'m'+window.thread.length,role:'assistant',content:line.text,data:{source:'guided_experience'}});return json({thread_id:'thread_1',messages:1});}
      return new Response('{}',{status:404});
    };
    // The setup saves its draft through the completion action before a price sheet goes to the agent.
    window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{window.calls.push({path:'invoke',action,target,input});return {value:{suppliers:(input.suppliers||[]).map((entry,i)=>({id:'sup_'+i,name:entry.name})),labor:{assignees:(input.labor?.assignees||[]).map(entry=>({ref:entry.ref||{type:entry.kind,id:'new_'+entry.name.split(' ')[0].toLowerCase()},name:entry.name,kind:entry.kind}))}}};}}};
    // The price book renderer, as Materials settings mounts it: a fresh read, then only the items the host lets through.
    window.pricebookItems=[{id:'lib-shingle-oc-duration',name:'Owens Corning TruDefinition Duration'},{id:'lib-shingle-gaf-hdz',name:'GAF Timberline HDZ'},{id:'roof_replacement',name:'Roof replacement'},{id:'lib-shingle-iko',name:'IKO Architectural'},{id:'rtc-metal-exposed-fastener-panels',name:'Exposed-fastener panels'}];
    window.FirstMatePricebook={loads:[],configure(){},loadState(force){this.loads.push(force);return new Promise(r=>setTimeout(r,120));},
      mount(el,opts){const shown=window.pricebookItems.filter(item=>!opts.itemFilter||opts.itemFilter(item));el.classList.add('pb-embed');el.innerHTML=`<div class="pb-win" style="display:flex;flex-direction:column"><div class="pb-top">Organization Price Book</div><ul class="pb-test">${shown.map(i=>`<li data-pb="${i.id}">${i.name}</li>`).join('')}</ul></div>`;return {destroy(){el.innerHTML='';}};}};
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

test('the shingle path: roof types, manufacturers in the order picked, defaults on one page, suppliers and labor, then the price book and a smooth hand-off',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs[data-kind=agentic] .gxs-sheet');
    assert.equal(await page.evaluate(()=>window.generated),0,'the click is held while the setup plays');
    assert.equal(await page.locator('.gxs').getAttribute('data-fmr-ignore'),'');
    // The agent is the platform assistant, saying the step's lines.
    await page.waitForFunction(()=>[...document.querySelectorAll('.gxs-assistant .fma-msg.assistant')].some(el=>/What kinds of roofs/.test(el.textContent)));
    // A compact header: the title, with its explanation in a tooltip rather than a paragraph.
    assert.equal(await page.locator('.gxs-step .gxs-sub').count(),0);
    assert.equal(await page.locator('.gxs-step h2 [data-gxs-info]').getAttribute('aria-label'),'Pick every kind you install.');
    await page.waitForTimeout(600);
    await page.hover('.gxs-step h2 [data-gxs-info]');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.gxs-info-tip')).opacity==='1');
    assert.equal(await page.locator('[data-gxs=close]').count(),1,'one close, top right of the whole sheet');
    // Nine kinds of roof, PVC apart from TPO, each a drawing and a name; all in view without scrolling.
    const types=await page.evaluate(()=>{const stage=document.querySelector('.gxs-step:not(.gxs-above)');const all=[...document.querySelectorAll('.gxs-type')];return {names:all.map(t=>t.querySelector('.gxs-type-name').textContent),fits:stage.scrollHeight<=stage.clientHeight+1,drawings:all.every(t=>t.querySelector('svg.gxs-swatch')),columns:new Set(all.map(t=>Math.round(t.getBoundingClientRect().left))).size,heights:new Set(all.map(t=>Math.round(t.getBoundingClientRect().height))).size,tip:all[2].title};});
    assert.deepEqual(types.names,['Shingle','Shake','Metal','Tile','Slate','TPO','PVC','EPDM','Torch-down / mod-bit']);
    assert.ok(types.fits&&types.drawings,'all nine fit, each with its drawing');
    assert.equal(types.columns,3);assert.equal(types.heights,1);
    assert.match(types.tip,/Standing seam/,'the kinds a choice covers are in its tooltip');
    assert.equal(await page.locator('[data-gxs=next]').isDisabled(),true,'a kind is needed first');
    assert.match(await page.locator('.gxs-next-wrap').getAttribute('title'),/at least one kind of roof/);
    await shot(page,'1a-roof-types');
    await page.click('[data-type=shingle]');
    await page.click('[data-type=metal]');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-type=metal] .gxs-badge-check')).opacity==='1');
    await page.waitForTimeout(300);
    await shot(page,'1-roof-types');
    await press(page);
    // Shingle is picked, so the server sends the setup to the manufacturers.
    await onStep(page,'What roofing manufacturers do you use?');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.gxs-progress li').length),5,'roof types, manufacturers, defaults, suppliers, labor');
    // Logos only: eight compact tiles, no text or border, all visible without scrolling; the wordmark when a logo is missing.
    assert.equal(await page.locator('.gxs-logo-tile').count(),8);
    await page.waitForFunction(()=>document.querySelector('[data-brand=gaf] img')?.naturalWidth>0);
    await page.waitForFunction(()=>document.querySelector('[data-brand=malarkey] .gxs-wordmark')?.textContent==='Malarkey');
    const tiles=await page.evaluate(()=>{const stage=document.querySelector('.gxs-step:not(.gxs-above)');const all=[...document.querySelectorAll('.gxs-logo-tile')];return {fits:stage.scrollHeight<=stage.clientHeight+1,text:all.filter(t=>t.querySelector('img')).map(t=>t.innerText.replace(/✓|\d/g,'').trim()).join(''),border:getComputedStyle(all[0]).borderTopWidth,heights:[...new Set(all.map(t=>Math.round(t.getBoundingClientRect().height)))]};});
    assert.equal(tiles.fits,true,'all eight fit without scrolling');
    assert.equal(tiles.text,'','no text beside the logos');
    assert.equal(tiles.border,'0px');
    assert.equal(tiles.heights.length,1);
    const logo=await page.evaluate(()=>{const tile=document.querySelector('[data-brand=gaf]'),img=tile.querySelector('img'),r=img.getBoundingClientRect(),t=tile.getBoundingClientRect();return {w:r.width,h:r.height,share:(r.width*r.height)/((t.width-28)*(t.height-28))};});
    assert.ok(logo.h>=80&&logo.w>=80,`logo ${logo.w}x${logo.h}`);
    assert.ok(logo.share>0.4&&logo.share<0.6,`a balanced share of the tile (${logo.share})`);
    assert.match(await page.locator('.gxs-next-wrap').getAttribute('title'),/Pick at least one manufacturer/);
    // In the order picked: the first one's badge says 1, as the defaults come from it.
    await page.click('[data-brand=owens_corning]');
    await page.click('[data-brand=gaf]');
    assert.deepEqual(await page.evaluate(()=>['owens_corning','gaf'].map(id=>document.querySelector(`[data-brand=${id}] .gxs-badge-check`).textContent)),['1','2']);
    await page.waitForTimeout(400);
    await shot(page,'2-manufacturers');
    await press(page);
    await onStep(page,'Set your default materials');
    await page.waitForTimeout(600);
    // One page: four groups in two columns, a compact row each, nothing to scroll.
    const page3=await page.evaluate(()=>{const stage=document.querySelector('.gxs-step:not(.gxs-above)');const sections=[...stage.querySelectorAll('.gxs-pd-section')];return {fits:stage.scrollHeight<=stage.clientHeight+1,groups:sections.map(s=>s.querySelector('h3').textContent),columns:new Set(sections.map(s=>Math.round(s.getBoundingClientRect().left))).size,rows:Math.max(...[...stage.querySelectorAll('.gxs-pd-row')].map(r=>Math.round(r.getBoundingClientRect().height))),waste:/waste|formula/i.test(stage.querySelector('.gxs-body').innerText)};});
    assert.deepEqual(page3.groups,['Shingle roof','Accessories','Ventilation','Low slope']);
    assert.equal(page3.columns,2);assert.ok(page3.fits,'fits without scrolling');
    assert.ok(page3.rows<=76,`compact rows: a label over its dropdown (${page3.rows})`);
    assert.equal(page3.waste,false,'no waste questions or formulas');
    // Preselected from the first brand picked that makes each; GAF fills what Owens Corning does not make.
    const values=()=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('[data-slot]')].map(s=>[s.dataset.slot,s.value])));
    assert.deepEqual(await values(),{shingle:'lib-shingle-oc-duration',underlayment:'lib-underlay-oc-proarmor',ice_water:'lib-iws-oc-weatherlock-g',ice_coverage:'perimeter_18_valleys',pipe_boot:'lib-pipe-boot-lead-3',
      ridge_vent:'lib-ridge-vent-oc-ventsure',intake_vent:'lib-intake-gaf-cobra-intakepro',box_vent:'lib-boxvent-gaf-masterflow-slantback',low_slope_system:'tpo',low_slope:'lib-lowslope-gaf-everguard-tpo-60'});
    // Each dropdown groups its products by maker, named without the maker.
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('[data-slot=underlayment] optgroup')].map(g=>[g.label,[...g.children].map(o=>o.textContent)])),[['Owens Corning',['ProArmor Synthetic Underlayment']],['GAF',['FeltBuster Synthetic Underlayment','Tiger Paw Premium Synthetic Underlayment']]]);
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('[data-slot=ice_coverage] option')].map(o=>o.textContent)),['18 in at eaves and rakes, plus valleys','36 in at the eaves, plus valleys','72 in at the eaves, plus valleys','36 in at the eaves only','Valleys only','None']);
    assert.equal(await page.locator('.gxs-pd-hand').count(),2,'pipe boots and box vents are entered by hand');
    assert.match(await page.locator('.gxs-pd-note').innerText(),/Starter strip, drip edge and hip and ridge cap follow your shingle/);
    // How each is worked out is a tooltip.
    await page.hover('.gxs-pd-row:has([data-slot=intake_vent]) .gxs-pd-info');
    await page.waitForFunction(()=>document.querySelector('.gxs-tip')?.dataset.show==='true');
    assert.match(await page.locator('.gxs-tip').innerText(),/along the eaves/);
    await page.mouse.move(5,5);
    await shot(page,'3a-defaults');
    await page.selectOption('[data-slot=underlayment]','lib-underlay-gaf-tiger-paw');
    await page.selectOption('[data-slot=ice_coverage]','eaves_36_valleys');
    await page.selectOption('[data-slot=low_slope_system]','mod_bit');
    assert.equal(await page.locator('[data-slot=low_slope]').inputValue(),'rtc-modified-bitumen-cap-sheet','no picked brand makes modified bitumen: the generic cap sheet');
    assert.match(await page.locator('.gxs-pd-row:has([data-slot=low_slope]) .gxs-pd-label').innerText(),/Cap sheet/);
    // Typing hands this turn to the real model.
    await page.fill('.gxs-assistant [data-fma=input]','What is a leak barrier?');
    await page.click('.gxs-assistant [data-fma=send]');
    await page.waitForFunction(()=>document.querySelector('.gxs-assistant .fma-msgs')?.innerText.includes('thicker, layered'));
    await page.waitForFunction(()=>document.querySelector('.gxs-assistant .fma-msgs').innerText.includes('carry on with the step'));
    await shot(page,'3-defaults');
    assert.equal(await page.locator('[data-gxs=skip]').isVisible(),true,'the defaults can be skipped');
    await press(page);
    await onStep(page,'Who provides your materials?');
    // Back returns along the way taken: defaults, not the default material the shingle path skipped.
    await page.waitForTimeout(400);
    await page.click('[data-gxs=back]');
    await onStep(page,'Set your default materials');
    assert.equal(await page.locator('[data-slot=underlayment]').inputValue(),'lib-underlay-gaf-tiger-paw','the choices are kept');
    await press(page);
    await onStep(page,'Who provides your materials?');
    // Researched suppliers as pills, your own as a tag; one brand-coloured column each, two at a time.
    assert.equal(await page.locator('.gxs-supplier-pill').count(),4);
    const empty=await page.evaluate(()=>{const box=document.querySelector('.gxs-supplier-empty').getBoundingClientRect(),body=document.querySelector('.gxs-step:not(.gxs-above) .gxs-body').getBoundingClientRect();return {height:box.height,gapBelow:body.bottom-box.bottom,icon:!!document.querySelector('.gxs-supplier-empty .gxs-empty-icon')};});
    assert.ok(empty.height>200&&empty.gapBelow<30&&empty.icon,`an empty state that fills the column area (${JSON.stringify(empty)})`);
    await page.waitForTimeout(300);await shot(page,'4a-suppliers-empty');
    for(const id of ['home_depot','abc_supply','lowes'])await page.click(`[data-preset=${id}]`);
    await page.fill('.gxs-supplier-input','Smith Roofing Supply');
    await page.press('.gxs-supplier-input','Enter');
    await page.waitForTimeout(500);
    const cols=await page.evaluate(()=>{const view=document.querySelector('.gxsc-viewport').getBoundingClientRect();return [...document.querySelectorAll('.gxsc-col')].map(col=>{const r=col.getBoundingClientRect();return {name:col.querySelector('strong').textContent,accent:getComputedStyle(col).borderTopColor,inView:r.left>=view.left-1&&r.right<=view.right+1,carried:[...col.querySelectorAll('[data-carry]:checked')].map(box=>box.dataset.carry),groups:[...col.querySelectorAll('.gxsc-group')].map(g=>g.textContent)};});});
    assert.deepEqual(cols.map(c=>c.name),['The Home Depot','ABC Supply','Lowes','Smith Roofing Supply']);
    assert.deepEqual(cols.map(c=>c.inView),[true,true,false,false],'two visible, from the first: adding one does not scroll the first away');
    assert.equal(cols[0].accent,'rgb(249, 99, 2)','Home Depot orange');
    assert.deepEqual(cols[1].groups,['Owens Corning','GAF','Common items'],'every product of the picked brands, by brand, in the order picked');
    assert.ok(cols[0].carried.includes('lib-shingle-gaf-hdz')&&cols[0].carried.includes('lib-shingle-oc-duration')&&cols[0].carried.includes('lib-drip-edge-alum-white'));
    assert.ok(!cols[0].carried.includes('lib-starter-gaf-startermatch')&&cols[1].carried.includes('lib-starter-gaf-startermatch'),'a big-box store: mainstream lines and plain accessories only');
    assert.ok(!cols[0].carried.includes('lib-shingle-gaf-royal-sovereign'),'and only the usual lines');
    assert.ok(!cols[2].carried.includes('lib-shingle-oc-duration'),'this Lowes stocks GAF only');
    assert.deepEqual(cols[3].carried,[],'your own supplier starts empty');
    assert.equal(await page.locator('[data-supplier=home_depot] [data-cost="lib-shingle-gaf-hdz"]').inputValue(),'37.98','the price seen there');
    const name=await page.evaluate(()=>{const span=document.querySelector('[data-supplier=abc_supply] .gxsc-item span');const style=getComputedStyle(span);return {title:span.title,clamp:style.webkitLineClamp,price:document.querySelector('[data-supplier=abc_supply] .gxsc-price').getBoundingClientRect().width};});
    assert.equal(name.clamp,'2','names get two lines before they are cut');
    assert.match(name.title,/^Owens Corning /,'the full name in a tooltip');
    assert.ok(name.price<=110,`a price field sized for $ 999.99 and its unit (${name.price})`);
    // A native scroller with arrows on the sides: each shows only while there is more that way, and follows the scroll.
    const nav=()=>page.evaluate(()=>{const v=document.querySelector('.gxsc-viewport'),r=v.getBoundingClientRect(),[prev,next]=['prev','next'].map(d=>document.querySelector(`.gxsc-arrow[data-dir=${d}]`));const box=b=>b.getBoundingClientRect();return {left:Math.round(v.scrollLeft),max:v.scrollWidth-v.clientWidth,overflow:getComputedStyle(v).overflowX,prev:prev.dataset.off!=='true',next:next.dataset.off!=='true',prevCount:prev.querySelector('b').textContent,nextCount:next.querySelector('b').textContent,prevSide:box(prev).right<=r.left+1,nextSide:box(next).left>=r.right-1};});
    let at=await nav();
    assert.equal(at.overflow,'auto');
    assert.equal(at.left,0,'the first supplier stays in view');
    assert.deepEqual([at.prev,at.next],[false,true],'at the start only the right arrow');
    assert.equal(at.nextCount,'+2','the arrow says how many are out of sight');
    assert.ok(at.prevSide&&at.nextSide,'arrows in the gutters, not over the columns');
    await page.click('.gxsc-arrow[data-dir=next]');await page.waitForTimeout(700);
    at=await nav();
    assert.ok(at.left>0&&at.left<at.max,'one column on');
    assert.deepEqual([at.prevCount,at.nextCount],['+1','+1']);
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
    assert.deepEqual([draft.input.trade,draft.input.roof_types,draft.input.brands],['roofing',['shingle','metal'],['owens_corning','gaf']]);
    assert.deepEqual(draft.input.suppliers.map(entry=>entry.name),['The Home Depot','ABC Supply','Lowes','Smith Roofing Supply']);
    // Costs are typed per supplier; they become the price book costs.
    await page.fill('[data-supplier=home_depot] [data-cost="lib-shingle-gaf-uhdz"]','39.5');
    await page.locator('[data-supplier=home_depot] [data-cost="lib-shingle-gaf-uhdz"]').dispatchEvent('change');
    // The general price sheet: the agent offers it in this step; the file goes to the model with the setup's message.
    await page.waitForSelector('.gxs-assistant [data-fma-upload]');
    assert.equal(await page.locator('.gxs-assistant .fma-msg.assistant',{hasText:/price sheet from your supplier/}).count(),1,'the agent offers it once');
    await shot(page,'4-suppliers');
    await press(page);
    await onStep(page,'Who does your labor?');
    await page.waitForTimeout(600);
    // Their groups and subcontractors as cards in two columns, each with how it is paid.
    const labs=await page.evaluate(()=>[...document.querySelectorAll('.gxs-step:not(.gxs-above) .gxs-lab')].map(card=>({name:card.querySelector('strong').textContent,kind:card.querySelector('.gxs-lab-kind').textContent,left:Math.round(card.getBoundingClientRect().left),pressed:[...card.querySelectorAll('[data-method][aria-checked=true]')].map(b=>b.dataset.method),note:card.querySelector('.gxs-lab-note')?.textContent||''})));
    assert.deepEqual(labs.map(c=>c.name),['North crew','Summit Roofing']);
    assert.equal(new Set(labs.map(c=>c.left)).size,2,'two columns');
    assert.deepEqual(labs[0].pressed,['hourly'],'paid as its pay sheet says');
    assert.match(labs[1].note,/own pay sheet \(4 lines\)/,'a fuller pay sheet is left to People');
    assert.match(labs[0].kind,/Crew/,'the organization’s word for a group');
    await page.fill('[data-lab="resource_group:g1"] [data-rate]','50');
    await page.locator('[data-lab="resource_group:g1"] [data-rate]').dispatchEvent('change');
    await page.fill('.gxs-lab-name','South crew');await page.press('.gxs-lab-name','Enter');
    await page.click('[data-lab="resource_group:south crew"] [data-method=per_measurement]');
    await page.fill('[data-lab="resource_group:south crew"] [data-rate]','70');
    await page.locator('[data-lab="resource_group:south crew"] [data-rate]').dispatchEvent('change');
    // Someone's pay sheet goes to the agent naming them, after the draft adds them.
    const [laborChooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('[data-lab="resource_group:south crew"] [data-sheet]')]);
    await laborChooser.setFiles({name:'south-rates.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4')});
    await page.waitForFunction(()=>window.calls.some(c=>c.path==='assistant'&&/South crew/.test(c.body.message)));
    assert.match((await page.evaluate(()=>window.calls.filter(c=>c.path==='assistant').at(-1))).body.message,/pay sheet for South crew \(assignee resource_group:new_south\)/);
    await shot(page,'5-labor');
    assert.equal(await page.locator('[data-gxs=next]').innerText(),'Build my price book');
    await page.waitForTimeout(300);
    await page.click('[data-gxs=next]');
    await page.waitForSelector('.gxs-done');
    const complete=await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/complete')));
    const picked=complete.body.selections;
    assert.deepEqual([picked.roof_types,picked.brands],[['shingle','metal'],['owens_corning','gaf']]);
    assert.deepEqual(picked.defaults,{shingle:'lib-shingle-oc-duration',ice_coverage:'eaves_36_valleys',low_slope_system:'mod_bit',underlayment:'lib-underlay-gaf-tiger-paw',ice_water:'lib-iws-oc-weatherlock-g',pipe_boot:'lib-pipe-boot-lead-3',ridge_vent:'lib-ridge-vent-oc-ventsure',intake_vent:'lib-intake-gaf-cobra-intakepro',box_vent:'lib-boxvent-gaf-masterflow-slantback',low_slope:'rtc-modified-bitumen-cap-sheet'});
    assert.equal(picked.lines,undefined,'no shingle lines are picked any more');
    assert.equal(picked.default_material,undefined,'the shingle path never asked');
    assert.ok(await page.evaluate(()=>window.thread.some(m=>m.role==='user'&&/Tiger Paw Premium Synthetic Underlayment/.test(m.content)&&/36 in at the eaves, plus valleys/.test(m.content))),'the defaults step is summarised in words');
    assert.equal(picked.suppliers.find(entry=>entry.preset==='home_depot').prices['lib-shingle-gaf-uhdz'],39.5,'the cost typed for that supplier');
    const depot=picked.suppliers.find(entry=>entry.preset==='home_depot');
    assert.ok(depot&&!depot.item_ids.includes('lib-shingle-gaf-hdz')&&depot.item_ids.includes('lib-shingle-gaf-uhdz'),'the unticked item left that supplier');
    assert.deepEqual(picked.labor.assignees.map(entry=>[entry.kind,entry.name,entry.ref?.id||null]),[['resource_group','North crew','g1'],['resource_group','South crew',null]]);
    // Done: centred, in plain words, with two ways on; it waits for one.
    await page.waitForTimeout(800);
    const done=await page.evaluate(()=>{const stage=document.querySelector('.gxs-stage').getBoundingClientRect(),box=document.querySelector('.gxs-done').getBoundingClientRect();return {offset:Math.abs((box.top+box.bottom)/2-(stage.top+stage.bottom)/2),buttons:[...document.querySelectorAll('.gxs-foot button')].filter(b=>!b.hidden&&b.offsetParent).map(b=>b.textContent.trim()),composer:!!document.querySelector('.gxs-assistant [data-fma=input]')?.offsetParent};});
    assert.ok(done.offset<20,`centred (${done.offset})`);
    assert.deepEqual(done.buttons,['View the price book','Start generating materials']);
    assert.equal(done.composer,true,'the conversation keeps its composer');
    assert.equal(await page.evaluate(()=>window.trayOpened),0,'nothing closes until they press one');
    await shot(page,'6-done');
    // The price book, in the sheet with the agent beside it: only what the setup wrote, fetched again first.
    await page.click('[data-gxs=view]');
    await page.waitForSelector('.gxs-book .pb-test');
    await page.waitForTimeout(600);
    const book=await page.evaluate(()=>({items:[...document.querySelectorAll('.gxs-book [data-pb]')].map(li=>li.dataset.pb),forced:window.FirstMatePricebook.loads,count:document.querySelector('.gxs-book-count').textContent,top:getComputedStyle(document.querySelector('.gxs-book .pb-top')).display,chat:!!document.querySelector('.gxs-assistant .fma-drawer')?.offsetParent,buttons:[...document.querySelectorAll('.gxs-foot button')].filter(b=>!b.hidden&&b.offsetParent).map(b=>b.textContent.trim()),panes:document.querySelectorAll('.gxs-step:not(.gxs-above)').length}));
    assert.deepEqual(book.items,['lib-shingle-oc-duration','lib-shingle-gaf-hdz'],'only the items set up');
    assert.deepEqual(book.forced,[true],'read again after the setup wrote it');
    assert.match(book.count,/^2 /);
    assert.equal(book.top,'none','the sheet has its own title');
    assert.equal(book.chat,true,'the agent stays open beside it');
    assert.deepEqual(book.buttons,['Back','Start generating materials']);
    assert.equal(book.panes,1);
    await shot(page,'6b-pricebook');
    await page.click('[data-gxs=book-back]');
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.gxs-foot button')].filter(b=>!b.hidden&&b.offsetParent).map(b=>b.textContent.trim())),['View the price book','Start generating materials']);
    await page.click('[data-gxs=view]');
    await page.waitForSelector('.gxs-book .pb-test');
    // Record the hand-off frame by frame.
    await page.evaluate(()=>{
      window.frames=[];
      const tick=()=>{const card=document.querySelector('.gxs-flying'),scrim=document.querySelector('.gxs-scrim'),tray=document.querySelector('.fm-project-tray'),drawer=tray?.querySelector('.fma-drawer'),mt=document.querySelector('.mt-resource-column');
        window.frames.push({t:performance.now(),card:card?card.getBoundingClientRect().toJSON():null,cardOpacity:card?Number(getComputedStyle(card).opacity):null,scrim:scrim?.isConnected?Number(getComputedStyle(scrim).opacity):null,tray:tray.getBoundingClientRect().width,trayReady:!!(drawer&&drawer.getBoundingClientRect().width>0&&drawer.querySelector('.fma-msg')),content:mt.getBoundingClientRect().right,setup:!!document.querySelector('.gxs')});
        if(window.frames.length<400)requestAnimationFrame(tick);};
      requestAnimationFrame(tick);
    });
    await page.click('[data-gxs=generate]');
    await page.waitForFunction(()=>window.trayOpened===1,null,{timeout:8000});
    await page.waitForFunction(()=>!document.querySelector('.gxs')&&!document.querySelector('.gxs-flying'),null,{timeout:8000});
    await page.waitForTimeout(400);
    const frames=await page.evaluate(()=>window.frames);
    const moving=frames.filter(f=>f.card&&f.cardOpacity===1);
    assert.ok(moving.length>=8,`the card animates over several frames (${moving.length})`);
    const mono=(values,dir)=>values.every((v,i)=>i===0||(dir>0?v>=values[i-1]-0.5:v<=values[i-1]+0.5));
    assert.ok(mono(moving.map(f=>f.card.left+f.card.width),1)||mono(moving.map(f=>f.card.left),1),'the card moves one way');
    assert.ok(mono(frames.filter(f=>f.scrim!==null).map(f=>f.scrim),-1),'the backdrop only fades');
    const trays=frames.map(f=>f.tray);
    assert.ok(mono(trays,1),'the tray only opens');
    const firstMove=frames.findIndex(f=>f.card),firstTray=frames.findIndex(f=>f.tray>0);
    assert.ok(Math.abs(firstMove-firstTray)<=2||Math.abs(frames[firstMove].t-frames[firstTray].t)<=50,'card and tray start together');
    assert.ok(frames.every(f=>f.card||f.trayReady||!f.setup&&f.trayReady||f.setup&&!f.card&&frames.indexOf(f)<firstMove),'no frame where the card has gone before the tray shows the conversation');
    // The tray holds the same conversation; the held Generate goes through once, then the tour.
    assert.match(await page.locator('.fm-project-tray .fma-msgs').innerText(),/Your price book is ready\./);
    await page.waitForFunction(()=>window.generated===1,null,{timeout:4000});
    await page.waitForSelector('.gx-pop',{timeout:6000});
    assert.equal(await page.evaluate(()=>window.generated),1,'generated once');
    assert.equal(await page.locator('.gx-pop h3').innerText(),'Welcome to Materials');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the path without shingle: roof types, the default material, your own supplier with its price sheet, then generate',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    // Opened with the tab, not from Generate: nothing is held, so "Start generating materials" presses Generate itself.
    await page.evaluate(()=>{window.FirstMateGuides.play('materials.pricebook_setup.roofing');});
    await page.waitForSelector('.gxs-type');
    await page.click('[data-type=metal]');
    await page.click('[data-type=tpo]');
    await press(page);
    await onStep(page,'What’s your default roofing material?');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.gxs-progress li').length),4,'roof types, material, suppliers, labor');
    await page.waitForTimeout(500);
    // The systems of the kinds picked: metal's three, then TPO; the first is chosen; what each includes is in its tooltip.
    const tiles=await page.evaluate(()=>[...document.querySelectorAll('[data-system]')].map(t=>({id:t.dataset.system,name:t.querySelector('.gxs-type-name').textContent,meta:t.querySelector('.gxs-type-meta').textContent,on:t.getAttribute('aria-checked'),tip:t.title})));
    assert.deepEqual(tiles.map(t=>t.id),['metal_standing_seam','metal_exposed_fastener','stone_coated_steel','tpo']);
    assert.deepEqual(tiles.map(t=>t.name),['Standing seam metal','Exposed-fastener metal','Stone-coated steel','TPO'],'names without their asides');
    assert.match(tiles[1].tip,/^Exposed-fastener metal \(corrugated \/ R-panel\)\. /,'the full name in the tooltip');
    assert.equal(tiles[0].on,'true');assert.equal(tiles[0].meta,'19 parts');
    assert.match(tiles[0].tip,/Standing seam panels, High-temperature synthetic underlayment/);
    assert.notEqual(await page.evaluate(()=>document.querySelector('[data-system=metal_standing_seam] svg').innerHTML),await page.evaluate(()=>document.querySelector('[data-system=metal_exposed_fastener] svg').innerHTML),'each metal has its own drawing');
    await page.click('[data-system=metal_exposed_fastener]');
    await shot(page,'n2-default-material');
    await press(page);
    await onStep(page,'Who provides your materials?');
    await page.waitForTimeout(400);
    // No catalog to suggest from: no researched suppliers, nothing preloaded; type your own.
    assert.equal(await page.locator('.gxs-supplier-pill').count(),0);
    assert.match(await page.locator('.gxs-supplier-input').getAttribute('placeholder'),/Type your supplier/);
    assert.match(await page.locator('.gxs-supplier-empty').innerText(),/price sheet/);
    await shot(page,'n3a-suppliers-empty');
    await page.fill('.gxs-supplier-input','Metal Depot');
    await page.click('[data-add-supplier]');
    await page.waitForSelector('.gxsc-col');
    const col=await page.evaluate(()=>({items:document.querySelectorAll('.gxsc-col [data-carry]').length,empty:document.querySelector('.gxsc-col .gxsc-empty')?.textContent||'',sheet:!!document.querySelector('.gxsc-col [data-sheet]')}));
    assert.deepEqual([col.items,col.sheet],[0,true],'an empty column with its own price sheet upload');
    assert.match(col.empty,/adds what it sells to your price book/);
    await page.waitForTimeout(300);
    await shot(page,'n3-suppliers');
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.click('.gxsc-col [data-sheet]')]);
    await chooser.setFiles({name:'metal-depot.xlsx',mimeType:'application/vnd.ms-excel',buffer:Buffer.from('panel,412')});
    await page.waitForFunction(()=>window.calls.some(c=>c.path==='assistant'&&/Metal Depot/.test(c.body.message)));
    assert.match((await page.evaluate(()=>window.calls.filter(c=>c.path==='assistant').at(-1))).body.message,/Metal Depot \(supplier id sup_0\)/,'the draft saved the supplier first, so the agent can add its items');
    const draft=await page.evaluate(()=>window.calls.filter(c=>c.path==='invoke').at(-1).input);
    assert.deepEqual([draft.roof_types,draft.default_material,draft.brands],[['metal','tpo'],'metal_exposed_fastener',undefined]);
    await press(page);
    await onStep(page,'Who does your labor?');
    await page.waitForTimeout(300);
    await page.click('[data-gxs=skip]');
    await page.waitForSelector('.gxs-done');
    const picked=(await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/complete')))).body.selections;
    assert.deepEqual([picked.roof_types,picked.default_material,picked.brands,picked.defaults],[['metal','tpo'],'metal_exposed_fastener',undefined,undefined]);
    assert.deepEqual(picked.suppliers,[{name:'Metal Depot',item_ids:[],prices:{}}]);
    await page.waitForTimeout(600);
    await page.click('[data-gxs=view]');
    await page.waitForSelector('.gxs-book .pb-test');
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.gxs-book [data-pb]')].map(li=>li.dataset.pb)),['rtc-metal-exposed-fastener-panels'],'a metal-only price book shows no shingles');
    await page.waitForTimeout(500);
    await shot(page,'n4-pricebook');
    await page.click('[data-gxs=generate]');
    await page.waitForFunction(()=>!document.querySelector('.gxs'),null,{timeout:8000});
    await page.waitForFunction(()=>window.generated===1,null,{timeout:4000});
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('rapid Continue and Back never leave more than one step on screen',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs-type');
    await page.click('[data-type=shingle]');
    await press(page);
    await onStep(page,'What roofing manufacturers do you use?');
    await page.click('[data-brand=gaf]');
    await page.waitForTimeout(300);
    // Ten presses in well under a second, Continue and Back mixed, as a person hammering the buttons.
    const took=await page.evaluate(async()=>{const t0=performance.now();for(let i=0;i<10;i++){document.querySelector(i%3===2?'[data-gxs=back]':'[data-gxs=next]')?.click();await new Promise(r=>setTimeout(r,60));}return performance.now()-t0;});
    assert.ok(took<1000,`ten presses in ${Math.round(took)} ms`);
    assert.ok(await page.evaluate(()=>document.querySelectorAll('.gxs-step').length)<=2,'at most the one leaving and the one arriving');
    await page.waitForTimeout(900);
    const panes=await page.evaluate(()=>[...document.querySelectorAll('.gxs-step')].map(el=>({title:el.querySelector('h2')?.childNodes[0]?.textContent?.trim(),visible:el.getBoundingClientRect().height>0&&getComputedStyle(el).opacity==='1'})));
    assert.equal(panes.length,1,`exactly one step: ${JSON.stringify(panes)}`);
    assert.equal(panes[0].visible,true);
    assert.notEqual(panes[0].title,'What’s your default roofing material?','never the other path');
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.gxs-step h2').length),1,'one title on screen');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the X asks in a dialog over the setup: Keep going returns to the same step, Skip setup closes it',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs-type');
    await page.click('[data-type=shingle]');
    await press(page);
    await onStep(page,'What roofing manufacturers do you use?');
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
    await page.click('.gxs-ask-box [data-gxs=keep]');
    await page.waitForFunction(()=>!document.querySelector('.gxs-ask'));
    assert.equal(await heading(page),'What roofing manufacturers do you use?');
    await page.click('[data-gxs=close]');await page.waitForSelector('.gxs-ask-box');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('.gxs-ask'));
    await page.click('[data-gxs=close]');await page.waitForSelector('.gxs-ask-box');
    const sheet=await page.locator('.gxs-sheet').boundingBox();
    await page.mouse.click(sheet.x+24,sheet.y+sheet.height-24);
    await page.waitForFunction(()=>!document.querySelector('.gxs-ask'));
    assert.equal(await heading(page),'What roofing manufacturers do you use?');
    await page.click('[data-gxs=close]');await page.waitForSelector('.gxs-ask-box');
    await page.click('.gxs-ask-box [data-gxs=dismiss]');
    await page.waitForFunction(()=>!document.querySelector('.gxs'));
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.body?.type==='dismiss').length),1);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the defaults and the labor step can be skipped: the defaults then come from the brands, and labor stays off',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.click('[data-mt-generate-materials]');
    await page.waitForSelector('.gxs-type');
    await page.click('[data-type=shingle]');
    await press(page);
    await onStep(page,'What roofing manufacturers do you use?');
    await page.click('[data-brand=gaf]');
    await press(page);
    await onStep(page,'Set your default materials');
    await page.waitForTimeout(300);
    await page.click('[data-gxs=skip]');
    await onStep(page,'Who provides your materials?');
    await press(page);
    await onStep(page,'Who does your labor?');
    assert.equal(await page.locator('[data-gxs=next]').innerText(),'Build my price book');
    await page.waitForTimeout(300);
    await page.click('[data-gxs=skip]');
    await page.waitForSelector('.gxs-done');
    const picked=(await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/complete')))).body.selections;
    assert.deepEqual(picked.defaults,{},'skipped: the server takes each default from the brands');
    assert.equal(picked.include_labor,false,'skipped: no labor lines');
    assert.deepEqual(picked.labor,{assignees:[],skipped:true},'skipped: the Labor column waits for someone to do labor');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('.gxs'),null,{timeout:8000});
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

test('a tour step follows its target when the page moves it, and becomes a centred card when it goes',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await load(browser);
    await page.evaluate(()=>{window.FirstMateGuides.play('materials.tab_tutorial',{replay:true});});
    await page.waitForSelector('.gx-pop');
    await page.click('.gx-pop [data-gx=next]');
    await page.waitForFunction(()=>document.querySelector('.gx-pop h3')?.textContent==='Generate');
    await page.waitForTimeout(600);
    const at=()=>page.evaluate(()=>{const ring=document.querySelector('.gx-ov-ring').getBoundingClientRect(),target=document.querySelector('[data-mt-generate-materials]')?.getBoundingClientRect(),arrow=document.querySelector('.gx-pop .gx-arrow')?.getBoundingClientRect();return {ringTop:ring.top,ringLeft:ring.left,targetTop:target?.top,targetLeft:target?.left,arrowY:arrow?arrow.top+arrow.height/2:null,targetBottom:target?.bottom,center:document.querySelector('.gx-pop').classList.contains('gx-center')};});
    const before=await at();
    assert.ok(Math.abs(before.ringTop-(before.targetTop-6))<2);
    // The person's action shows a bar above it (as ticking a photo shows the selection bar) and the layout shifts.
    await page.evaluate(()=>{const bar=document.createElement('div');bar.id='selbar';bar.style.cssText='height:140px;flex:0 0 100%;background:#eef';document.querySelector('.mt').prepend(bar);});
    await page.waitForTimeout(120);
    const moved=await at();
    assert.ok(moved.targetTop>before.targetTop+100,'the layout moved');
    assert.ok(Math.abs(moved.ringTop-(moved.targetTop-6))<2&&Math.abs(moved.ringLeft-(moved.targetLeft-6))<2,`the spotlight followed (${moved.ringTop} vs ${moved.targetTop})`);
    assert.ok(Math.abs(moved.arrowY-moved.targetBottom)<30,'so did the popover');
    // The target goes away: the step stays as a centred card instead of pointing at something else.
    await page.evaluate(()=>document.querySelector('[data-mt-generate-materials]').remove());
    await page.waitForFunction(()=>document.querySelector('.gx-pop').classList.contains('gx-center'));
    assert.equal(await page.locator('.gx-pop h3').innerText(),'Generate');
    assert.equal(await page.locator('.gx-pop .gx-arrow').count(),0);
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
