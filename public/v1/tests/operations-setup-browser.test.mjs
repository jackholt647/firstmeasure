import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

async function open(browser,path='scope',width=1100){
  const page=await browser.newPage({viewport:{width,height:850}});
  await page.route('https://operations.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../'+path.slice(1),import.meta.url),'utf8')});
    return route.fulfill({contentType:'text/html',body:'<html><body style="margin:0;font:14px/1.5 system-ui,sans-serif;--primary:#d93025"><main id="host" style="height:800px;padding:16px;box-sizing:border-box"></main></body></html>'});
  });
  await page.goto('https://operations.test/');
  await page.evaluate(path=>{
    window.__APP={userOrgId:'org1'};window.calls=[];window.activations=[];window.advanced=0;window.completed=[];window.nested=[];window.checkpoints=0;
    window.record={id:'doc1',revision:1,project_id:'p1',status:'draft',params:{},outputs:{}};
    window.setupState={scope_ready:true,setup:{suppliers:{complete:false},equipment:{complete:false},workforce:{complete:false},proposals:{complete:false}}};
    window.Portal={currentUser:{appEntitlements:[{id:'project.docs',offered:true}]},auth:{syncPlatformSession:async()=>{}}};
    window.proposalTools=[];
    window.FirstMateEmbeddableApps={mount:async(host,id,context)=>{proposalTools.push(id);context.params.embed.onReady({openDocument:async document=>proposalTools.push('open:'+document.id),openSendModal:document=>proposalTools.push('send:'+document.id),openPresentation:()=>proposalTools.push('present')});return {destroy(){}};}};
    window.PlatformAPI={request:async(url)=>{activations.push(url);return {};},capabilities:{load:async()=>{}},appFlags:{load:async()=>{}},publication:{
      invoke:async(org,action,target,input)=>{
        calls.push({action,target,input:structuredClone(input)});
        if(action==='operations.document.prepare')return {value:{document:structuredClone(record),workflow:{schema_version:1,name:'Shared scope',contract:{params:{scope_pieces:{type:'list',default:[]}},outputs:{}},steps:window.workflowSteps||[{id:'work',title:'What work?',items:[{kind:'piece_select',writes:'params.scope_pieces',required:true,multi:true}]}]},piece_catalog:[{id:'roof_replacement',name:'Roof replacement'},{id:'gutters',name:'Gutter replacement'},{id:'siding_replacement',name:'Siding replacement'}],measurement_fields_by_piece:{}}};
        if(action==='operations.document.save'){record={...record,revision:record.revision+1,params:input.params};return {value:{document:structuredClone(record)}};}
        if(action==='operations.scope.complete'){if(window.failPublication)throw Error('Please review your quantities.');return {value:{document:structuredClone(record),published:true}};}
        if(action==='operations.document.resolve')return {value:{}};
        if(action==='operations.setup.status')return {value:structuredClone(setupState)};
        return {value:{}};
      }
    }};
    window.selections={operation_path:path};
    window.widgetContext={where:{projectId:'p1'},selections,options:{},change(patch){Object.assign(selections,patch);},checkpoint:async()=>{checkpoints++;},advance:async()=>{advanced++;},complete:async result=>{completed.push(result);},restart:()=>{advanced++;},runGuide:async id=>{nested.push(id);if(id==='operations.suppliers.setup')setupState.setup.suppliers.complete=true;return {status:'completed'};}};
  },path);
  await page.evaluate(async()=>{window.operations=await import('/libraries/guided-experiences/operations-setup.js');});
  return page;
}

test('the quick scope uses the native workflow, saves before publishing, and does not activate Documents',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser,'scope',360);
    await page.evaluate(()=>window.widget=operations.mountWidget('operations-document',document.getElementById('host'),widgetContext));
    await page.locator('[data-fmdw-piece-type=roof_replacement]').click();
    await page.locator('[data-fmdw-piece-type=gutters]').click();
    assert.doesNotMatch(await page.locator('#host').innerText(),/proposal|payment|signature/i,'active quick scope only explains building the scope');
    assert.equal(await page.locator('[data-fmdw-preview]').count(),0);
    await page.locator('[data-fmdw-continue]').click();
    await page.waitForFunction(()=>advanced===1);
    const result=await page.evaluate(()=>({calls,activations,selections,checkpoints}));
    assert.equal(result.activations.length,0);
    assert.equal(result.selections.operations_scope_ready,true);
    assert.equal(result.selections.operations_document_id,'doc1');
    assert.equal(result.checkpoints,1);
    const save=result.calls.findLast(call=>call.action==='operations.document.save');
    assert.deepEqual(save.input.params.scope_pieces.map(piece=>piece.template_id),['roof_replacement','gutters']);
    assert.equal(result.calls.at(-1).action,'operations.scope.complete');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }finally{await browser.close();}
});

