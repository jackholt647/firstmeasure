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
        if(action==='operations.document.prepare')return {value:{document:structuredClone(record),workflow:{schema_version:1,name:'Shared scope',contract:{params:{scope_pieces:{type:'list',default:[]}},outputs:{}},steps:[{id:'work',title:'What work?',items:[{kind:'piece_select',writes:'params.scope_pieces',required:true,multi:true}]}]},piece_catalog:[{id:'roof_replacement',name:'Roof replacement'},{id:'gutters',name:'Gutter replacement'},{id:'siding_replacement',name:'Siding replacement'}],measurement_fields_by_piece:{}}};
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
