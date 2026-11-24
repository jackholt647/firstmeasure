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
async function open(browser,workforce,extra={}){
  const page=await browser.newPage({viewport:{width:extra.width||1100,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://workforce-setup.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+url.pathname,import.meta.url),'utf8')});
    return route.fulfill({contentType:'text/html',body:extra.html||'<div class="gxs" data-kind="modal"><div class="gxs-step"><div class="gxs-titlebar"><h2>Step</h2></div><main id="step"></main></div></div>'});
  });
  await page.goto('https://workforce-setup.test/');
  await page.addScriptTag({content:`window.esc=${esc.toString()};`});
  await page.evaluate(async ({L,workforce,extra})=>{
    const copy=(id,text,hint)=>({id,label:{key:'gx_workforce_'+id,text},hint:{key:'gx_workforce_'+id+'_hint',text:hint}});
    const workforces=[copy('just_me','Just me','I do the work myself.'),copy('crews','Our own crews','Teams of our own people do the work.'),copy('subcontractors','Subcontractors','Outside companies do the work for us.'),copy('crews_and_subs','Crews and subcontractors','Some work is ours, some goes to outside companies.')];
    const profile={workforce,services:[{id:'roof_replacement',label:'Roof replacement'}],work_kinds:['roofing']};
    const services=[{id:'roof_replacement',label:{key:'gx_service_roof_replacement',text:'Roof replacement'},terms:['reroof']},{id:'gutters',label:{key:'gx_service_gutters',text:'Gutters'},terms:['gutter','downspouts']},{id:'siding',label:{key:'gx_service_siding',text:'Siding'},terms:['vinyl siding']}];
    window.saved=[];
    // What each published action answers: someone added gets an id, an invite is sent.
    const answers={'workforce.users.add':input=>({user:{id:'u_'+input.name.split(' ')[0].toLowerCase(),name:input.name,email:input.email,status:'invited'}}),'workforce.users.invite':input=>({sent:input.user_ids.length,invites:input.user_ids.map(user_id=>({user_id,ok:true}))})};
    window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{saved.push({action,input});return {value:answers[action]?.(input)||{}};}}};
    window.__APP={userOrgId:'o',userId:'me',userName:'Mia Owner'};
    const read=async(provider,name)=>provider==='workforce-setup'?{profile,workforces,assignees:[],people:[],...(extra.status||{})}:name==='catalog'?{workforces,services}:{workforce};
    const module=await import('/libraries/guided-experiences/workforce-setup.js');
    window.wide=[];
    window.handle=module.mount(document.querySelector('#step'),{options:extra.options||{},L:eval(L),esc,read,change(){},syncBack(){},setWide(on){wide.push(on);}});
  },{L,workforce,extra});
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
    assert.equal(await page.locator('.gxs-titlebar h2').textContent(),'Who does the hands-on work on your jobs?');
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
    // GP-160: how many is the title and the counts, with no lead paragraph under the title.
    assert.equal(await page.locator('[data-gxw-page="count"] > p:not([data-gxw-error])').count(),0,'no lead under how many');
    assert.deepEqual(await page.evaluate(()=>saved),[{action:'company-profile.save',input:{workforce:'crews_and_subs'}}]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// GP-66: how many goes down to 0, both rows the same shape; more than three cards show part of the ones beside them;
// Other finds a service the profile left out; a crew's specialties, someone picked or added new, who is in charge;
// then, optionally, the invite to the app and what the crew sees.
const library=JSON.parse(await readFile(new URL('./fixtures/workforce-setup-library.json',import.meta.url),'utf8'));
const options=library.guided_experience.find(entry=>entry.id==='operations.workforce.setup').steps[0].options;
const people=[{id:'me',name:'Mia Owner',email:'mia@example.com',status:'active'},{id:'ana',name:'Ana Lopez',email:'ana@example.com',status:'active'},{id:'ben',name:'Ben Hart',email:'ben@example.com',status:'invited'}];
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('how many: the icon and the stepper are the same on both rows, and each can go down to 0, not both',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await open(browser,'crews_and_subs',{options});
    await page.locator('[data-gxw-page="count"]').waitFor();
    const sizes=await page.locator('[data-gxw-count]').evaluateAll(rows=>rows.map(row=>[row.querySelector('.gxw-icon').getBoundingClientRect().width,row.querySelector('.gxw-step').getBoundingClientRect().width,row.querySelector('.gxw-step').getBoundingClientRect().right]));
    assert.equal(sizes.length,2);
    assert.deepEqual(sizes[0],sizes[1],'same icon, same stepper, lined up');
    assert.equal(sizes[0][0],40);
    assert.ok(sizes[0][1]<130,`the stepper keeps its own width (${sizes[0][1]})`);
    const subs=page.locator('[data-gxw-count="organization_connection"]');
    await subs.locator('[data-gxw-minus]').click();
    assert.equal(await page.locator('[data-gxw-count="organization_connection"] input').inputValue(),'0');
    assert.equal(await page.locator('[data-gxw-count="organization_connection"] [data-gxw-minus]').isDisabled(),true);
    await page.locator('[data-gxw-count="resource_group"] [data-gxw-minus]').click();
    await page.locator('[data-gxw-next]').click();
    assert.equal(await page.locator('[data-gxw-error]').textContent(),'Count at least one to continue.');
    await page.locator('[data-gxw-count="resource_group"] input').fill('2');
    await page.locator('[data-gxw-count="resource_group"] input').dispatchEvent('change');
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="work"]').waitFor();
    assert.equal(await page.locator('.gxw-card').count(),2,'two crews and no subcontractor');
    // The cards' pages take the large sheet; how many does not.
    assert.deepEqual(await page.evaluate(()=>wide),[false,true]);
    // Each card: its name on top with what it is at the top right.
    assert.deepEqual(await page.locator('.gxw-card').first().evaluate(card=>{const name=card.querySelector('[data-gxw-name]').getBoundingClientRect(),kind=card.querySelector('.gxw-kind').getBoundingClientRect();return [name.top<kind.bottom&&kind.top<name.bottom,kind.left>name.left,card.querySelector('header').firstElementChild.contains(card.querySelector('[data-gxw-name]'))];}),[true,true,true]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('more than three cards: three and a half in view, the next and previous peeking in',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await open(browser,'crews',{options});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-count="resource_group"] input').fill('6');
    await page.locator('[data-gxw-count="resource_group"] input').dispatchEvent('change');
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="work"]').waitFor();
    const fit=await page.evaluate(()=>{const track=document.querySelector('.gxw-track'),card=track.children[0].getBoundingClientRect();return {more:track.hasAttribute('data-more'),ratio:(track.clientWidth-4)/card.width};});
    assert.equal(fit.more,true);
    assert.ok(fit.ratio>3.6&&fit.ratio<3.8,`3.5 cards and their gaps fill the track (${fit.ratio})`);
    await page.locator('[data-gxw-nav="1"]').click();
    await page.waitForFunction(()=>{const track=document.querySelector('.gxw-track');return track.scrollLeft>20&&!track.matches(':hover')||track.scrollLeft>20;});
    await page.waitForTimeout(700);
    const view=await page.evaluate(()=>{const track=document.querySelector('.gxw-track'),box=track.getBoundingClientRect();return [...track.children].map(card=>{const r=card.getBoundingClientRect();return Math.max(0,Math.min(r.right,box.right)-Math.max(r.left,box.left))/r.width;}).map(part=>Math.round(part*100)/100);});
    assert.ok(view[0]>0.1&&view[0]<0.5,`the previous card peeks in (${view})`);
    assert.deepEqual(view.slice(1,4),[1,1,1],`three whole cards in the middle (${view})`);
    assert.ok(view[4]>0.1&&view[4]<0.5,`the next card peeks in (${view})`);
    assert.equal(await page.locator('.gxw-where').textContent(),'2–4 of 6');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a crew: Other, specialties, a picked and a new member, who is in charge; invited and shown what they see',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await open(browser,'crews',{options,status:{people,can:{add_people:true,invite:true},apps_off:['project.crew_payments']}});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-next]').click();
    const card=page.locator('.gxw-card').first();
    // Other: a search of every kind of work.
    await card.locator('[data-gxw-other]').click();
    await card.locator('[data-gxw-find]').fill('downsp');
    await card.locator('[data-gxw-service-add="gutters"]').click();
    assert.equal(await card.locator('[data-gxw-service="gutters"]').getAttribute('aria-pressed'),'true');
    // Specialties: the library's to pick from, and one typed in.
    // GP-161: a short row per service; its suggestions open under the row on "+ Specialties", one row at a time, and
    // what was picked stays on the row once it is closed.
    const roofs=card.locator('[data-gxw-kinds="roof_replacement"]');
    assert.equal(await roofs.locator('[data-gxw-tag]').count(),0,'nothing picked: no suggestions in the way');
    await roofs.locator('[data-gxw-kinds-open]').click();
    assert.deepEqual(await roofs.locator('.gxw-suggest [data-gxw-tag]').allTextContents(),['Asphalt shingles','Metal roofs','Flat roofs','Tile roofs','Cedar shakes','Slate']);
    await roofs.locator('[data-gxw-tag="Metal roofs"]').click();
    await roofs.locator('[data-gxw-tag-new]').fill('Steep slope');
    await roofs.locator('[data-gxw-tag-new]').press('Enter');
    assert.equal(await roofs.locator('[data-gxw-tag="Steep slope"]').getAttribute('aria-pressed'),'true');
    assert.deepEqual(await roofs.locator('.gxw-do-tags [data-gxw-tag]').allTextContents(),['Metal roofs','Steep slope'],'what was picked is on the row');
    assert.ok(!(await roofs.locator('.gxw-suggest [data-gxw-tag]').allTextContents()).includes('Metal roofs'),'and no longer offered');
    await card.locator('[data-gxw-kinds="gutters"] [data-gxw-kinds-open]').click();
    assert.equal(await card.locator('.gxw-suggest').count(),1,'one row open at a time');
    assert.equal(await card.locator('[data-gxw-kinds="gutters"] [data-gxw-tag="Seamless"]').count(),1,'gutters has its own kinds');
    await card.locator('[data-gxw-kinds="gutters"] [data-gxw-kinds-open]').click();
    assert.deepEqual(await roofs.locator('[data-gxw-tag]').allTextContents(),['Metal roofs','Steep slope'],'closed, only what was picked shows');
    // Who's on it: our own dropdown, then someone new from its bottom.
    assert.equal(await card.locator('select').count(),0,'no browser dropdown');
    await card.locator('[data-gxw-pick]').click();
    await card.locator('[data-gxw-member="ana"]').click();
    await card.locator('[data-gxw-pick]').click();
    await card.locator('[data-gxw-newperson]').click();
    await card.locator('[data-gxw-newform] [name=name]').fill('Cara New');
    await card.locator('[data-gxw-newform] [name=email]').fill('ana@example.com');
    await card.locator('[data-gxw-newform] button[type=submit]').click();
    assert.equal(await card.locator('[data-gxw-newerror]').textContent(),'Ana Lopez is already on it.','an email someone already has is that person, never a second one');
    await card.locator('[data-gxw-newform] [name=email]').fill('not-an-email');
    await card.locator('[data-gxw-newform] button[type=submit]').click();
    assert.equal(await card.locator('[data-gxw-newerror]').textContent(),'Add an email they can sign in with.');
    await card.locator('[data-gxw-newform] [name=email]').fill('cara@example.com');
    await card.locator('[data-gxw-newform] button[type=submit]').click();
    assert.equal(await card.locator('[data-gxw-person] em').textContent(),'New');
    // Two on it: a flag says who is in charge.
    const cara=card.locator('[data-gxw-person]').nth(1);
    await cara.locator('[data-gxw-lead]').click();
    assert.equal(await card.locator('[data-gxw-person][data-lead=true]').count(),1);
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="pay"]').waitFor();
    assert.equal(await page.locator('[data-gxw-apply]').count(),0,'the invite comes next, so pay is not the last page');
    await page.locator('[data-gxw-next]').click();
    // Only someone who has not joined yet is invited.
    await page.locator('[data-gxw-page="invite"]').waitFor();
    assert.deepEqual(await page.locator('[data-gxw-invitee] strong').allTextContents(),['Cara New']);
    await page.locator('[data-gxw-yes]').click();
    await page.locator('[data-gxw-page="see"]').waitFor();
    assert.equal(await page.locator('[data-gxw-see="payments"]').count(),0,'an app the organization has off is not asked about');
    assert.equal(await page.locator('[data-gxw-see="earnings"]').getAttribute('aria-checked'),'true');
    await page.locator('[data-gxw-see="earnings"]').click();
    await page.locator('[data-gxw-apply]').click();
    await page.locator('[data-gxw-page="done"]').waitFor();
    const saved=await page.evaluate(()=>saved);
    assert.deepEqual(saved.map(row=>row.action),['workforce.users.add','operations.workforce.setup.apply','workforce.users.invite']);
    assert.deepEqual(saved[0].input,{name:'Cara New',email:'cara@example.com'});
    const crew=saved[1].input.labor.assignees[0];
    assert.deepEqual(crew.service_ids,['roof_replacement','gutters']);
    assert.deepEqual(crew.service_tags,{roof_replacement:['Metal roofs','Steep slope']});
    assert.deepEqual(crew.member_user_ids,['ana','u_cara']);
    assert.equal(crew.lead_user_id,'u_cara');
    assert.deepEqual(crew.apps['portal.crew_payouts'],{visible:false});
    assert.deepEqual(crew.apps['portal.crew_schedule'],{visible:true});
    assert.equal(crew.apps['project.crew_payments'],undefined);
    assert.deepEqual(saved[2].input,{user_ids:['u_cara']});
    assert.match(await page.locator('.gxw-done').textContent(),/We emailed 1 invite to the app\./);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('the invite is skippable: Not now saves the setup and invites nobody',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await open(browser,'crews',{options,status:{people,can:{add_people:true,invite:true}}});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-next]').click();
    const card=page.locator('.gxw-card').first();
    await card.locator('[data-gxw-pick]').click();
    await card.locator('[data-gxw-member="ben"]').click();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="invite"]').waitFor();
    assert.equal(await page.evaluate(()=>handle.backDepth()),4,'the phone\'s back walks pay, the cards, how many and the question');
    await page.locator('[data-gxw-skip]').click();
    await page.locator('[data-gxw-page="done"]').waitFor();
    const saved=await page.evaluate(()=>saved);
    assert.deepEqual(saved.map(row=>row.action),['operations.workforce.setup.apply']);
    assert.equal(saved[0].input.labor.assignees[0].apps,undefined,'nothing about the app without the invite');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('nobody to invite, or no right to: pay is the last page and adding someone new is not offered',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await open(browser,'crews',{options,status:{people,can:{add_people:false,invite:false}}});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-next]').click();
    const card=page.locator('.gxw-card').first();
    await card.locator('[data-gxw-pick]').click();
    assert.equal(await card.locator('[data-gxw-newperson]').count(),0);
    await card.locator('[data-gxw-member="ben"]').click();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="pay"] [data-gxw-apply]').waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// GP-143: from Scheduling's New appointment, before Operations is on. The setup starts at how many, there is no pay page
