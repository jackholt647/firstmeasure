import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

async function fixture(browser,{manager=true,mount={standalone:'center'}}={}){
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://call-center.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font-family:Arial;background:#f5f7fa}</style><main id="app"></main>'}));
  await page.goto('https://call-center.test');
  await page.evaluate(({manager})=>{
    window.__APP={orgId:'org-test',userId:'rep-one'};
    window.requests=[];window.phoneActions=[];
    window.context={show_selector:true,department_label:'Department',departments_label:'Departments',departments:[{id:'sales',label:'Sales'},{id:'service',label:'Service'}]};
    window.listColumns=[{id:'sales-list',key:'sales-list',title:'Sales prospects',tasks:[{id:'lead-one',name:'Ada',phone:'+12025550101',ready:true}]},{id:'service-list',key:'service-list',title:'Service follow-ups',tasks:[{id:'lead-two',name:'Bea',phone:'+12025550102',ready:true}]}];
    window.ownCalls=[{id:'own-call',owner_user_id:'rep-one',mode:'browser',customer_name:'Ada',customer_number:'+12025550101',direction:'outbound',state:'ended',created_at:new Date().toISOString(),connected_at:new Date(Date.now()-60000).toISOString(),ended_at:new Date().toISOString()}];
    window.liveCall={id:'live-call',owner_user_id:'rep-two',customer_name:'Bea',customer_number:'+12025550102',state:'connected',supervision:{permissions:{monitor:true,whisper:true,barge:false,takeover:true}}};
    const status={settings:{enabled:true},permissions:{manage:manager,monitor:manager,whisper:manager,takeover:manager,recordings:true}};
    window.AppChrome={resolve:()=> 'center',header:()=>'',tabs:()=>'',settingsTabs:()=>''};
    window.Portal={navigation:{registerSchema(){},registerHandler(){},read:()=>({})},CustomerPhone:{
      status,dialer:{active:false},currentCall:null,refreshStatus:async()=>status,
      open:async(input,options)=>{phoneActions.push({kind:'open',input,options});return true;},
      startDialer:async options=>{phoneActions.push({kind:'power',options});},
      pauseDialer:message=>{phoneActions.push({kind:'pause',message});},
      supervise:async mode=>{phoneActions.push({kind:'supervise',mode});}
    }};
    // Call scripts are `call` flows, listed by the flows API (docs/architecture/flows.md).
    window.FirstMateFlows={api:async path=>{requests.push(`flows:${path}`);return path==='/flows'?{can_edit:manager,flows:[{id:'script-one',name:'Sales opening',kind:'call',description:'Ask about their project.',published_version:2,latest_version:2,archived:false},{id:'draft-one',name:'Unpublished draft',kind:'call',published_version:0,latest_version:1,archived:false},{id:'workflow-one',name:'Not a script',kind:'workflow',published_version:1,latest_version:1,archived:false}]}:{};}};
    window.CommsAPI={customer:async(_org,path)=>{
      requests.push(path);
      if(path.startsWith('call-lists/queue'))return {department_context:context,can_manage_departments:manager,columns:listColumns};
      if(path.startsWith('voice/center'))return {department_context:context,calls:[liveCall],agents:[{user_id:'rep-two',name:'Bea Rep',availability:'busy'},{user_id:'rep-one',name:'Ada Rep',availability:'available'}]};
      if(path.startsWith('calls?'))return path.includes('owner_user_id=')?{department_context:context,calls:ownCalls,total:1,next_cursor:null}:{department_context:context,calls:[],total:4};
      return {};
    }};
  },{manager});
  for(const file of ['communications-ui.js','workspace.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/comms/'+file,import.meta.url),'utf8')});
  await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
  await page.evaluate(options=>window.handle=Portal.CommunicationsWorkspace.mount(document.querySelector('#app'),options),mount);
  await page.waitForFunction(()=>document.querySelector('[data-content]')?.getAttribute('aria-busy')==='false');
  return {page,errors};
}

