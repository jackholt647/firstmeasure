import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const load=async(page,file)=>page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('contact uses shared chrome, weighted panes, retained form nodes and optional trays',async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage({viewport:{width:1400,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<style>body{margin:0;font:14px Arial}main{position:relative;width:1400px;height:900px}</style><main class="main"><div id="mainPanels"></div></main>');
    await page.evaluate(()=>{
      window.Portal={cfg:{orgId:'org'},modules:{},ProjectStore:{list:()=>[],getAll:()=>[],saveRemote:async p=>p},PhotoFeed:{mountProjectGallery:node=>{node.innerHTML='<textarea aria-label="Media draft"></textarea>';}}};
      window.PlatformAPI={contacts:{settings:async()=>({settings:{tags:[]}}),projects:async()=>({projects:[]})}};
    });
    for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','apps/contacts/modal.js'])await load(page,file);
    await page.evaluate(async()=>{
      await Portal.modules.contacts.open({}, {layout:{panes:[{tab:'projects',weight:40},{tab:'media',weight:60}]}});
      window.nameNode=document.querySelector('#fmContactName');nameNode.value='Unsaved name';
    });
    assert.equal(await page.locator('[data-contact-pane]:visible').count(),2);
    const a=await page.locator('[data-contact-pane=projects]').boundingBox(),b=await page.locator('[data-contact-pane=media]').boundingBox();
    assert.ok(Math.abs(a.width/(a.width+b.width)-.4)<.01);
    assert.equal(await page.locator('.fm-shell-header').evaluate(e=>e.clientHeight),35);
    assert.equal(await page.locator('#fmContactProjectsTab').evaluate(e=>e.offsetHeight),32);
    await page.getByRole('textbox',{name:'Media draft'}).fill('Keep media draft');
    await page.evaluate(()=>Portal.modules.contacts.setLayout({panes:[{tab:'media',weight:3},{tab:'projects',weight:1}],sidebar:false,tabStyle:'pills'}));
    assert.equal(await page.locator('.fm-contact-left').isVisible(),false);
    assert.equal(await page.evaluate(()=>nameNode===document.querySelector('#fmContactName')),true);
    assert.equal(await page.locator('#fmContactName').inputValue(),'Unsaved name');
    assert.equal(await page.getByRole('textbox',{name:'Media draft'}).inputValue(),'Keep media draft');
    await page.evaluate(async()=>{
      window.mounted=0;window.destroyed=0;
      window.unregister=await Portal.modules.contacts.registerTray({id:'test',label:'Test tray',mount(node){mounted++;node.innerHTML='<textarea aria-label="Tray draft"></textarea>';return {destroy(){destroyed++;}};}});
      await Portal.modules.contacts.setLayout({tray:'test',tabs:false});
    });
    await page.getByRole('textbox',{name:'Tray draft'}).fill('Keep tray draft');
    await page.evaluate(()=>Portal.modules.contacts.setLayout({tray:'test'}));
    assert.equal(await page.evaluate(()=>mounted),1);
    assert.equal(await page.getByRole('textbox',{name:'Tray draft'}).inputValue(),'Keep tray draft');
    assert.equal(await page.locator('.fm-contact-tabs').isVisible(),false);
    assert.equal(await page.getByRole('button',{name:'Test tray',exact:true}).isVisible(),true);
    await assert.rejects(page.evaluate(()=>Portal.modules.contacts.setLayout({panes:[{tab:'missing'}],sidebar:true})),/Unavailable/);
    assert.equal(await page.locator('.fm-contact-left').isVisible(),false,'invalid layout does not partially apply');
    await page.evaluate(()=>Portal.modules.contacts.setLayout({tray:null,sidebar:true,tabs:true}));
    await page.locator('.fm-shell-divider').press('ArrowLeft');
    await page.locator('[data-window-action=minimize]').click();
    assert.equal(await page.locator('.fm-contact-content').isVisible(),false);
    await page.locator('[data-window-action=minimize]').click();
    await page.evaluate(()=>Portal.modules.contacts.close({skipHistory:true}));
    assert.equal(await page.evaluate(()=>destroyed),1);
    await page.evaluate(()=>Portal.modules.contacts.open({}, {tab:'projects'}));
    assert.equal(await page.locator('[data-contact-pane]:visible').count(),1);
    assert.equal(await page.locator('.fm-contact-left').isVisible(),true);
    assert.equal(await page.locator('.fm-shell-tray').isVisible(),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('project weighted layout validates before changes and places trays after all panes',async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage({viewport:{width:1600,height:900}});
    await page.route('https://shell.test/**',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}));
    await page.goto('https://shell.test/');
    await page.setContent('<style>.r-win{height:800px}.r-right{display:flex;flex-direction:column}.r-preview{flex:1}</style><div class="r-overlay"><section class="r-win"><div class="r-right"><header class="r-window-bar r-modal-header"><span class="r-window-identity">Project</span><nav class="r-tabbar"><button data-tab="map">Overview</button><button data-tab="photos">Photos</button><button data-tab="denied" disabled>Denied</button></nav></header><div class="r-preview"></div></div></section></div>');
    for(const file of ['window-manager/window-shell.js','window-manager/project-layout.js','project-trays/project-trays.js'])await load(page,file);
    await page.evaluate(()=>{
      window.Portal={can:key=>key!=='apps.assistant',ProjectNotes:{mount:node=>{node.textContent='Notes';return {};}}};
      window.tab='map';window.project={id:'project_test'};
      window.layout=FirstMateProjectLayout.mount({overlay:document.querySelector('.r-overlay'),getProject:()=>project,getTab:()=>tab,setTab:value=>{tab=value;}});
      window.trays=FirstMateProjectTrays.mount(document.querySelector('.r-right'),{content:document.querySelector('.r-project-body'),getProject:()=>project});
      window.shell=FirstMateWindowShell.mount({element:document.querySelector('.r-win'),header:document.querySelector('header'),tabs:document.querySelector('.r-tabbar'),panes:layout,trays,headerRows:2});
      shell.apply({panes:[{tab:'photos',weight:40},{tab:'map',weight:60}],tray:'notes'});
    });
    assert.deepEqual(await page.evaluate(()=>layout.panes),['photos','map']);
    assert.equal(await page.locator('.fm-project-content>.r-project-body').count(),1);
    assert.equal(await page.locator('.r-project-body .fm-project-tray').count(),0);
    const a=await page.locator('.r-project-main-pane').boundingBox(),b=await page.locator('.r-project-docked-pane').boundingBox();
    assert.ok(Math.abs(a.width/(a.width+b.width)-.6)<.01);
    assert.ok(b.x<a.x, 'requested pane order is visual order');
    await page.evaluate(()=>shell.apply({tray:'notes'}));
    assert.equal(await page.locator('.fm-project-content').getAttribute('data-tray-open'),'true');
    for(const input of [{panes:[{tab:'denied'}]},{panes:[{tab:'map',weight:0}]},{panes:[{tab:'map'},{tab:'map'}]},{tray:'agent'},{sidebar:true}]){
      await assert.rejects(page.evaluate(input=>shell.apply(input),input));
      assert.deepEqual(await page.evaluate(()=>layout.panes),['photos','map']);
    }
    await page.evaluate(()=>shell.apply({panes:[{tab:'map'}],tray:null,tabs:false}));
    assert.equal(await page.locator('.r-project-docked-pane').count(),0);
    assert.equal(await page.locator('.r-tabbar').isVisible(),false);
    assert.equal(await page.locator('.fm-project-content').getAttribute('data-tray-open'),'false');
    await page.evaluate(()=>{layout.destroy();trays.destroy();});
  }finally{await browser.close();}
});

test('retained project windows accept pending and layout-only reopen requests',async()=>{
  const browser=await launch();
  try{
    const page=await browser.newPage();
    await page.route('https://shell.test/**',route=>route.fulfill({contentType:'text/html',body:'<main class="main"></main>'}));
    await page.goto('https://shell.test/');
    await page.evaluate(()=>{window.FirstMateWindows={};window.Portal={};});
    await load(page,'window-manager/project-windows.js');
    await page.evaluate(()=>{
      window.record=FirstMateProjectWindows.open({id:'p'});
      FirstMateProjectWindows.open({id:'p'},{layout:{panes:[{tab:'photos',weight:2},{tab:'map',weight:1}]}});
    });
    await page.waitForFunction(()=>document.querySelector('iframe').contentDocument?.readyState==='complete');
    await page.evaluate(async()=>{
      window.calls=[];
      FirstMateProjectWindows.ready(record.token,record.frame.contentWindow,{async openProject(project,options){calls.push(options);if(options.layout?.tray==='invalid')throw Error('Unavailable tray');return project;}});
      await record.ready;
    });
    assert.equal(await page.evaluate(()=>calls[0].layout.panes[0].tab),'photos');
    await page.evaluate(async()=>{FirstMateProjectWindows.open({id:'p'},{layout:{tray:'notes'}});await record.ready;});
    assert.equal(await page.evaluate(()=>calls[1].layout.tray),'notes');
    assert.equal(await page.evaluate(()=>FirstMateProjectWindows.size),1);
    await assert.rejects(page.evaluate(async()=>{FirstMateProjectWindows.open({id:'p'},{layout:{tray:'invalid'}});await record.ready;}),/Unavailable tray/);
    await page.evaluate(async()=>{FirstMateProjectWindows.open({id:'p'},{layout:{tray:null}});await record.ready;});
    assert.equal(await page.evaluate(()=>calls.at(-1).layout.tray),null);
  }finally{await browser.close();}
});