test('a proposal explicitly starts Documents and shows the native live preview',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser,'proposal');
    await page.evaluate(()=>operations.mountWidget('operations-document',document.getElementById('host'),widgetContext));
    await page.waitForSelector('[data-fmdw-preview]');
    assert.equal(await page.evaluate(()=>activations.length),1);
    assert.match(await page.evaluate(()=>activations[0]),/app-offers\/project.docs\/start$/);
    assert.equal(await page.locator('[data-fmdw-piece-type]').count(),3);
    assert.equal(await page.locator('.ops-notice').count(),0,'no notice above the proposal workflow');
    assert.equal(await page.locator('[data-fmdw-preview-toggle],[data-fmdw-preview-hide]').count(),0,'the setup keeps its preview pinned');
    assert.equal(await page.locator('[data-fmdw-resizer]').isVisible(),true,'the pinned preview can still be resized');
    const widths=()=>page.evaluate(()=>({main:document.querySelector('.fmdw-main').getBoundingClientRect().width,preview:document.querySelector('[data-fmdw-preview]').getBoundingClientRect().width}));
    const split=await widths();
    assert.ok(Math.abs(split.preview-split.main)<=3,`the questions and the preview split the space after the steps equally (${split.main} and ${split.preview})`);
    const handle=await page.locator('[data-fmdw-resizer]').boundingBox();
    await page.mouse.move(handle.x+handle.width/2,handle.y+200);await page.mouse.down();await page.mouse.move(handle.x-80,handle.y+200,{steps:4});await page.mouse.up();
    const dragged=await widths();
    assert.ok(dragged.preview>split.preview+60,`dragging widens the preview (${split.preview} to ${dragged.preview})`);
    assert.deepEqual(await page.evaluate(()=>[JSON.parse(localStorage.getItem('fmdw:preview-pinned')||'{}').width>0,localStorage.getItem('fmdw:preview')]),[true,null],'a pinned width is kept apart from the ordinary preview width');
    await page.locator('[data-fmdw-resizer]').dblclick();
    const reset=await widths();
    assert.ok(Math.abs(reset.preview-reset.main)<=3,'double-click returns to the equal split');
    await page.waitForFunction(()=>nested.includes('documents.proposal_tutorial'));
    assert.equal((await page.evaluate(()=>nested)).includes('operations.workflow_tutorial'),false,'the proposal path plays the proposal tutorial');
    await page.setViewportSize({width:600,height:850});
    await page.waitForFunction(()=>document.querySelector('[data-fmdw-root]').classList.contains('narrow'));
    assert.equal(await page.locator('[data-fmdw-preview]').isVisible(),true,'a narrow panel stacks the preview instead of hiding it');
    await page.setViewportSize({width:1100,height:850});
    await page.getByRole('button',{name:'Send proposal',exact:true}).click();
    await page.waitForFunction(()=>proposalTools.includes('send:doc1'));
    await page.getByRole('button',{name:'Present',exact:true}).click();
    await page.waitForFunction(()=>proposalTools.includes('present'));
    assert.equal(await page.evaluate(()=>proposalTools.filter(value=>value==='project.documents').length),1,'proposal actions reuse the ordinary document engine');
  }finally{await browser.close();}
});

test('a publication failure stays in the workflow, and a successful retry advances once',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{window.failPublication=true;operations.mountWidget('operations-document',document.getElementById('host'),widgetContext);});
    await page.locator('[data-fmdw-piece-type=siding_replacement]').click();
    await page.locator('[data-fmdw-continue]').click();
    await page.getByText('Please review your quantities.').waitFor();
    assert.equal(await page.evaluate(()=>advanced),0);
    await page.evaluate(()=>window.failPublication=false);
    await page.locator('[data-fmdw-continue]').click();
    await page.waitForFunction(()=>advanced===1);
  }finally{await browser.close();}
});

// FM-367: the setup played over a new project's Operations tab, before the project was saved, had no project and
// stopped on "Create or open a project first". Building the scope is the first write: it saves the project.
test('a new project window that is not saved yet is saved, and the scope is built on it',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser,'scope',360);
    await page.evaluate(()=>{
      window.drafts=[];window.saves=[];
      window.ensureDraftBaseProject=options=>{drafts.push(options);return {id:'p_new',title:''};};
      Portal.ProjectStore={saveRemote:async project=>{saves.push(project.id);return {...project};}};
      operations.mountWidget('operations-document',document.getElementById('host'),{...widgetContext,where:{projectId:'',tab:'project.materials'}});
    });
    await page.locator('[data-fmdw-piece-type=roof_replacement]').waitFor();
    const result=await page.evaluate(()=>({drafts,saves,calls,selections,error:document.querySelector('.ops-error').textContent}));
    assert.deepEqual(result.drafts,[{allowEmpty:true}]);
    assert.deepEqual(result.saves,['p_new'],'the draft is saved once before anything is written to it');
    const prepare=result.calls.find(call=>call.action==='operations.document.prepare');
    assert.equal(prepare.input.project_id,'p_new');
    assert.equal(prepare.target.projectId,'p_new');
    assert.equal(result.selections.operations_project_id,'p_new');
    assert.equal(result.error,'');
  }finally{await browser.close();}
});

test('with no project and no project window to save one, the step says so and offers to try again',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>operations.mountWidget('operations-document',document.getElementById('host'),{...widgetContext,where:{projectId:'',tab:''}}));
    await page.getByText('Create or open a project first, then set up its scope of work.').waitFor();
    assert.equal(await page.locator('[data-retry]').count(),1);
    assert.equal(await page.evaluate(()=>calls.length),0,'nothing is written without a project');
  }finally{await browser.close();}
});

test('the checklist refreshes saved completion after an optional setup and generates only on request',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{Object.assign(selections,{operations_project_id:'p1',operations_document_id:'doc1'});operations.mountWidget('operations-ready',document.getElementById('host'),widgetContext);});
    await page.waitForSelector('[data-setup=suppliers]');
    assert.equal(await page.locator('[data-setup=suppliers] .ops-check').count(),0);
    await page.locator('[data-setup=suppliers]').click();
    await page.waitForSelector('[data-setup=suppliers] .ops-check');
    assert.deepEqual(await page.evaluate(()=>nested),['operations.suppliers.setup']);
    assert.equal(await page.evaluate(()=>completed.length),0);
    assert.equal(await page.locator('[data-setup=equipment]').innerText().then(text=>text.includes('3 min')),true);
    assert.equal(await page.locator('[data-setup=proposals]').innerText().then(text=>text.includes('10 min')),true);
    await page.locator('[data-generate]').click();
    assert.deepEqual(await page.evaluate(()=>completed),[{generate:true}]);
  }finally{await browser.close();}
});

