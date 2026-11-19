import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// GP-65: "Who does the work" is one question, the shared setup step company.workforce (setup-steps/company-profile.js,
// part `workforce`), which the workforce setup requires as the appointment setup does. Answered, the workforce setup's
// own pages start at how many; Back still reaches the question, drawn by the shared step with its icon tiles, and a
// change is saved to the company profile. Unanswered (nobody asked it before), the same shared step is its first page.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const L=`(key,fallback)=>typeof key==='object'&&key?key.text:fallback`;
async function open(browser,workforce){
  const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://workforce-setup.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
    return route.fulfill({contentType:'text/html',body:'<div class="gxs" data-kind="modal"><div class="gxs-step"><div class="gxs-titlebar"><h2>Step</h2></div><main id="step"></main></div></div>'});
  });
  await page.goto('https://workforce-setup.test/');
  await page.addScriptTag({content:`window.esc=${esc.toString()};`});
  await page.evaluate(async ({L,workforce})=>{
    const copy=(id,text,hint)=>({id,label:{key:'gx_workforce_'+id,text},hint:{key:'gx_workforce_'+id+'_hint',text:hint}});
    const workforces=[copy('just_me','Just me','I do the work myself.'),copy('crews','Our own crews','Teams of our own people do the work.'),copy('subcontractors','Subcontractors','Outside companies do the work for us.'),copy('crews_and_subs','Crews and subcontractors','Some work is ours, some goes to outside companies.')];
    const profile={workforce,services:[{id:'roof_replacement',label:'Roof replacement'}],work_kinds:['roofing']};
    window.saved=[];
    window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{saved.push({action,input});return {value:{}};}}};
    window.__APP={userOrgId:'o',userId:'me',userName:'Mia Owner'};
    const read=async(provider,name)=>provider==='workforce-setup'?{profile,workforces,assignees:[],people:[]}:name==='catalog'?{workforces}:{workforce};
    const module=await import('/libraries/guided-experiences/workforce-setup.js');
    window.handle=module.mount(document.querySelector('#step'),{options:{},L:eval(L),esc,read,change(){},syncBack(){}});
  },{L,workforce});
  return {page,errors};
}

test('answered: the setup starts at how many; Back is the shared step, and a change is saved',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser,'crews');
    await page.locator('[data-gxw-page="count"]').waitFor();
    assert.equal(await page.evaluate(()=>handle.backDepth()),1,'the phone\'s back reaches the question');
    await page.locator('[data-gxw-back]').click();
    await page.locator('[data-gxw-page="who"] [data-team]').first().waitFor();
    // The shared step's tiles: the choice row, an icon each, the answer given before picked.
    assert.equal(await page.locator('[data-gxw-page="who"] .gxs-choices>.gxc-choice.gxs-choice').count(),4);
    assert.deepEqual(await page.locator('[data-team] .gxs-choice-icon i').evaluateAll(nodes=>nodes.map(node=>[...node.classList].find(name=>name!=='fas'))),['fa-user','fa-users','fa-handshake','fa-users-gear']);
    assert.equal(await page.getByRole('radio',{name:/Our own crews/}).getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('.gxs-titlebar h2').textContent(),'Who does most of the work?');
    await page.getByRole('radio',{name:/^Subcontractors/}).click();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="count"]').waitFor();
    assert.deepEqual(await page.evaluate(()=>saved),[{action:'company-profile.save',input:{workforce:'subcontractors'}}]);
    assert.equal(await page.locator('[data-gxw-count="organization_connection"]').count(),1,'how many asks for subcontractors now');
    assert.equal(await page.locator('[data-gxw-count="resource_group"]').count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('"just me" starts at naming the work, and nothing is saved when the answer stays',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser,'just_me');
    await page.locator('[data-gxw-page="work"]').waitFor();
    await page.locator('[data-gxw-back]').first().click();
    await page.locator('[data-gxw-page="who"] [data-team]').first().waitFor();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="work"]').waitFor();
    assert.deepEqual(await page.evaluate(()=>saved),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('unanswered: the shared step is the first page, and Continue needs an answer',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser,'');
    await page.locator('[data-gxw-page="who"] [data-team]').first().waitFor();
    await page.locator('[data-gxw-next]').click();
    assert.equal(await page.locator('[data-gxw-error]').textContent(),'Choose who does the work to continue.');
    await page.getByRole('radio',{name:/Crews and subcontractors/}).click();
    assert.equal(await page.locator('[data-gxw-error]').textContent(),'');
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="count"]').waitFor();
    assert.equal(await page.locator('[data-gxw-count]').count(),2);
    assert.deepEqual(await page.evaluate(()=>saved),[{action:'company-profile.save',input:{workforce:'crews_and_subs'}}]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
