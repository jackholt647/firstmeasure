import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

async function fixture(browser,{manager=true}={}){
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
    window.CommsAPI={customer:async(_org,path)=>{
      requests.push(path);
      if(path.startsWith('call-lists/queue'))return {department_context:context,can_manage_departments:manager,columns:listColumns};
      if(path.startsWith('call-scripts'))return {scripts:[{id:'script-one',title:'Sales opening',version:2,status:'published',data:{sections:[{title:'Opening',body:'Ask about their project.'}]}}]};
      if(path.startsWith('voice/center'))return {department_context:context,calls:[liveCall],agents:[{user_id:'rep-two',name:'Bea Rep',availability:'busy'},{user_id:'rep-one',name:'Ada Rep',availability:'available'}]};
      if(path.startsWith('calls?'))return path.includes('owner_user_id=')?{department_context:context,calls:ownCalls,total:1,next_cursor:null}:{department_context:context,calls:[],total:4};
      return {};
    }};
  },{manager});
  for(const file of ['communications-ui.js','workspace.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/comms/'+file,import.meta.url),'utf8')});
  await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
  await page.evaluate(()=>window.handle=Portal.CommunicationsWorkspace.mount(document.querySelector('#app'),{standalone:'center'}));
  await page.waitForFunction(()=>document.querySelector('[data-content]')?.getAttribute('aria-busy')==='false');
  return {page,errors};
}

test('three Call Center screens wire personal history, queue controls and department scoped supervision',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await fixture(browser);
    assert.equal(await page.locator('[role=tab]').count(),3);
    assert.equal(await page.getByText('Sales opening').count(),1);
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