// FM-607: one proposal setup. The Proposals card opens the Docs tab's document setup already answered for a proposal,
// at its first proposal question, and a card done anywhere in the app shows its tick.
test('the Proposals card opens the document setup for a proposal and ticks when proposals are set up elsewhere',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{
      Object.assign(selections,{operations_project_id:'p1',operations_document_id:'doc1'});
      window.guideCalls=[];
      const ctx={...widgetContext,options:{setups:[{id:'proposals',minutes:10,experience:'documents.setup',appId:'project.docs',selections:{document_kind:'proposal'},start:'presentation'}]},
        runGuide:async(id,options)=>{guideCalls.push({id,options});setupState.setup.proposals.complete=true;return {status:'completed'};}};
      operations.mountWidget('operations-ready',document.getElementById('host'),ctx);
    });
    await page.waitForSelector('[data-setup=proposals]');
    assert.equal(await page.locator('[data-setup=proposals] .ops-check').count(),0);
    await page.locator('[data-setup=proposals]').click();
    await page.waitForSelector('[data-setup=proposals] .ops-check');
    assert.deepEqual(await page.evaluate(()=>guideCalls),[{id:'documents.setup',options:{selections:{document_kind:'proposal'},start:'presentation'}}]);
    assert.deepEqual(await page.evaluate(()=>activations),['/organizations/org1/app-offers/project.docs/start'],'Docs is started before its setup');
  }finally{await browser.close();}
});

// FM-606: the Equipment card is the Equipment tab itself (one fleet, one tour), with Back at the bottom left as the
// sheet's other steps have it and no line of copy above the app. Back waits for the tour's overlay to go, not for the
// tour's server refresh after it; the phone's back (backDepth/back) leaves the same way.
test('the Equipment card shows the Equipment app with Back at the bottom left, and Back returns to the cards',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{
      Object.assign(selections,{operations_project_id:'p1',operations_document_id:'doc1'});
      Portal.currentUser.appEntitlements.push({id:'portal.equipment',offered:true});
      window.mounted=[];window.destroyed=0;window.titles=[];window.synced=0;window.guideCalls=[];
      FirstMateEmbeddableApps.mount=async(host,id,context)=>{mounted.push({id,surface:context.surface});host.innerHTML='<div style="height:100%"><button data-eq-add-unit>Add unit</button></div>';return {destroy(){destroyed++;}};};
      // The tour: its overlay is up until endTour(); its runGuide settles later, as the server refresh after it does.
      const ctx={...widgetContext,setTitle:text=>titles.push(text),syncBack:()=>synced++,
        // window.startingTour: the tour has not put its overlay up yet.
        runGuide:(id,options)=>{guideCalls.push({id,keepVisible:options.keepVisible,signal:options.signal instanceof AbortSignal});window.tourSignal=options.signal;
          const overlay=document.createElement('div');overlay.className='gx-ov';if(!window.startingTour)document.body.append(overlay);
          return new Promise(resolve=>{options.signal.addEventListener('abort',()=>{overlay.remove();resolve({status:'ended'});});window.endTour=()=>{overlay.remove();setTimeout(()=>resolve({status:'dismissed'}),3000);};});}};
      // window.slowStatus: the setup status waits for releaseStatus().
      const invoke=PlatformAPI.publication.invoke;
      PlatformAPI.publication.invoke=async(...args)=>{if(args[1]==='operations.setup.status'&&window.slowStatus)await new Promise(resolve=>{window.releaseStatus=resolve;});return invoke(...args);};
      window.widget=operations.mountWidget('operations-ready',document.getElementById('host'),ctx);
    });
    await page.waitForSelector('[data-setup=equipment]');
    assert.equal(await page.evaluate(()=>widget.back()),false,'on the cards the sheet goes back itself');
    await page.locator('[data-setup=equipment]').click();
    await page.waitForSelector('.ops-app [data-eq-add-unit]');
    assert.deepEqual(await page.evaluate(()=>mounted),[{id:'portal.equipment',surface:'portal_tab'}]);
    assert.deepEqual(await page.evaluate(()=>activations),['/organizations/org1/app-offers/portal.equipment/start'],'Equipment is started before it opens');
    assert.deepEqual(await page.evaluate(()=>guideCalls),[{id:'equipment.tab_tutorial',keepVisible:true,signal:true}],'the Equipment tab\'s own tour');
    const layout=await page.evaluate(()=>{const host=document.getElementById('host'),back=host.querySelector('[data-return]'),app=host.querySelector('.ops-app');const b=back.getBoundingClientRect(),a=app.getBoundingClientRect(),h=host.getBoundingClientRect();
      return {text:host.innerText.replace(/\s+/g,' ').trim(),backBelowApp:b.top>=a.bottom,backLeft:Math.round(b.left-a.left),backBottomGap:Math.round(h.bottom-16-b.bottom),aboveApp:[...app.parentElement.children].indexOf(app)};});
    assert.equal(layout.text,'Add unit Back','only the app and Back: no line of copy above the app');
    assert.equal(layout.aboveApp,0,'nothing above the app');
    assert.ok(layout.backBelowApp&&layout.backLeft===0&&layout.backBottomGap<=1,`Back at the bottom left: ${JSON.stringify(layout)}`);
    assert.deepEqual(await page.evaluate(()=>[titles.at(-1),widget.backDepth()]),['Equipment',1]);
    assert.ok(await page.evaluate(()=>synced)>0,'the phone\'s back learns the extra page');
    // Under the tour, neither Back leaves.
    await page.locator('[data-return]').click({force:true});
    assert.equal(await page.evaluate(()=>widget.back()),true);
    assert.equal(await page.locator('.ops-app').count(),1);
    // Back shows the cards at once (from the last status), and equipment added in the app (anywhere: the status reads
    // the fleet) ticks the card when the status answers.
    await page.evaluate(()=>{setupState.setup.equipment.complete=true;endTour();window.slowStatus=true;});
    await page.locator('[data-return]').click();
    assert.equal(await page.locator('[data-setup=equipment]').count(),1,'the cards are back before the status answers');
    assert.equal(await page.locator('[data-setup=equipment] .ops-check').count(),0);
    await page.evaluate(()=>{window.slowStatus=false;releaseStatus();});
    await page.waitForSelector('[data-setup=equipment] .ops-check',{timeout:2000});
    assert.deepEqual(await page.evaluate(()=>[destroyed,widget.backDepth(),titles.at(-1)]),[1,0,'']);
    // The phone's back leaves the same way.
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,3100)));
    await page.locator('[data-setup=equipment]').click();
    await page.waitForSelector('.ops-app [data-eq-add-unit]');
    await page.evaluate(()=>endTour());
    assert.equal(await page.evaluate(()=>widget.back()),true);
    await page.waitForSelector('[data-setup=equipment] .ops-check');
    assert.equal(await page.evaluate(()=>widget.backDepth()),0);
    // Back while the tour is still starting stops it, so it never comes up over the cards.
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,3100)));
    await page.evaluate(()=>{window.startingTour=true;});
    await page.locator('[data-setup=equipment]').click();
    await page.waitForSelector('.ops-app [data-eq-add-unit]');
    await page.locator('[data-return]').click();
    await page.waitForSelector('[data-setup=equipment] .ops-check');
    assert.equal(await page.evaluate(()=>tourSignal.aborted),true);
  }finally{await browser.close();}
});

