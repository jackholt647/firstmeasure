import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';
const source=await readFile(new URL('../../libraries/apps/settings/departments.js',import.meta.url),'utf8');
const scheduling=await readFile(new URL('../../libraries/platform-scheduling/platform-scheduling.js',import.meta.url),'utf8');

test('calendar configuration uses organization departments and invalidates cached branch views after edits',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    await page.evaluate(()=>{
      window.departmentName='Dispatch';window.departmentReads=0;
      window.PlatformAPI={branchModules:{get:async()=>({data:{appointment_catalog:{departments:[{id:'old',label:'Old branch department'}]}}})},workforce:{departments:async()=>{window.departmentReads++;return {departments:[{id:'dispatch',label:window.departmentName}],groups:[]};}}};
    });
    await page.addScriptTag({content:scheduling});
    const first=await page.evaluate(()=>window.PlatformScheduling.loadBranchConfig('org','east'));
    assert.deepEqual(first.appointment_catalog.departments,[{id:'dispatch',label:'Dispatch'}]);
    assert.deepEqual(first.scheduling.appointment_catalog,first.appointment_catalog);
    await page.evaluate(()=>window.PlatformScheduling.loadBranchConfig('org','east'));
    assert.equal(await page.evaluate(()=>window.departmentReads),1);
    await page.evaluate(()=>{window.departmentName='Dispatch updated';window.dispatchEvent(new CustomEvent('fm:departments:updated'));});
    const next=await page.evaluate(()=>window.PlatformScheduling.loadBranchConfig('org','east'));
    assert.equal(next.appointment_catalog.departments[0].label,'Dispatch updated');
    assert.equal(await page.evaluate(()=>window.departmentReads),2);
  }finally{await browser.close();}
});

