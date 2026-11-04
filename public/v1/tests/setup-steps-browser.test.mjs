import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {publishedCatalog} from '../company-profile/profile.ts';

// Setup steps in the browser (docs/architecture/setup-steps.md): the server injected the company steps into a setup;
// the player draws them in the standard frame with no step count, loads their own module, which reads the catalog
// through the publication layer, saves each answer with its action on Continue, and goes Back along the way taken.
// SHOTS=<dir> saves screenshots.
const read=file=>readFile(new URL('../../'+file,import.meta.url),'utf8');
const core=await read('libraries/guided-experiences/guided-experiences.js'),setup=await read('libraries/guided-experiences/guided-setup.js');
const t=(key,text)=>({key,text});
const CATALOG=publishedCatalog();
const MODULE='/libraries/setup-steps/company-profile.js?v=test';
const injected=(id,part,title,forStep)=>({id,widget:'module',module:MODULE,title,subtitle:t('gx_test_sub','Why we ask.'),options:{part},say:[],selects:[],required:true,next:null,setup_step:{id,version:1,writes:{action:'company-profile.save',target:'organization'},injected_for:forStep}});
const SETUP={id:'ops.test',version:1,kind:'modal',scope:'organization',title:t('gx_test_title','Set up Operations'),tab:'project.materials',replayable:true,variant:{id:'default',bucket:0.2,unit:'organization:o'},triggers:[],
  steps:[{id:'path',widget:'test-choice',title:t('gx_test_path','Start with the work you’re planning'),options:{},say:[],selects:['picked'],required:true,next:null},
    injected('company.type','type',t('gx_step_company_type_title','What kind of company are you?'),'document'),
    injected('company.services','services',t('gx_step_company_services_title','What kind of work do you do?'),'document'),
    {id:'document',widget:'test-choice',title:t('gx_test_doc','What does this project need?'),options:{},say:[],selects:['picked'],required:true,next:null}],
  completion:{action:null,screen:'none',say:[],then:[]},progress:null};
const REQUIRE_ONLY={id:'setup_step.company.type',version:1,kind:'modal',scope:'organization',title:t('gx_step_company_type_title','What kind of company are you?'),replayable:true,variant:{id:'default',bucket:0.1,unit:'organization:o'},triggers:[{kind:'manual'}],steps:[],completion:{action:null,screen:'none',say:[],then:[]},progress:null};

async function load(browser,{width=1280,height=820}={}){
  const page=await browser.newPage({viewport:{width,height}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://fm.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/libraries/setup-steps/company-profile.js')return route.fulfill({contentType:'text/javascript',body:await read('libraries/setup-steps/company-profile.js')});
    return route.fulfill({contentType:'text/html',body:'<html></html>'});
  });
  await page.goto('https://fm.test/portal/');
  await page.setContent('<style>body{margin:0;font:14px Arial;--primary:#1570ef;--primary-rgb:21,112,239}</style><main id="page">Operations</main>');
  await page.evaluate(({SETUP,REQUIRE_ONLY,CATALOG})=>{
    window.__APP={userOrgId:'o'};window.route={project:'p1',projectTab:'materials'};
    window.Portal={navigation:{read:()=>window.route}};
    window.calls=[];window.events=[];window.failNext=false;
    window.profile={company_type:null,company_type_other:null,services:[],services_other:[],answered:{type:false,services:false}};
    window.experiences=[SETUP,REQUIRE_ONLY];
    window.fetch=async(url,options={})=>{
      const u=new URL(url),method=(options.method||'GET').toUpperCase(),body=options.body?JSON.parse(options.body):null;
      const json=d=>new Response(JSON.stringify({ok:true,...d}),{status:200,headers:{'Content-Type':'application/json'}});
      if(method==='GET'&&u.pathname.endsWith('/experiences'))return json({experiences:window.experiences});
      if(u.pathname.endsWith('/events')){window.events.push(body);return json({recorded:true});}
      if(u.pathname.endsWith('/complete'))return json({result:{},progress:{status:'completed'}});
      return new Response('{}',{status:404});
    };
    window.PlatformAPI={publication:{
      read:async(org,source)=>{window.calls.push({read:source.provider+'.'+source.export});return {status:'ready',value:source.export==='catalog'?CATALOG:structuredClone(window.profile)};},
      invoke:async(org,action,target,input)=>{
        window.calls.push({action,target,input:structuredClone(input)});
        if(window.failNext){window.failNext=false;throw new Error('The company profile changed. Reload and try again.');}
        if(input.company_type){window.profile.company_type=input.company_type;window.profile.answered.type=true;}
        if(input.services){window.profile.services=input.services.map(id=>({id}));window.profile.services_other=input.services_other||[];window.profile.answered.services=true;}
        return {value:window.profile};
      }}};
  },{SETUP,REQUIRE_ONLY,CATALOG});
  await page.addScriptTag({content:core});
  await page.addScriptTag({content:setup});
  await page.evaluate(()=>FirstMateGuidedSetup.registerWidget('test-choice',{render(el,ctx){
    el.innerHTML='<button type="button" data-test-pick>Pick this</button>';
    el.querySelector('[data-test-pick]').addEventListener('click',()=>ctx.change({picked:true},'Picked'));
    return {valid:()=>ctx.selections.picked===true};
  }}));
  return {page,errors};
}
const title=page=>page.locator('.gxs-step:not(.gxs-above) h2').first().innerText();
const onStep=(page,text)=>page.waitForFunction(text=>document.querySelector('.gxs-step:not(.gxs-above) h2')?.innerText.startsWith(text),text);
const next=async page=>{await page.waitForFunction(()=>!document.querySelector('[data-gxs=next]').disabled);await page.waitForTimeout(260);await page.click('[data-gxs=next]');};
const shot=async(page,name)=>{if(process.env.SHOTS)await page.screenshot({path:`${process.env.SHOTS}/${name}.png`});};