// FM-606: a setup step can take back a tour it started (its page closed while the tour starts or plays): the tour
// ends, is not recorded as seen, and a signal already aborted never shows it.
test('a nested tour started with a signal ends when the signal aborts and stays to do',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{
      Portal.navigation={read:()=>({tab:'viewer',project:'p1',projectTab:'materials'})};
      window.guideEvents=[];
      const text=value=>({key:value,text:value});
      window.fetch=async(url,options={})=>{
        const path=String(url),body=options.body?JSON.parse(options.body):{};
        if(path.endsWith('/events'))guideEvents.push({path,...body});
        const value=path.includes('/experiences?')?{reveals:[],experiences:[
          {id:'parent',kind:'modal',scope:'organization',title:text('Set up Operations'),steps:[{id:'ready',widget:'test-parent',title:text('Ready')}],variant:{id:'default'},completion:{}},
          {id:'tour',kind:'overlay',scope:'person',title:text('Equipment tour'),variant:{id:'default'},steps:[{id:'intro',targets:[],placement:'center',title:text('Equipment that fits the work'),body:text('Tour body.'),advance:'next',wait_ms:1500}]}
        ]}:{};
        return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,...value})};
      };
    });
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-experiences.js'});
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-setup.js'});
    await page.evaluate(()=>{FirstMateGuidedSetup.registerWidget('test-parent',{handlesNavigation:true,render(el,ctx){window.parentContext=ctx;el.textContent='Cards';return {};}});FirstMateGuides.play('parent');});
    await page.waitForFunction(()=>window.parentContext);
    const before=await page.evaluate(()=>{const stop=new AbortController();stop.abort();return parentContext.runGuide('tour',{keepVisible:true,signal:stop.signal});});
    assert.equal(before.status,'ended');
    assert.equal(await page.locator('.gx-pop').count(),0);
    await page.evaluate(()=>{window.stop=new AbortController();window.outcome=parentContext.runGuide('tour',{keepVisible:true,signal:stop.signal});});
    await page.getByText('Equipment that fits the work',{exact:true}).waitFor();
    await page.evaluate(()=>stop.abort());
    assert.equal((await page.evaluate(()=>outcome)).status,'ended');
    assert.equal(await page.locator('.gx-pop,.gx-ov').count(),0);
    assert.equal(await page.evaluate(()=>guideEvents.filter(event=>event.path.includes('/tour/')&&['dismiss','complete'].includes(event.type)).length),0,'not recorded as seen');
  }finally{await browser.close();}
});

test('a nested setup opened with an answer starts after its question and Back stops there',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{
      const text=value=>({key:value,text:value});
      const step=id=>({id,widget:'test-step',title:text('Step '+id)});
      window.guideEvents=[];
      window.fetch=async(url,options={})=>{
        const path=String(url),body=options.body?JSON.parse(options.body):{};
        if(path.endsWith('/events'))guideEvents.push({path,...body});
        const value=path.includes('/experiences?')?{experiences:[
          {id:'parent',version:1,kind:'modal',scope:'organization',title:text('parent'),steps:[{id:'one',widget:'test-parent',title:text('parent')}],variant:{id:'default'},completion:{}},
          {id:'child',version:1,kind:'modal',scope:'organization',replayable:true,title:text('child'),steps:[step('kind'),step('presentation'),step('style')],variant:{id:'default'},completion:{}}
        ],reveals:[]}:{};
        return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,...value})};
      };
    });
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-experiences.js'});
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-setup.js'});
    await page.evaluate(()=>{
      FirstMateGuidedSetup.registerWidget('test-parent',{handlesNavigation:true,render(el,ctx){el.innerHTML='<button id="child">Proposals</button>';el.querySelector('#child').onclick=()=>ctx.runGuide('child',{selections:{document_kind:'proposal'},start:'presentation'});return {};}});
      FirstMateGuidedSetup.registerWidget('test-step',{render(el,ctx){el.innerHTML=`<p class="seen">${ctx.step.id}:${ctx.selections.document_kind||''}</p>`;return {valid:()=>true};}});
      FirstMateGuides.play('parent');
    });
    await page.locator('#child').click();
    await page.waitForSelector('[data-gx-setup=child] .seen');
    assert.equal(await page.locator('[data-gx-setup=child] .seen').innerText(),'presentation:proposal','the answered question is not asked');
    assert.equal(await page.locator('[data-gx-setup=child] [data-gxs=back]').isHidden(),true,'Back does not return to the answered question');
    await page.locator('[data-gx-setup=child] [data-gxs=next]').click();
    await page.getByText('style:proposal',{exact:true}).waitFor();
    await page.locator('[data-gx-setup=child] [data-gxs=back]').click();
    await page.getByText('presentation:proposal',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-gx-setup=child] [data-gxs=back]').isHidden(),true);
  }finally{await browser.close();}
});