test('three Call Center screens wire personal history, queue controls and department scoped supervision',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await fixture(browser);
    assert.equal(await page.locator('[role=tab]').count(),3);
    assert.equal(await page.getByText('Sales opening').count(),1);
    assert.equal(await page.getByText('Unpublished draft').count(),0,'only published call flows are offered in a call');
    assert.equal(await page.getByText('Not a script').count(),0);
    await page.getByRole('button',{name:'Call Next'}).click();
    assert.equal(await page.evaluate(()=>phoneActions.at(-1).input.entry.id),'lead-one');
    await page.locator('[data-center-dial-mode]').selectOption('power');
    await page.getByRole('button',{name:'Start power dialing'}).click();
    assert.deepEqual(await page.evaluate(()=>phoneActions.at(-1).options.listIds),['sales-list','service-list']);
    await page.getByRole('tab',{name:'Personal'}).click();
    await page.getByText('Your call history').waitFor();
    assert.ok(await page.evaluate(()=>requests.some(path=>path.includes('owner_user_id=rep-one'))));
    await page.getByRole('button',{name:'Recording & transcript'}).click();
    assert.deepEqual(await page.evaluate(()=>phoneActions.at(-1)),{kind:'open',input:{call_id:'own-call'},options:{artifacts:true}});
    await page.locator('[data-center-direction]').selectOption('inbound');
    await page.waitForFunction(()=>requests.some(path=>path.includes('direction=inbound')));
    await page.getByRole('tab',{name:'Manager view'}).click();
    await page.getByText('Bea Rep').waitFor();
    assert.equal(await page.getByRole('button',{name:'Barge in'}).count(),0);
    await page.locator('[data-action=center-list-toggle]').first().click();
    await page.getByRole('button',{name:'Remove'}).click();
    assert.equal(await page.evaluate(()=>requests.filter(path=>path.includes('call-list-entries/')).length),0);
    await page.locator('dialog').getByRole('button',{name:'Remove lead'}).click();
    await page.waitForFunction(()=>requests.includes('call-list-entries/lead-one'));
    await page.locator('[data-department]').selectOption('sales');
    await page.waitForFunction(()=>requests.some(path=>path.startsWith('voice/center?department_id=sales')));
    await page.getByRole('button',{name:'Listen'}).click();
    assert.equal(await page.evaluate(()=>phoneActions.at(-1).mode),'monitor');
    await page.getByRole('button',{name:'Take over'}).click();
    assert.equal(await page.evaluate(()=>phoneActions.filter(action=>action.mode==='takeover').length),0);
    await page.locator('dialog').getByRole('button',{name:'Take over'}).click();
    await page.waitForFunction(()=>phoneActions.some(action=>action.mode==='takeover'));
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.evaluate(()=>handle.destroy());
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('caller without supervisor grant sees the two permitted screens',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{const {page,errors}=await fixture(browser,{manager:false});assert.equal(await page.locator('[role=tab]').count(),2);assert.equal(await page.getByRole('tab',{name:'Manager view'}).count(),0);await page.evaluate(()=>handle.destroy());assert.deepEqual(errors,[]);}finally{await browser.close();}
});

// FM-491: a project's Calls and the call history had "Call contact" / "Log a call" beside the toolbar's "New call",
// two buttons that opened the same phone. One New call stays, with the phone options beside it.
test('call history offers one New call, on a project and in the workspace',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    for(const mount of [{projectId:'project-one'},{standalone:'history'},{standalone:'lists'}]){
      const {page,errors}=await fixture(browser,{mount});
      await page.locator('[data-action=new-call]').first().waitFor();
      assert.equal(await page.locator('[data-action=new-call]').count(),1,JSON.stringify(mount));
      assert.equal(await page.getByRole('button',{name:/call contact|log a call/i}).count(),0);
      // FM-511: on a project New call is an icon (named for screen readers) and the toolbar has no title or own search.
      if(mount.projectId){
        assert.equal((await page.locator('[data-action=new-call]').innerText()).trim(),'');
        assert.equal(await page.getByRole('button',{name:'New call'}).count(),1);
        assert.equal(await page.locator('.fmcm-toolbar h3, .fmcm-toolbar [data-search]').count(),0);
      }else{
        assert.equal((await page.locator('[data-action=new-call]').innerText()).trim(),'New call');
        assert.equal(await page.locator('.fmcm-toolbar h3').count(),1);
      }
      // FM-536: the phone connects when you call, so no connection state is shown. A project shows only New call;
      // the workspace's phone button is about taking incoming calls.
      assert.equal(await page.getByText(/Phone off|Connecting…/).count(),0);
      if(mount.projectId)assert.equal(await page.locator('[data-action=phone-menu]').count(),0);
      else{
        assert.equal((await page.locator('.fmcm-call-actions [data-action=phone-menu]').innerText()).trim(),'Not taking calls');
        assert.equal(await page.getByRole('button',{name:/^Incoming calls: Not taking calls/}).count(),1);
      }
      await page.locator('[data-action=new-call]').click();
      assert.deepEqual(await page.evaluate(()=>phoneActions.at(-1).input),{project_id:mount.projectId||''});
      if(mount.projectId){
        // The project's Comms tab search filters these calls through the handle.
        await page.evaluate(()=>handle.search('ada'));
        await page.waitForFunction(()=>requests.some(path=>path.startsWith('calls?')&&path.includes('query=ada')&&path.includes('project_id=project-one')));
      }
      await page.evaluate(()=>handle.destroy());
      assert.deepEqual(errors,[]);
      await page.close();
    }
  }finally{await browser.close();}
});
