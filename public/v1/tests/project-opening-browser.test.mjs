import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {chromium} from 'playwright-core';

const source = file => readFile(new URL(`../../${file}`,import.meta.url),'utf8');

test('project identity and styled close render before iframe startup; unfinished child stays hidden',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.route('https://project.test/**',route=>route.fulfill({contentType:'text/html',body:'<main class="main" style="height:100vh;width:100vw"></main>'}));
    await page.goto('https://project.test/');
    await page.addScriptTag({content:await source('libraries/window-manager/window-manager.js')});
    await page.addScriptTag({content:await source('libraries/window-manager/window-shell.js')});
    await page.addScriptTag({content:await source('libraries/project-trays/project-trays.js')});
    await page.addScriptTag({content:await source('libraries/window-manager/project-windows.js')});
    await page.evaluate(()=>{
      window.reads=[];
      window.Portal={cfg:{userOrgId:'org_test'}};
      window.PlatformAPI={projects:{get:(org,id)=>{reads.push([org,id]);return new Promise(resolve=>{window.resolveRead=()=>resolve({document:{id,data:{address:'Fresh address'},revision:7}});});}}};
    });
    await page.evaluate(()=>{window.record=FirstMateProjectWindows.open({id:'project_test',address:'418 Juniper Lane'},{tab:'photos'});});
    assert.equal(await page.locator('.fm-project-loading-title').textContent(),'418 Juniper Lane');
    assert.equal(await page.getByRole('button',{name:'Close project',exact:true}).evaluate(el=>getComputedStyle(el).borderWidth),'0px');
    assert.equal(await page.locator('iframe').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    assert.equal(await page.locator('.fm-project-loading-header').evaluate(el=>el.getBoundingClientRect().height),69);
    assert.equal(await page.getByRole('button',{name:'Overview',exact:true}).count(),1);
    for(const name of ['Notes','Activity','Agent']) assert.equal(await page.getByRole('tab',{name,exact:true}).isVisible(),true);

    await page.locator('iframe').contentFrame().locator('main').waitFor({state:'attached'});
    assert.deepEqual(await page.evaluate(()=>reads),[['org_test','project_test']],'project read starts before child API is ready');
    await page.evaluate(()=>resolveRead());
    assert.equal(await page.locator('.fm-project-loading-title').textContent(),'Fresh address','server identity updates without waiting for child startup');
    assert.deepEqual(await page.evaluate(async()=>{
      const bridge=FirstMateProjectWindows,child=record.frame.contentWindow;
      const wrongWindow=bridge.takeProjectRead(record.token,window,'org_test','project_test');
      const wrongOrg=bridge.takeProjectRead(record.token,child,'another_org','project_test');
      const wrongProject=bridge.takeProjectRead(record.token,child,'org_test','another_project');
      const result=await bridge.takeProjectRead(record.token,child,'org_test','project_test');
      const repeated=bridge.takeProjectRead(record.token,child,'org_test','project_test');
      return [wrongWindow,wrongOrg,wrongProject,result.document.revision,repeated];
    }),[null,null,null,7,null],'handoff is restricted to the owning window, org and project and consumed once');
    await page.getByRole('button',{name:'Dock project to the right (right-click for placement)',exact:true}).click();
    await page.getByRole('button',{name:'Minimize project',exact:true}).click();
    assert.equal(await page.evaluate(()=>record.controller.state.mode),'minimized');
    await page.evaluate(()=>{
      const child=record.frame.contentWindow;
      child.document.body.className='platform-booting';
      child.document.body.innerHTML='<div id="fmPlatformBootCover">Booting</div><header><span id="title">418 Juniper Lane</span><div id="controls"></div></header>';
      window.control=FirstMateProjectWindows.attach(record.token,child,{
        header:child.document.querySelector('header'),title:child.document.querySelector('#title'),
        controlsHost:child.document.querySelector('#controls'),customChrome:true,name:'project',mode:'modal',
      });
    });
    assert.equal(await page.locator('iframe').contentFrame().locator('#title').getAttribute('tabindex'),null);
    assert.equal(await page.locator('iframe').contentFrame().locator('#title').getAttribute('role'),null);
    assert.equal(await page.locator('.fm-project-window-loading').isVisible(),false,'minimized loading shell stays hidden through attachment');
    assert.equal(await page.locator('iframe').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    await page.evaluate(()=>{control.setMode('modal',{silent:true});control.setVisible(true);});
    assert.equal(await page.evaluate(()=>record.controller.state.mode),'minimized','child initial presentation must not undo user placement');
    assert.equal(await page.locator('iframe').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    await page.evaluate(()=>control.restore());
    assert.equal(await page.evaluate(()=>record.controller.state.mode),'docked','restore retains the pre-load docking choice');
    assert.equal(await page.locator('.fm-project-window-loading').count(),0);
    assert.equal(await page.locator('iframe').evaluate(el=>getComputedStyle(el).visibility),'visible');
    assert.equal(await page.locator('iframe').contentFrame().locator('#fmPlatformBootCover').count(),0,'unrelated portal boot does not block the ready project');
    await page.evaluate(()=>FirstMateProjectWindows.close(record.token));
    assert.equal(await page.locator('iframe').count(),0);
  } finally {await browser.close();}
});

test('project can be dismissed immediately while its document is loading',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<main class="main" style="height:100vh;width:100vw"></main>');
    await page.evaluate(()=>{window.crypto.randomUUID=()=> 'project-loading-test';});
    await page.addScriptTag({content:await source('libraries/window-manager/window-manager.js')});
    await page.addScriptTag({content:await source('libraries/window-manager/window-shell.js')});
    await page.addScriptTag({content:await source('libraries/project-trays/project-trays.js')});
    await page.addScriptTag({content:await source('libraries/window-manager/project-windows.js')});
    await page.evaluate(()=>{window.record=FirstMateProjectWindows.open({id:'project_test',title:'Test project'});});
    await page.getByRole('button',{name:'Close project',exact:true}).click();
    assert.equal(await page.evaluate(()=>FirstMateProjectWindows.size),0);
    assert.equal(await page.evaluate(()=>record.ready),null);
  } finally {await browser.close();}
});