test('a nested setup retains the page lock and returns to the same checklist',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{
      const text=value=>({key:value,text:value});
      const definition=(id,widget)=>({id,version:1,kind:'modal',scope:'organization',title:text(id),steps:[{id:'one',widget,title:text(id)}],variant:{id:'default'},completion:{}});
      window.guideEvents=[];
      window.fetch=async(url,options={})=>{
        const path=String(url),body=options.body?JSON.parse(options.body):{};
        if(path.endsWith('/events'))guideEvents.push({path,...body});
        const value=path.includes('/experiences?')?{experiences:[definition('parent','test-parent'),definition('child','test-child'),definition('queued','test-child')],reveals:[]}:{};
        return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,...value})};
      };
    });
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-experiences.js'});
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-setup.js'});
    await page.evaluate(()=>{
      FirstMateGuidedSetup.registerWidget('test-parent',{handlesNavigation:true,render(el,ctx){el.innerHTML='<button id="child">Open optional setup</button><button id="finish">Finish parent</button><span id="returned"></span>';el.querySelector('#child').onclick=async()=>{await ctx.runGuide('child');el.querySelector('#returned').textContent='Returned';};el.querySelector('#finish').onclick=()=>ctx.complete();return {};}});
      FirstMateGuidedSetup.registerWidget('test-child',{render(el){el.innerHTML='<p>Child content</p>';return {valid:()=>true};}});
      FirstMateGuides.play('parent');
    });
    await page.locator('#child').click();
    await page.waitForSelector('[data-gx-setup=child]');
    assert.equal(await page.locator('.gxs:not([hidden])').count(),1);
    await page.evaluate(()=>{FirstMateGuides.play('queued');});
    await page.locator('[data-gx-setup=child] [data-gxs=next]').click();
    await page.getByText('Returned',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-gx-setup=queued]').count(),0,'unrelated guides stay queued while parent holds the lock');
    assert.equal(await page.locator('.gxs:not([hidden])').count(),1);
    await page.locator('#finish').click();
    await page.waitForSelector('[data-gx-setup=queued]');
  }finally{await browser.close();}
});

test('the workflow walkthrough leaves all work cards interactive and never auto-replays after dismissal',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{
      Portal.navigation={read:()=>({tab:'viewer',project:'p1',projectTab:'materials'})};
      window.guideEvents=[];window.walkthroughDone=false;
      const text=value=>({key:value,text:value});
      window.fetch=async(url,options={})=>{
        const path=String(url),body=options.body?JSON.parse(options.body):{};
        if(path.endsWith('/events')){guideEvents.push({path,...body});if(path.includes('operations.workflow_tutorial')&&['dismiss','complete'].includes(body.type))walkthroughDone=true;}
        const value=path.includes('/experiences?')?{reveals:[],experiences:[
          {id:'parent',kind:'modal',scope:'organization',title:text('Set up Operations'),steps:[{id:'document',widget:'test-workflow',title:text('Your project scope'),options:{path:'scope'}}],variant:{id:'default'},completion:{}},
          {id:'operations.workflow_tutorial',kind:'overlay',scope:'person',title:text('Scope walkthrough'),replayable:true,variant:{id:'default'},steps:[{id:'work',targets:['.ops-workflow .fmdw-piece-grid'],title:text('Pick every kind of work'),body:text('Choose more than one.'),advance:'next',wait_ms:5000}],...(walkthroughDone?{progress:{status:'dismissed'}}:{})}
        ]}:{};
        return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,...value})};
      };
    });
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-experiences.js'});
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-setup.js'});
    await page.evaluate(()=>{FirstMateGuidedSetup.registerWidget('test-workflow',{fill:true,handlesNavigation:true,render(el,ctx){window.parentContext=ctx;return operations.mountWidget('operations-document',el,ctx);}});FirstMateGuides.play('parent');});
    await page.getByText('Pick every kind of work',{exact:true}).waitFor();
    await page.locator('[data-fmdw-piece-type=roof_replacement]').click();
    await page.locator('[data-fmdw-piece-type=gutters]').click();
    assert.equal(await page.locator('.fmdw-piece-type.active').count(),2);
    await page.locator('.gx-pop [data-gx=close]').click();
    await page.waitForFunction(()=>walkthroughDone);
    await page.waitForFunction(()=>!document.querySelector('.gx-pop'));
    const outcome=await page.evaluate(()=>parentContext.runGuide('operations.workflow_tutorial',{keepVisible:true,replay:false}));
    assert.equal(outcome.status,'done');
    assert.equal(await page.locator('.gx-pop').count(),0);
    assert.equal(await page.evaluate(()=>guideEvents.filter(event=>event.path.includes('operations.workflow_tutorial')&&event.type==='replay').length),0);
  }finally{await browser.close();}
});