test('the injected company steps: search, pick, save on Continue, no step count, Back along the way taken',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,errors}=await load(browser);
    const played=page.evaluate(()=>FirstMateGuides.play('ops.test')).catch(error=>({error:String(error)}));
    await onStep(page,'Start with the work');
    assert.equal(await page.locator('.gxs-progress').count(),0,'no step lines or count in the frame');
    await page.click('[data-test-pick]');await next(page);

    // What kind of company are you? Typing "roofer" puts a roofing contractor first; Enter picks it.
    await onStep(page,'What kind of company are you?');
    await page.waitForSelector('.gxc [data-search]');
    assert.equal(await page.locator('[data-gxs=next]').isDisabled(),true,'Continue waits for an answer');
    assert.equal(await page.locator('.gxc-tile').count(),CATALOG.company_types.length+1,'every kind of company, and Other');
    await page.fill('.gxc [data-search]','roofer');
    assert.equal(await page.locator('.gxc-tile').first().getAttribute('data-type'),'roofing_contractor');
    await page.press('.gxc [data-search]','Enter');
    assert.equal(await page.locator('[data-type=roofing_contractor]').getAttribute('aria-selected'),'true');
    await page.fill('.gxc [data-search]','');
    await page.waitForTimeout(350);await shot(page,'company-type-desktop');
    // A save that fails stays on the step with the reason.
    await page.evaluate(()=>window.failNext=true);
    await next(page);
    await page.waitForFunction(()=>document.querySelector('.gxs-status').textContent.includes('changed'));
    assert.match(await title(page),/^What kind of company are you?/);
    await next(page);

    // What kind of work do you do? The roofing suggestions, plus anything found in the search, plus your own words.
    await onStep(page,'What kind of work do you do?');
    await page.waitForSelector('.gxc [data-service]');
    const saved=await page.evaluate(()=>calls.filter(call=>call.action));
    assert.deepEqual(saved.at(-1),{action:'company-profile.save',target:{scope:'organization',organizationId:'o'},input:{company_type:'roofing_contractor'}});
    const tiles=await page.locator('.gxc [data-service]').evaluateAll(nodes=>nodes.map(node=>node.dataset.service));
    assert.deepEqual(tiles.slice(0,4),['roof_replacement','roof_repair','roof_inspection','storm_insurance']);
    assert.match(await page.locator('.gxc-lead').innerText(),/roofing contractor/i);
    await page.click('[data-service=roof_replacement]');await page.click('[data-service=gutters]');
    await page.fill('.gxc [data-search]','hvac');
    await page.waitForSelector('.gxc-menu:not([hidden]) [data-pick=hvac_install]');
    await page.press('.gxc [data-search]','Enter');
    assert.equal(await page.locator('[data-service=hvac_install]').getAttribute('aria-pressed'),'true','a service found in the search is added and picked');
    await page.fill('.gxc [data-search]','Chimney caps');
    await page.waitForSelector('.gxc-menu [data-add]');
    // Escape closes the dropdown, not the setup.
    await page.press('.gxc [data-search]','Escape');
    assert.equal(await page.locator('.gxs-ask').count(),0);
    assert.equal(await page.locator('.gxc-menu').isHidden(),true,'the dropdown closed');
    assert.equal(await page.locator('.gxs').count(),1,'the setup stays open');
    await page.fill('.gxc [data-search]','Chimney caps');
    await page.click('.gxc-menu [data-add]');
    assert.equal(await page.locator('.gxc-tag').innerText().then(text=>text.replace('×','').trim()),'Chimney caps');
    await page.waitForTimeout(300);await shot(page,'company-services-desktop');
    await next(page);
    await onStep(page,'What does this project need?');
    assert.deepEqual((await page.evaluate(()=>calls.filter(call=>call.action))).at(-1).input,{services:['roof_replacement','gutters','hvac_install'],services_other:['Chimney caps']});

    // Back returns along the way taken, with the answers as they were.
    await page.click('[data-gxs=back]');
    await onStep(page,'What kind of work do you do?');
    await page.waitForSelector('[data-service=hvac_install][aria-pressed=true]');
    await next(page);
    await onStep(page,'What does this project need?');
    await page.click('[data-test-pick]');await next(page);
    assert.equal((await played).status,'completed');
    const stepEvents=await page.evaluate(()=>events.filter(e=>e.type==='step_done').map(e=>e.step_id));
    assert.deepEqual(stepEvents,['path','company.type','company.services','company.services','document']);
    assert.deepEqual(await page.evaluate(()=>events.at(-1)?.selections||null),{picked:true},'answers to setup steps never go into the setup\'s selections');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('require: a setup step that is answered asks nothing',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,errors}=await load(browser);
    assert.deepEqual(await page.evaluate(()=>FirstMateGuides.require('company.type')),{status:'satisfied'});
    assert.equal(await page.locator('.gxs').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('phone: the company step fits the screen without sideways scrolling',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,errors}=await load(browser,{width:390,height:844});
    page.evaluate(()=>FirstMateGuides.play('ops.test')).catch(()=>{});
    await onStep(page,'Start with the work');
    await page.click('[data-test-pick]');await next(page);
    await onStep(page,'What kind of company are you?');
    await page.waitForSelector('.gxc [data-search]');
    await page.click('[data-type=roofing_contractor]');
    await page.waitForTimeout(350);await shot(page,'company-type-phone');
    assert.equal(await page.evaluate(()=>{const step=document.querySelector('.gxs-step:not(.gxs-above)');return step.scrollWidth<=step.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth;}),true);
    const columns=await page.locator('.gxc-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(columns,2,'two tiles a row on a phone');
    await next(page);
    await onStep(page,'What kind of work do you do?');
    await page.waitForSelector('.gxc [data-service]');
    await page.click('[data-service=roof_replacement]');await page.click('[data-service=roof_repair]');
    await page.waitForTimeout(350);await shot(page,'company-services-phone');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// The sheet follows its step (guided-setup.js fit): a landscape rectangle as tall as the step, footer close below the
// content, growing when a taller step comes and capped (the step scrolls) at the screen; on a phone a modal setup is a
// sheet from the bottom edge, as tall as its step.
const sheetFit=page=>page.evaluate(()=>{
  const sheet=document.querySelector('.gxs-sheet').getBoundingClientRect(),pane=document.querySelector('.gxs-step:not(.gxs-above)');
  let bottom=pane.querySelector('.gxs-titlebar').getBoundingClientRect().bottom;
  for(const el of pane.querySelectorAll('.gxs-body *')){const r=el.getBoundingClientRect();if(r.width&&r.height)bottom=Math.max(bottom,r.bottom);}
  return {width:sheet.width,height:sheet.height,top:sheet.top,bottom:sheet.bottom,gap:document.querySelector('.gxs-foot').getBoundingClientRect().top-Math.min(bottom,sheet.bottom),scrolls:pane.scrollHeight>pane.clientHeight+1};
});
test('the sheet is as tall as its step: landscape, footer close to the content, growing with a taller step',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,errors}=await load(browser,{width:1280,height:820});
    page.evaluate(()=>FirstMateGuides.play('ops.test')).catch(()=>{});
    await onStep(page,'Start with the work');
    await page.waitForTimeout(700);
    const small=await sheetFit(page);
    assert.ok(small.height<300&&small.width>small.height*2,`a short step makes a short, wide sheet (${JSON.stringify(small)})`);
    assert.ok(small.gap>=0&&small.gap<40,`the footer sits just below the content (${small.gap})`);
    await page.click('[data-test-pick]');await next(page);
    await onStep(page,'What kind of company are you?');
    await page.waitForSelector('.gxc-tile');
    await page.waitForTimeout(700);
    const tall=await sheetFit(page);
    assert.ok(tall.height>small.height+150&&tall.height<=820-32+1,`a taller step grows the sheet, within the screen (${JSON.stringify(tall)})`);
    assert.ok(tall.width===small.width,'the width stays');
    assert.ok(tall.scrolls||tall.gap<40,`no empty space under the content (${tall.gap})`);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
test('phone: a modal setup is a sheet from the bottom edge, as tall as its step',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const {page,errors}=await load(browser,{width:390,height:844});
    page.evaluate(()=>FirstMateGuides.play('ops.test')).catch(()=>{});
    await onStep(page,'Start with the work');
    await page.waitForTimeout(700);
    const box=await sheetFit(page);
    assert.ok(Math.abs(box.width-390)<1&&Math.abs(box.bottom-844)<1,`full width, on the bottom edge (${JSON.stringify(box)})`);
    assert.ok(box.height<400&&box.gap<40,`as tall as the step (${JSON.stringify(box)})`);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