test('department settings create role and generic group defaults, show inherited memberships, and preserve failed drafts',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost/**',route=>route.fulfill({body:'<main id="host"></main><div id="person"></div>',contentType:'text/html'}));await page.goto('http://localhost/');
    await page.evaluate(()=>{
      window.saved=[];window.rejectNext=false;
      window.state={revision:1,legacy_token:'',departments:[{id:'sales',label:'Sales',color:'#123456',group_id:'',subject_keys:[],role_ids:['sales-role'],group_kind_ids:[]}],groups:[],users:[{id:'alex',name:'Alex',role_ids:['sales-role']}],roles:[{id:'sales-role',name:'Salesperson'}],group_kinds:[{id:'dispatch',name:'Dispatch team'}],resource_groups:[{id:'dispatch-a',name:'Dispatch A',kind_id:'dispatch'}],can_manage:true,can_assign:{user:true,role:true,group:true,group_kind:true}};
      window.PlatformAPI={workforce:{departments:async()=>structuredClone(window.state),saveDepartments:async(_org,payload)=>{
        if(window.rejectNext){window.rejectNext=false;throw Error('Departments changed. Reload before saving.');}
        window.saved.push(payload);Object.assign(window.state,payload,{revision:window.state.revision+1});return structuredClone(window.state);
      },saveDepartmentAssignment:async(_org,payload)=>{
        window.saved.push(payload);
        const field=payload.kind==='role'?'role_ids':payload.kind==='group_kind'?'group_kind_ids':'subject_keys';
        const value=payload.kind==='user'?`organization_user:${payload.id}`:payload.kind==='group'?`resource_group:${payload.id}`:payload.id;
        window.state.departments.forEach(d=>{d[field]=d[field].filter(v=>v!==value);if(payload.department_ids.includes(d.id))d[field].push(value);});window.state.revision++;return structuredClone(window.state);
      }}};
    });
    await page.addScriptTag({content:source});
    await page.evaluate(()=>window.FirstMateDepartments.mount(document.querySelector('#host'),'org'));
    await page.getByRole('button',{name:'+ Create department',exact:true}).click();
    await page.locator('[data-dp-name]').fill('Dispatch');
    await page.locator('[data-dp-field=role_ids]').check();
    await page.locator('[data-dp-field=group_kind_ids]').check();
    await page.locator('[data-dp-field=users]').check();
    await page.locator('[data-dp-save]').click();
    await page.getByText('Department saved.',{exact:true}).waitFor();
    const saved=await page.evaluate(()=>window.saved[0]);const dispatch=saved.departments.find(d=>d.label==='Dispatch');
    assert.deepEqual(dispatch.role_ids,['sales-role']);assert.deepEqual(dispatch.group_kind_ids,['dispatch']);assert.deepEqual(dispatch.subject_keys,['organization_user:alex']);
    await page.evaluate(()=>window.FirstMateDepartments.mountAssignment(document.querySelector('#person'),'org','group','dispatch-a'));
    assert.match(await page.locator('#person').innerText(),/Inherited from group type/);
    await page.locator('#person [data-dp-assignment][value=sales]').check();
    await page.locator('#person [data-dp-save-assignment]').click();
    await page.locator('#person').getByText('Departments saved.',{exact:true}).waitFor();
    assert.match(await page.locator('#person').innerText(),/Inherited memberships: Dispatch/);
    await page.locator('[data-dp-name]').fill('Dispatch revised');await page.evaluate(()=>window.rejectNext=true);
    await page.locator('[data-dp-save]').click();await page.getByText('Departments changed. Reload before saving.',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-dp-name]').inputValue(),'Dispatch revised');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.DEPARTMENT_SCREENSHOTS){await mkdir('../../output/departments-ui',{recursive:true});await page.locator('[data-dp-refresh]').click();await page.locator('[data-dp-name]').waitFor();await page.screenshot({path:'../../output/departments-ui/mobile.png',fullPage:true});await page.setViewportSize({width:1100,height:900});await page.screenshot({path:'../../output/departments-ui/desktop.png',fullPage:true});}
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});


test('department search opens the Users sub-tab with either user UI and retains its route',async()=>{
  const shell=(await readFile(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  const catalog=await readFile(new URL('../../libraries/apps/settings/search.js',import.meta.url),'utf8');
  const behavior=shell.slice(shell.indexOf('    function setUsersView('),shell.indexOf('    if(paneUsers) {',shell.indexOf('    function setUsersView(')));
  assert.ok(!shell.includes("{ id:'departments',"));
  assert.ok(shell.includes('data-users-view="departments"'));
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    for(const advanced of [true,false]) {
      const page=await browser.newPage();
      await page.setContent('<main id="csPaneUsers"><nav><button data-users-view="people">People</button><button data-users-view="departments">Departments</button></nav><section data-users-view-panel="people">User list</section><section data-users-view-panel="departments" hidden></section></main>');
      await page.evaluate(advanced=>{window.routes=[];window.Portal={appFlags:{has:()=>advanced},navigation:{navigate:route=>window.routes.push(route)}};},advanced);
      await page.addScriptTag({content:catalog});
      const route=await page.evaluate(()=>{
        for(const query of ['department','departments','user department','department defaults']) {
          const [hit]=FirstMateSettingsSearch.search(query,{sections:['users']});
          if(!hit||hit.section!=='users'||hit.view!=='departments')throw Error('Wrong department route: '+query);
        }
        const [hit]=FirstMateSettingsSearch.search('department',{sections:['users']});FirstMateSettingsSearch.open(hit);return window.routes[0];
      });
      assert.equal(route.settingsView,'departments');assert.equal(route.sub,'users');
      await page.evaluate(({behavior,route})=>{
        window.mounts=0;window.state={};
        window.setUsersView=new Function('panel','$','allowedUsersViews','viewState','writeSettingsRoute','departmentUi','scheduleSettingsSubtabsSync',behavior+';return setUsersView;')(document,(selector,host)=>host.querySelector(selector),['people','departments'],window.state,r=>window.routes.push(r),host=>{window.mounts++;host.innerHTML='<h3>Organization departments</h3><button>Create department</button>';},()=>{});
        setUsersView(route.settingsView,false);
      },{behavior,route});
      assert.equal(await page.locator('[data-users-view-panel=departments]').isVisible(),true);
      assert.equal(await page.locator('[data-users-view-panel=people]').isVisible(),false);
      await page.evaluate(()=>{setUsersView('people');setUsersView('departments');});
      assert.equal(await page.evaluate(()=>window.mounts),1);
      assert.equal(await page.evaluate(()=>window.routes.at(-1).settingsView),'departments');
      await page.close();
    }
  } finally {await browser.close();}
});