// The real proposal workflow and template from the library: the review step, its footer and its live preview.
async function openProposalReview(browser,width,{resume=false}={}){
  const library=name=>readFile(new URL(`../config-library/snapshot/${name}.json`,import.meta.url),'utf8').then(text=>JSON.parse(text).data.definition);
  const [workflow,template]=await Promise.all([library('document_workflow/wfl_operations_proposal_v1'),library('document_template/tpl_operations_proposal_v1')]);
  const page=await open(browser,'proposal',width);
  await page.evaluate(({workflow,template,resume})=>{
    const params={scope_pieces:[{template_id:'roof_replacement',name:'Roof replacement'}],measurements:{roofSquares:30},scope_items:[{id:'roof',name:'Roof replacement',quantity:1,unit:'ea',unit_price:18836,selected:true,children:[]}],payment_schedule:[{id:'deposit',label:'Deposit',kind:'percent',percent:30,payment_kind:'deposit',due_rule:'on_signature'},{id:'final',label:'Final payment',kind:'percent',percent:70,payment_kind:'final',due_rule:'project_completion'}]};
    window.record={id:'doc1',revision:5,project_id:'p1',status:'draft',params,outputs:{},workflow_state:{current_step:resume?'review':'terms',completed_steps:resume?['work','measure','items','terms']:['work','measure','items']}};
    // After a reload the setup resumes the document it saved: its id is in the guide's selections.
    if(resume)Object.assign(selections,{operations_project_id:'p1',operations_document_id:'doc1'});
    window.resolves=0;window.saveConflicts=0;
    const invoke=PlatformAPI.publication.invoke;
    PlatformAPI.publication.invoke=async(org,action,target,input)=>{
      if(action==='operations.document.prepare'){calls.push({action,input});return {value:{document:structuredClone(record),workflow:{definition:workflow},piece_catalog:[{id:'roof_replacement',name:'Roof replacement'}],measurement_fields_by_piece:{}}};}
      if(action==='operations.document.save'&&input.expected_revision!==record.revision){saveConflicts++;const error=Error('Document revision does not match.');error.status=409;error.data={error:'document_revision_conflict'};throw error;}
      if(action==='operations.document.save'){calls.push({action,input});record={...record,revision:record.revision+2,params:input.params};return {value:{document:structuredClone(record)}};}
      if(action==='operations.document.resolve'){resolves++;return {value:{resolved_definition:template,widget_data:{}}};}
      return invoke(org,action,target,input);
    };
  },{workflow,template,resume});
  await page.evaluate(()=>operations.mountWidget('operations-document',document.getElementById('host'),widgetContext));
  return page;
}
async function footerFits(page){
  return page.evaluate(()=>{
    const column=document.querySelector('.fmdw-main').getBoundingClientRect();
    return [...document.querySelectorAll('.fmdw-foot button')].filter(button=>button.offsetParent).map(button=>{const box=button.getBoundingClientRect();return {name:button.getAttribute('aria-label')||button.textContent.trim(),inside:box.left>=column.left-0.5&&box.right<=column.right+0.5&&box.width>=30,box:[Math.round(box.left),Math.round(box.right)],column:[Math.round(column.left),Math.round(column.right)]};});
  });
}
async function previewRendered(page){
  await page.waitForFunction(()=>resolves>0&&!document.querySelector('[data-fmdw-preview].loading'));
  await page.waitForTimeout(200);
  return page.evaluate(()=>{const stage=document.querySelector('[data-fmdw-preview-stage]');return !stage.querySelector('.fmdw-preview-empty')&&stage.children.length>0;});
}

test('the proposal review step keeps every footer action inside its column and its preview renders',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    for(const width of [1500,1180,900]){
      const page=await openProposalReview(browser,width);
      await page.locator('.fmdw-step.current',{hasText:'Payment terms'}).waitFor();
      await page.locator('[data-fmdw-continue]').click();
      await page.getByRole('button',{name:'Send proposal'}).waitFor();
      const buttons=await footerFits(page);
      assert.equal(buttons.length,4,`Previous, Send proposal, Present and Finish at ${width}px`);
      for(const button of buttons)assert.ok(button.inside,`${button.name} sits inside the column at ${width}px: ${JSON.stringify(button)}`);
      assert.equal(await page.getByRole('button',{name:'Present'}).isVisible(),true,'an icon-only action keeps its name');
      assert.equal(await previewRendered(page),true,`the review step shows the live preview at ${width}px`);
      await page.close();
    }
  }finally{await browser.close();}
});

test('after a reload the resumed review step renders its preview, and a save another editor overtook recovers',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await openProposalReview(browser,1180,{resume:true});
    await page.getByRole('button',{name:'Send proposal'}).waitFor();
    assert.match(await page.locator('.fmdw-step.current').innerText(),/Review your proposal/,'resumes on the saved step');
    assert.equal(await previewRendered(page),true,'the resumed review step shows the preview');
    assert.equal(await page.evaluate(()=>calls.find(call=>call.action==='operations.document.prepare').input.document_id),'doc1');
    // Send proposal opens the ordinary document editor on the same document, which saves it (a newer revision).
    await page.getByRole('button',{name:'Send proposal'}).click();
    await page.waitForFunction(()=>proposalTools.includes('send:doc1'));
    await page.evaluate(()=>{record={...record,revision:record.revision+3};window.resolves=0;});
    // Back to the terms: a change saves over the newer revision and the preview still resolves.
    await page.locator('[data-fmdw-back]').click();
    await page.getByRole('button',{name:'50 / 50'}).click();
    assert.equal(await previewRendered(page),true,'the preview survives a revision another editor made');
    await page.waitForFunction(()=>saveConflicts>0&&calls.some(call=>call.action==='operations.document.save'&&call.input.params.payment_schedule?.[0]?.percent===50));
    assert.equal(await page.locator('.ops-error').innerText(),'','the recovered save shows no error');
  }finally{await browser.close();}
});

