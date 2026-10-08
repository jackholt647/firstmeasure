import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('header to-dos work without a left column, retain the list across placements, honor the flag and support mobile',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<style>body{margin:0}.main{position:relative;height:100vh}#platformTopbar{height:50px}#mainPanels{height:800px}</style><main class="main"><header id="platformTopbar"><div id="platformPhoneSlot"></div><div id="platformAssistantSlot"></div></header><div id="mainPanels"></div><div id="mobilePlatformMoreMenu"></div></main>');
    await page.evaluate(()=>{
      window.flag=true;window.reads=[];window.branch='default';window.__APP={userOrgId:'org',userId:'user'};
      window.Portal={cfg:__APP,can:key=>key==='topbar.todos'?flag:true,topbar:{isVisible:()=>true},branchModules:{currentBranchId:()=>branch}};
      window.PlatformAPI={actionItems:{list:async(org,query)=>{reads.push({org,query});return {items:[{id:'t1',title:'Call Jane',kind:'manual',status:'open',assigned_user_ids:['user'],project_ids:['p1'],project_title:'Jane project'}]};}},work:{configuration:async()=>({})}};
    });
    for(const file of ['window-manager/window-manager.js','platform-action-items/platform-action-items.js','platform-action-items/todo-tray.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await page.getByRole('button',{name:'To Do',exact:true}).first().click();
    await page.getByText('Call Jane',{exact:true}).waitFor();
    assert.equal(await page.locator('.fm-todo-tray').getAttribute('data-window'),'docked');
    assert.equal(await page.evaluate(()=>reads[0].query.projectId||''),'');
    assert.equal(await page.locator('.fm-todo-tray [data-window-action=minimize]').isVisible(),false);
    assert.equal(await page.locator('.fm-todo-body').evaluate(element=>getComputedStyle(element).padding),'12px');
    await page.locator('.fm-todo-tray [data-window-action=place]').click({button:'right'});
    await page.getByRole('menuitem',{name:'Float',exact:true}).click();
    assert.equal(await page.locator('.fm-todo-tray').getAttribute('data-window'),'floating');
    await page.locator('.fm-todo-tray [data-window-action=close]').click();
    assert.equal(await page.locator('.fm-todo-tray').isVisible(),false);
    await page.getByRole('button',{name:'To Do',exact:true}).first().click();
    assert.equal(await page.getByText('Call Jane',{exact:true}).count(),1);
    assert.equal(await page.locator('.fm-todo-tray').getAttribute('data-window'),'docked');
    await page.evaluate(()=>{flag=false;window.dispatchEvent(new Event('fm:capabilities:updated'));});
    assert.equal(await page.locator('#platformTodoSlot').isVisible(),false);assert.equal(await page.locator('.fm-todo-tray').isVisible(),false);
    await page.evaluate(()=>{flag=true;window.dispatchEvent(new Event('fm:capabilities:updated'));});
    await page.setViewportSize({width:390,height:844});
    await page.locator('#mobilePlatformMoreTodos').click();await page.getByText('Call Jane',{exact:true}).waitFor();
    const box=await page.locator('.fm-todo-tray').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391&&box.y+box.height<=845,JSON.stringify(box));
    await page.keyboard.press('Escape');assert.equal(await page.locator('.fm-todo-tray').isVisible(),false);
    await page.evaluate(()=>{branch='second';window.dispatchEvent(new Event('fm:branch-module:updated'));});
    await page.locator('#mobilePlatformMoreTodos').click();await page.getByText('Call Jane',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>reads.at(-1).query.branchId),'second');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});