test('only the selected app mounts after shell preparation; stale map timers do no work',async()=>{
  const app=await source('libraries/apps/project-request/app.js');
  const fn=name=>{
    const start=app.indexOf(`  function ${name}(`);
    assert.ok(start>=0);
    return app.slice(start,app.indexOf('\n  }',start)+4);
  };
  const mounted=[],maps=[];
  let timer;
  const context={
    projectShellLoading:true,projectRouteBatching:true,activePreviewTab:'photos',
    projectModalAppHandles:new Map(),projectMapInitTimer:0,activeBaseProject:{id:'project_test'},
    ensureProjectModalAppPanels(){},
    projectModalApps:()=>[{id:'map',appId:'project.map'},{id:'photos',appId:'project.photos'},{id:'docs',appId:'project.docs'}],
    safelyRunProjectModalTab:(_app,_phase,run)=>run(),mountProjectModalApp:app=>mounted.push(app.id),
    clearTimeout(){},setTimeout:callback=>{timer=callback;return 1;},initializeMapView:project=>maps.push(project.id),
  };
  vm.createContext(context);
  vm.runInContext(fn('mountProjectModalApps')+fn('scheduleProjectMapInitialize'),context);
  context.mountProjectModalApps();
  assert.deepEqual(mounted,[]);
  context.projectShellLoading=false;
  context.mountProjectModalApps();
  assert.deepEqual(mounted,[],'preparing the default shell does not mount Overview');
  context.projectRouteBatching=false;
  context.mountProjectModalApps();
  assert.deepEqual(mounted,['photos']);
  context.activePreviewTab='map';
  context.scheduleProjectMapInitialize();
  context.activePreviewTab='photos';timer();
  assert.deepEqual(maps,[],'switching tabs cancels queued map work');
  context.activePreviewTab='map';context.scheduleProjectMapInitialize();timer();
  assert.deepEqual(maps,['project_test']);
});