test('Operations scope and checklist layouts fit desktop and mobile',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const output=new URL('../../../output/operations-setup-20261027/',import.meta.url);await mkdir(output,{recursive:true});
  try{
    for(const width of [1100,360]){
      const page=await open(browser,'scope',width);
      await page.evaluate(()=>window.widget=operations.mountWidget('operations-document',document.getElementById('host'),widgetContext));
      await page.locator('[data-fmdw-piece-type=roof_replacement]').click();
      await page.locator('[data-fmdw-piece-type=gutters]').click();
      await page.screenshot({path:new URL(`scope-${width}.png`,output).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
      await page.evaluate(()=>{widget.destroy();Object.assign(selections,{operations_project_id:'p1',operations_document_id:'doc1'});setupState.setup.suppliers.complete=true;operations.mountWidget('operations-ready',document.getElementById('host'),widgetContext);});
      await page.waitForSelector('[data-generate]');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:new URL(`checklist-${width}.png`,output).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
      await page.close();
    }
  }finally{await browser.close();}
});

// FM-486: on a phone the setup has one title, in its top bar between the agent and the X, which the workflow's current
// step publishes; the workflow's step numbers sit in one row along the bottom of the screen; the proposal preview is
// folded to its bar (open and close it there) and opens by itself on the review step. The desktop layout is unchanged.
test('phone: one title in the top bar, the step numbers along the bottom, the preview folded until the review step',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser,'proposal',433);
    await page.setViewportSize({width:433,height:582});
    await page.evaluate(()=>{
      window.workflowSteps=[
        {id:'work',title:'What are we working on?',items:[{kind:'piece_select',label:'Choose everything included in this project',writes:'params.scope_pieces',required:true,multi:true}]},
        {id:'notes',title:'Anything else?',items:[{kind:'text',label:'Notes',writes:'params.notes'}]},
        {id:'review',title:'Review your proposal',items:[{kind:'review'}]}];
      Portal.navigation={read:()=>({project:'p1',projectTab:'materials'})};
      window.fetch=async(url)=>{
        const step={id:'document',widget:'operations-document',title:{key:'gx_test_doc',text:'What does this project need?'},options:{path:'proposal'},say:[],selects:[],required:true,next:null};
        const value=String(url).includes('/experiences?')?{experiences:[{id:'ops.phone',version:1,kind:'modal',scope:'organization',title:{key:'gx_test',text:'Set up Operations'},steps:[step],variant:{id:'default'},completion:{}}],reveals:[]}:{};
        return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,...value})};
      };
    });
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-experiences.js'});
    await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-setup.js'});
    page.evaluate(()=>FirstMateGuides.play('ops.phone')).catch(()=>{});
    await page.waitForSelector('[data-fmdw-piece-type=roof_replacement]');
    const title=()=>page.evaluate(()=>document.querySelector('.gxs-head-title').innerText.trim());
    await page.waitForFunction(()=>document.querySelector('.gxs-head-title').innerText.trim()==='What are we working on?');
    const layout=()=>page.evaluate(()=>{
      const box=selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return r.width&&r.height?{top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}:null;};
      const visibleTitles=[...document.querySelectorAll('.gxs h2,.gxs [role=heading],.fmdw-field-label')].filter(el=>el.getBoundingClientRect().height>0).map(el=>el.innerText.trim());
      return {head:box('.gxs-head'),headTitle:box('.gxs-head-title'),badge:box('.gxs-badge'),close:box('.gxs-close'),rail:box('.fmdw-rail'),preview:box('[data-fmdw-preview]'),stage:box('[data-fmdw-preview-stage]'),sheet:box('.gxs-sheet'),cards:[...document.querySelectorAll('[data-fmdw-piece-type]')].map(el=>el.getBoundingClientRect().top),items:box('[data-fmdw-items]'),visibleTitles,folded:document.querySelector('[data-fmdw-preview-fold]').getAttribute('aria-expanded')==='false',sideways:document.documentElement.scrollWidth>innerWidth};
    });
    let box=await layout();
    assert.deepEqual(box.visibleTitles,['What are we working on?'],'one title: the workflow step\'s, in the top bar; no second title row or field label');
    assert.ok(box.headTitle.left>=box.badge.right&&box.headTitle.right<=box.close.left,`the title sits between the agent and the X (${JSON.stringify([box.badge,box.headTitle,box.close])})`);
    assert.ok(box.folded&&!box.stage&&box.preview.height<70,`the preview starts folded to its bar (${JSON.stringify(box.preview)})`);
    assert.ok(box.rail.top>=box.preview.bottom-1&&Math.abs(box.rail.bottom-box.sheet.bottom)<=2,`the step numbers are one row along the bottom (${JSON.stringify({rail:box.rail,preview:box.preview,sheet:box.sheet})})`);
    assert.ok(box.rail.height<70,'one row of step numbers');
    const middle=(box.cards[0]+box.cards.at(-1))/2,itemsMiddle=(box.items.top+box.items.bottom)/2;
    assert.equal(box.cards.length,3);
    assert.ok(Math.abs(middle-itemsMiddle)<90,`the work cards sit in the middle (${middle} in ${JSON.stringify(box.items)})`);
    assert.equal(box.sideways,false);
    // The bar opens and closes the preview.
    await page.click('[data-fmdw-preview-head]');
    await page.waitForFunction(()=>document.querySelector('[data-fmdw-preview-stage]').getBoundingClientRect().height>100);
    assert.equal(await page.locator('[data-fmdw-preview-fold]').getAttribute('aria-expanded'),'true');
    await page.click('[data-fmdw-preview-fold]');
    await page.waitForFunction(()=>document.querySelector('[data-fmdw-root]').classList.contains('preview-folded'));
    // Each step publishes its title; the review step opens the preview.
    await page.locator('[data-fmdw-piece-type=roof_replacement]').click();
    await page.locator('[data-fmdw-continue]').click();
    await page.waitForFunction(()=>document.querySelector('.gxs-head-title').innerText.trim()==='Anything else?');
    assert.equal(await page.evaluate(()=>document.querySelector('[data-fmdw-root]').classList.contains('preview-folded')),true,'still folded before the review step');
    await page.locator('[data-fmdw-continue]').click();
    await page.waitForFunction(()=>document.querySelector('.gxs-head-title').innerText.trim()==='Review your proposal');
    await page.waitForFunction(()=>!document.querySelector('[data-fmdw-root]').classList.contains('preview-folded')&&document.querySelector('[data-fmdw-preview-stage]').getBoundingClientRect().height>100);
    assert.equal(await title(),'Review your proposal');
    // The desktop layout keeps its titles, the step list beside the questions and the preview open.
    await page.setViewportSize({width:1280,height:850});
    await page.waitForFunction(()=>!document.querySelector('[data-fmdw-root]').classList.contains('narrow'));
    box=await layout();
    assert.ok(!box.headTitle,'no title in the top bar on a desktop');
    assert.ok(box.visibleTitles.includes('What does this project need?')&&box.visibleTitles.includes('Review your proposal'),JSON.stringify(box.visibleTitles));
    assert.ok(box.rail.right<=box.preview.left&&box.stage,'steps beside, preview open');
    assert.equal(await page.locator('[data-fmdw-preview-fold]').isVisible(),false);
  }finally{await browser.close();}
});