// (pay sheets are Operations'), the naming page saves, and no pay is sent.
test('without Operations: how many, then naming saves, with no pay page and no pay sent',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const {page,errors}=await open(browser,'crews',{width:390,status:{can:{add_people:false,invite:false,pay:false}}});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="work"]').waitFor();
    assert.equal(await page.locator('[data-gxw-page="work"] [data-gxw-next]').textContent(),'Save');
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="done"]').waitFor();
    const apply=await page.evaluate(()=>saved.find(entry=>entry.action==='operations.workforce.setup.apply')?.input);
    assert.equal(apply.labor.assignees.length,1);
    assert.equal(apply.labor.assignees[0].pay,undefined);
    assert.match(await page.locator('[data-gxw-page="done"] .gxw-done').textContent(),/change any of it in People/);
    assert.doesNotMatch(await page.locator('[data-gxw-page="done"] .gxw-rows').textContent(),/Pay not set/);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// GP-143: on a phone the tray is at least two-thirds of the screen; a short page (how many) starts at the top with its
// buttons along the bottom, never floating in the middle.
test('on a phone a short page fills the tray: words at the top, buttons at the bottom',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    // The player's phone sheet: a step that centres what is shorter than it (guided-setup.js).
    const html='<style>body{margin:0}.gxs-step{position:absolute;left:0;right:0;bottom:0;height:560px;overflow:auto;padding:6px 16px 20px;display:flex;flex-direction:column;justify-content:safe center;box-sizing:border-box}.gxs-body{flex:0 0 auto}</style><div class="gxs" data-kind="modal"><div class="gxs-step"><div class="gxs-body" id="step"></div></div></div>';
    const {page,errors}=await open(browser,'crews',{width:390,html});
    await page.locator('[data-gxw-page="count"]').waitFor();
    const box=await page.evaluate(()=>{const step=document.querySelector('.gxs-step').getBoundingClientRect(),lead=document.querySelector('[data-gxw-page="count"]').getBoundingClientRect(),actions=document.querySelector('.gxw-actions').getBoundingClientRect();return {top:lead.top-step.top,gap:step.bottom-actions.bottom};});
    assert.ok(box.top<20,`the page starts at the top (${box.top}px down)`);
    assert.ok(box.gap<=32,`the buttons sit at the bottom (${box.gap}px above it)`);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// GP-161: Back, Continue and Save are on a bar pinned to the bottom of the sheet on every page: a long page scrolls
// under it, a short one (pay on the large sheet) has it at the bottom, not under the cards.
test('Back and Continue stay pinned to the bottom of the sheet, whatever the page\'s height',async()=>{
  const browser=await launch();
  try{
    const html='<style>body{margin:0}.gxs-step{position:absolute;left:0;top:0;width:1100px;height:520px;overflow:auto;padding:8px 28px 24px;display:flex;flex-direction:column;box-sizing:border-box}.gxs-body{flex:0 0 auto}</style><div class="gxs" data-kind="modal"><div class="gxs-step"><div class="gxs-titlebar"><h2>Step</h2></div><div class="gxs-body" id="step"></div></div></div>';
    const {page,errors}=await open(browser,'crews',{options,html,status:{people,can:{add_people:true,invite:true}}});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-count="resource_group"] [data-gxw-plus]').click();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="work"]').waitFor();
    // Make the page longer than the sheet: a row's suggestions open and two people on the crew.
    const card=page.locator('.gxw-card').first();
    await card.locator('[data-gxw-kinds="roof_replacement"] [data-gxw-kinds-open]').click();
    await card.locator('[data-gxw-pick]').click();
    await card.locator('[data-gxw-member="ana"]').click();
    await card.locator('[data-gxw-pick]').click();
    const where=()=>page.evaluate(()=>{const step=document.querySelector('.gxs-step'),box=step.getBoundingClientRect(),bar=document.querySelector('[data-gxw-page] > .gxw-actions').getBoundingClientRect(),back=document.querySelector('[data-gxw-back]').getBoundingClientRect();return {long:step.scrollHeight>step.clientHeight+20,gap:Math.round(box.bottom-bar.bottom),backGap:Math.round(box.bottom-back.bottom),top:document.elementFromPoint(back.left+back.width/2,back.top+back.height/2)?.closest('[data-gxw-back]')!==null};});
    const long=await where();
    assert.equal(long.long,true,'the page is longer than the sheet');
    assert.equal(long.gap,0,'the bar sits on the bottom edge');
    assert.ok(long.backGap>=16&&long.backGap<=32,`Back is in reach, not under the content (${long.backGap}px up)`);
    assert.equal(long.top,true,'nothing covers Back');
    await page.evaluate(()=>document.querySelector('.gxs-step').scrollTo({top:120}));
    assert.deepEqual(await where(),long,'scrolling moves the cards, not the buttons');
    await page.evaluate(()=>handle.escape());
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="pay"]').waitFor();
    const short=await where();
    assert.equal(short.long,false);
    assert.equal(short.gap,0,'a short page has its buttons at the bottom of the sheet too');
    assert.equal(short.top,true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// GP-162: a piece rate is items. Squares start as one rate for each pitch range (library data); the ranges replace each
// other and are all given a rate or none; a bonus over a pitch and a rate per foot of a roof line are added on top, and
// the bonus says what a square at that pitch earns.
const pitchBands=[[0,2],[2,4],[4,6],[6,8],[8,12],[12,null]].map(([above,up_to])=>({id:`band_${above}`,label:'',above,up_to}));
const roofMeasurements=[{id:'roof.squares',label:'Roof squares',unit:'roofing_square'},{id:'roof.area',label:'Roof area',unit:'ft2'},{id:'roof.squares_hand_carried',label:'Hand-carried squares',unit:'roofing_square',part_of:'roof.squares'},{id:'roof.ridge_length',label:'Ridges',unit:'ft'},{id:'roof.valley_length',label:'Valleys',unit:'ft'}];
test('a piece rate: one rate for each pitch range by default, split where you like, with a bonus and extras on top',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await open(browser,'crews',{options,status:{people,can:{add_people:false,invite:false},measurements:roofMeasurements,pitch_bands:pitchBands}});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="work"] [data-gxw-next]').click();
    const card=page.locator('[data-gxw-page="pay"] .gxw-card').first();
    await card.waitFor();
    await card.locator('[data-gxw-method="per_measurement"]').click();
    assert.equal(await card.locator('[data-gxw-squares="pitch"]').getAttribute('aria-checked'),'true','by pitch range is the default');
    const names=async()=>(await card.locator('[data-gxw-range] .gxw-pr-name').allInnerTexts()).map(text=>text.split('\n')[0]);
    assert.deepEqual(await names(),['Up to 2/12','Over 2/12 up to 8/12','Over 8/12 up to 12/12','Over 12/12']);
    assert.match(await card.locator('[data-gxw-squares-part] .gxw-pp-hint').innerText(),/replace each other/);
    // Some ranges rated and not the others: the squares in those would be paid nothing, so it says so.
    await card.locator('[data-gxw-range] input').nth(1).fill('65');
    await page.locator('[data-gxw-apply]').click();
    assert.match(await page.locator('[data-gxw-error]').innerText(),/every pitch range/);
    assert.equal(await card.locator('[data-gxw-range][data-missing]').count(),3);
    // Split at 6/12 too: both halves start at the rate of the range they were; joined again, they are that range.
    const rates=()=>card.locator('[data-gxw-range] input').evaluateAll(inputs=>inputs.map(input=>input.value));
    await card.locator('[data-gxw-break="6"]').click();
    assert.deepEqual(await names(),['Up to 2/12','Over 2/12 up to 6/12','Over 6/12 up to 8/12','Over 8/12 up to 12/12','Over 12/12']);
    assert.deepEqual(await rates(),['','65','65','','']);
    await card.locator('[data-gxw-break="6"]').click();
    assert.deepEqual(await rates(),['','65','','']);
    for (const [at,rate] of [[0,'90'],[2,'80'],[3,'100']]) await card.locator('[data-gxw-range] input').nth(at).fill(rate);
    // On top: a bonus over 8/12, said as what a 9/12 square earns, and ridges per foot. Roof squares are not offered again.
    const add=card.locator('[data-gxw-add]');
    assert.equal(await add.locator('option[value="roof.squares"]').count(),0);
    assert.equal(await add.locator('option[value="roof.area"]').count(),0);
    await add.selectOption('bonus');
    const bonus=card.locator('[data-gxw-extra]').first();
    await bonus.locator('input').fill('2');
    assert.equal(await bonus.locator('[data-gxw-example]').innerText(),'A 9/12 square: $80 + $2 = $82');
    await card.locator('[data-gxw-add]').selectOption('roof.ridge_length');
    await card.locator('[data-gxw-extra]').nth(1).locator('input').fill('1.5');
    assert.equal(await card.locator('[data-gxw-add] option[value="roof.ridge_length"]').count(),0,'an extra is paid once');
    await page.locator('[data-gxw-apply]').click();
    await page.waitForFunction(()=>saved.some(entry=>entry.action==='operations.workforce.setup.apply'));
    const apply=await page.evaluate(()=>saved.find(entry=>entry.action==='operations.workforce.setup.apply').input);
    assert.deepEqual(apply.labor.assignees[0].pay,{method:'per_measurement',items:[
      {type:'pitch_range',above:0,up_to:2,rate:90},{type:'pitch_range',above:2,up_to:8,rate:65},{type:'pitch_range',above:8,up_to:12,rate:80},{type:'pitch_range',above:12,up_to:null,rate:100},
      {type:'pitch_bonus',above:8,up_to:null,rate:2},{type:'measurement',measurement:'roof.ridge_length',rate:1.5}]});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('one rate for every square carries over, and a saved piece rate comes back item by item',async()=>{
  const browser=await launch();
  try{
    const saved={method:'per_measurement',rate:0,items:[{type:'measurement',measurement:'roof.squares',rate:70},{type:'pitch_bonus',above:12,up_to:null,rate:5}]};
    const {page,errors}=await open(browser,'crews',{options,status:{people,can:{add_people:false,invite:false},measurements:roofMeasurements,pitch_bands:pitchBands,assignees:[{ref:{type:'resource_group',id:'g1'},kind:'resource_group',name:'North crew',type_ids:['crew'],member_user_ids:[],service_ids:['roof_replacement'],pay:{sheet_id:'s1',name:'North',lines:2,simple:null,items:saved.items}}]}});
    await page.locator('[data-gxw-page="count"]').waitFor();
    await page.locator('[data-gxw-next]').click();
    await page.locator('[data-gxw-page="work"] [data-gxw-next]').click();
    const card=page.locator('[data-gxw-page="pay"] .gxw-card').first();
    assert.equal(await card.locator('[data-gxw-squares="one"]').getAttribute('aria-checked'),'true');
    assert.equal(await card.locator('[data-gxw-range] input').inputValue(),'70');
    assert.equal(await card.locator('[data-gxw-example]').innerText(),'A 13/12 square: $70 + $5 = $75');
    // To ranges and back: one rate fills every range, and the same rate on every range is one rate again.
    await card.locator('[data-gxw-squares="pitch"]').click();
    assert.deepEqual(await card.locator('[data-gxw-range] input').evaluateAll(inputs=>inputs.map(input=>input.value)),['70','70','70','70']);
    await card.locator('[data-gxw-squares="one"]').click();
    assert.equal(await card.locator('[data-gxw-range] input').inputValue(),'70');
    assert.equal(await card.locator('[data-gxw-extra]').count(),1,'the bonus stays');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