test('existing project paints a provisional shell then hydrates once and preserves open intents',async()=>{
  const app=await source('libraries/apps/project-request/app.js');
  const start=app.indexOf('  async function openProject(');
  const code=app.slice(start,app.indexOf('\n  }',start)+4);
  const events=[];
  let resolveRead,resolvePaint,resolveHeaderPaint,paintCount=0;
  const headerPaint=new Promise(resolve=>{resolveHeaderPaint=resolve;});
  const paint=new Promise(resolve=>{resolvePaint=resolve;});
  const read=new Promise(resolve=>{resolveRead=resolve;});
  const context={
    loadBranchProjectConfig:async()=>({}),adoptOpeningHeaderState(){},openingProjectHeader:project=>({title:project.address,identityHtml:project.address,pillsHtml:''}),document:{getElementById:()=>null},
    projectWindowToken:'test',projectWindowBridge:{update:(_token,header)=>events.push(['header',header.title])},projectOpenGeneration:0,projectRecordPending:false,projectShellLoading:false,
    window:{Portal:{},FirstMateWindowShell:{afterPaint:()=>paintCount++ ? headerPaint : paint}},console,
    projectOpenId:project=>project?.id || '',activeModalMatchesProject:()=>events.length>0,
    looksLikeMeasurementOnlyRecord:()=>false,
    open:(project,options)=>{
      context.projectShellLoading=options.shellOnly;
      events.push(['shell',project.address,options.tab,options.shellOnly]);
    },
    hydratePlatformProjectForOpen:()=>read,
    hydrateOpenProjectContent:(project,options)=>{events.push(['hydrate',project.address,options.tab]);context.projectShellLoading=false;},
    applyProposalOpenIntent:async options=>events.push(['intent',options.proposalIntent]),
  };
  vm.createContext(context);vm.runInContext(code,context);
  const pending=context.openProject({id:'project_test',address:'Cached address'},{tab:'docs',proposalIntent:'open'});
  assert.deepEqual(events,[['shell','Cached address','docs',true]]);
  assert.equal(context.projectRecordPending,true);
  resolveRead({id:'project_test',address:'Current address'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.length,1,'an already-fetched record cannot hydrate before the shell paint');
  resolvePaint();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,[['shell','Cached address','docs',true],['header','Current address']],'authoritative header paints while content is still pending');
  resolveHeaderPaint();
  await pending;
  assert.deepEqual(events,[['shell','Cached address','docs',true],['header','Current address'],['hydrate','Current address','docs'],['intent','open']]);
  assert.equal(context.projectRecordPending,false);
});