// FM-604: the first page's two answers are two tall tiles side by side, as tall as the document setup's pair
// (documents-setup.js .gxd-pair: 250px, 190px on a phone). The workflow's first step has Previous back to them, and the
// phone's back control walks the workflow's steps, then the choice, one history entry each.
test('the two path tiles are tall, and Back (the button and the phone\'s) returns from the workflow to them',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    for(const [width,height,minimum] of [[1100,850,250],[390,844,190]]){
      const page=await open(browser,'',width);
      await page.setViewportSize({width,height});
      await page.evaluate(()=>{
        window.selections.operation_path='';
        window.workflowSteps=[
          {id:'work',title:'What are we working on?',items:[{kind:'piece_select',label:'Choose everything included in this project',writes:'params.scope_pieces',required:true,multi:true}]},
          {id:'notes',title:'Anything else?',items:[{kind:'text',label:'Notes',writes:'params.notes'}]}];
        window.depths=[];
        Portal.navigation={read:()=>({project:'p1',projectTab:'materials'}),steps:({onBack})=>{window.pressBack=count=>onBack(count);return {depth(count){depths.push(count);},release:async()=>{}};}};
        window.fetch=async(url)=>{
          const steps=[
            {id:'path',widget:'operations-path',title:{key:'gx_test_path',text:'Start with the work you’re planning'},say:[],selects:[],required:true,next:null},
            {id:'document',widget:'operations-document',title:{key:'gx_test_doc',text:'What does this project need?'},say:[],selects:[],required:true,next:null}];
          const value=String(url).includes('/experiences?')?{experiences:[{id:'ops.back',version:1,kind:'modal',scope:'organization',title:{key:'gx_test',text:'Set up Operations'},steps,variant:{id:'default'},completion:{}}],reveals:[]}:{};
          return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,...value})};
        };
      });
      await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-experiences.js'});
      await page.addScriptTag({url:'https://operations.test/libraries/guided-experiences/guided-setup.js'});
      page.evaluate(()=>FirstMateGuides.play('ops.back')).catch(()=>{});
      await page.waitForSelector('.gxs-step:not(.gxs-above) [data-path=scope]');
      const tiles=await page.evaluate(()=>[...document.querySelectorAll('.gxs-step:not(.gxs-above) .ops-choice')].map(el=>({rect:el.getBoundingClientRect(),height:el.offsetHeight})).map(({rect,height})=>({top:rect.top,left:rect.left,right:rect.right,height})));
      assert.equal(tiles.length,2);
      assert.ok(tiles.every(tile=>tile.height>=minimum-0.5),`${width}px: both tiles at least ${minimum}px tall (${JSON.stringify(tiles)})`);
      assert.ok(Math.abs(tiles[0].top-tiles[1].top)<1&&tiles[0].right<=tiles[1].left,`${width}px: the tiles sit side by side (${JSON.stringify(tiles)})`);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const depth=()=>page.evaluate(()=>depths.at(-1));
      const onPath=()=>page.waitForSelector('.gxs-step:not(.gxs-above) [data-path=scope]');
      // Previous on the workflow's first step goes back to the choice.
      await page.click('[data-path=scope]');
      await page.waitForSelector('.gxs-step:not(.gxs-above) [data-fmdw-piece-type=roof_replacement]');
      assert.equal(await page.locator('.gxs-step:not(.gxs-above) [data-fmdw-back]').isVisible(),true,`${width}px: the first workflow step has Previous`);
      assert.equal(await depth(),2,'one entry for the choice behind the workflow, one that leaves');
      await page.click('.gxs-step:not(.gxs-above) [data-fmdw-back]');
      await onPath();
      assert.equal(await depth(),1);
      // The phone's back walks the workflow's own step first, then goes back to the choice.
      await page.click('[data-path=scope]');
      await page.waitForSelector('.gxs-step:not(.gxs-above) [data-fmdw-piece-type=roof_replacement]');
      await page.locator('.gxs-step:not(.gxs-above) [data-fmdw-piece-type=roof_replacement]').click();
      await page.locator('.gxs-step:not(.gxs-above) [data-fmdw-continue]').click();
      await page.waitForFunction(()=>document.querySelector('.gxs-step:not(.gxs-above) .fmdw-field-label')?.textContent.trim()==='Notes');
      await page.waitForFunction(()=>depths.at(-1)===3);
      await page.evaluate(()=>pressBack(1));
      await page.waitForSelector('.gxs-step:not(.gxs-above) [data-fmdw-piece-type=roof_replacement]');
      assert.equal(await depth(),2,'back to the workflow\'s first step');
      await page.evaluate(()=>pressBack(1));
      await onPath();
      assert.equal(await depth(),1,'back to the choice');
      await page.close();
    }
  }finally{await browser.close();}
});