test('opening tabs use parent metadata before data or iframe readiness, without overflow, and respect reduced motion',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.route('https://project.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>*{box-sizing:border-box}main{height:100vh;width:100vw}</style><main class="main"></main>'}));
    await page.goto('https://project.test/');
    await page.addScriptTag({content:await source('libraries/project-trays/project-trays.js')});
    for(const file of ['window-manager','window-shell','project-windows']) await page.addScriptTag({content:await source('libraries/window-manager/'+file+'.js')});
    await page.evaluate(()=>{
      window.Portal={cfg:{userOrgId:'org_test'},modules:{request:{openingTabs:()=>[{id:'map',label:'Overview'},{id:'photos',label:'Photos',icon:'fa-images'},{id:'docs',label:'Docs',icon:'fa-folder'}]}}};
      window.PlatformAPI={projects:{get:()=>new Promise(()=>{})}};
      window.record=FirstMateProjectWindows.open({id:'project_test',address:'Test address'},{tab:'photos',photo:'photo_deep_link'});
    });
    assert.equal(await page.locator('.fm-shell-tabs button').count(),3);
    assert.equal(await page.locator('iframe').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    assert.deepEqual(await page.locator('.fm-shell-tabs').evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight,overflow:getComputedStyle(el).overflowY})),{client:32,scroll:32,overflow:'hidden'});
    assert.equal(await page.getByRole('tab',{name:'Notes',exact:true}).evaluate(el=>getComputedStyle(el).fontSize),'13.3333px');
    assert.equal(await page.locator('.fm-shell-tabs button').first().evaluate(el=>el.getAnimations().length),0);
    await page.locator('.fm-shell-tabs').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished));});
    await page.getByRole('button',{name:'Docs',exact:true}).click();
    assert.equal(await page.evaluate(()=>record.options.tab),'docs');
    assert.equal(await page.evaluate(()=>record.options.photo),'','an explicit tab choice supersedes an initial photo link');
    await page.evaluate(()=>FirstMateProjectWindows.close());
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>{window.record=FirstMateProjectWindows.open({id:'project_reduced',address:'Test address'});});
    assert.equal(await page.locator('.fm-shell-tabs').evaluate(el=>el.getAnimations({subtree:true}).length),0);
    await page.evaluate(()=>FirstMateProjectWindows.close());
  }finally{await browser.close();}
});

test('unchanged project tab renders preserve button identity and keyboard focus',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<nav></nav>');
    await page.evaluate(()=>{window.Portal={};});
    await page.addScriptTag({content:await source('portal/scripts/project_viewer.js')});
    assert.equal(await page.evaluate(()=>{
      const viewer=new Portal.ProjectViewer({tabsEl:document.querySelector('nav')});
      const tabs=[{id:'map',label:'Overview'},{id:'photos',label:'Photos'}];viewer.setTabs(tabs);
      const button=document.querySelector('[data-tab="photos"]');button.focus();viewer.setTabs(tabs.map(tab=>({...tab})));
      return button===document.querySelector('[data-tab="photos"]') && document.activeElement===button;
    }),true);
  }finally{await browser.close();}
});


test('opening Schedule visibility uses the incoming project instead of stale modal state',async()=>{
  const app=await source('libraries/apps/project-request/app.js');
  const fn=name=>{
    const start=app.indexOf(`  function ${name}(`);
    assert.ok(start>=0);
    return app.slice(start,app.indexOf('\n  }',start)+4);
  };
  // This predicate is intentionally a single line in the application.
  const predicate=app.match(/  function schedulePreviewAvailable\([^\n]+/)[0];
  let enabled=true;
  const context={
    activeBaseProject:null,addressSelected:false,schedulingEnabled:()=>enabled,
    PROJECT_MODAL_APP_PREFIX:'project.',
    projectModalRuntimeContext:()=>({schedulePreviewAvailable:false}),
    projectModalTabId:meta=>meta.id.replace('project.',''),
    projectModalAppsShouldInlineMap:()=>false,docWorkflowStandaloneActive:()=>false,
    window:{Portal:{},FirstMateEmbeddableApps:{listApps:ctx=>[
      {id:'project.map',app:{kind:'project_modal_app'}},
      ...(ctx.schedulePreviewAvailable ? [{id:'project.schedule',app:{kind:'project_modal_app'}}] : [])
    ]}}
  };
  vm.createContext(context);
  vm.runInContext(predicate+'\n'+fn('projectModalApps'),context);
  const ids=project=>Array.from(context.projectModalApps({opening:true,project}),app=>app.id);
  assert.deepEqual(ids({id:'project_incoming'}),['map','schedule']);
  enabled=false;
  assert.deepEqual(ids({id:'project_incoming'}),['map'],'disabled scheduling stays hidden');
  enabled=true;
  context.activeBaseProject={id:'previous_project'};context.addressSelected=true;
  assert.deepEqual(ids(null),['map'],'a new empty project does not inherit Schedule from the previous modal');
});
