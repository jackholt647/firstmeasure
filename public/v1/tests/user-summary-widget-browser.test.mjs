import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries=new URL('../../libraries/',import.meta.url);

test('user preview shows profile, live presence, and opens a Channels direct message',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:900,height:700}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://widgets.test/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:pathname.endsWith('.json')?'application/json':'application/javascript',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
   return route.fulfill({contentType:'text/html',body:'<div id="host"></div>'});
  });
  await page.goto('http://widgets.test/');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'viewer'};
   window.messages=[];
   window.PlatformRealtime={watchPresence(_org,_scope,listener){window.presenceListener=listener;listener([]);return ()=>{window.presenceStopped=true;};}};
   window.ChannelsAPI={channels:{create:async(org,input)=>{messages.push({org,input});return {channel:{id:'dm-1'}};}}};
   window.FirstMateChannelsNavigation={openMessage:async detail=>messages.push(detail)};
  });
  await page.addScriptTag({url:'/libraries/platform-widgets/runtime.js'});
  await page.evaluate(async()=>{
   await FirstMateWidgets.ready;
   window.widget=FirstMateWidgets.mount(document.querySelector('#host'),{id:'user.summary',version:'1',target:{scope:'organization',organizationId:'org',id:'member'}},{surface:'hover',read:async()=>({status:'ready',value:{id:'member',name:'Avery Smith',profile_photo:'/photos/avery',email:'avery@example.test',phone:'555-0102',department:'Product',title:'Designer',location:'Seattle',time_zone:'America/Los_Angeles',pronouns:'they/them',bio:'Designs products'}})});
   await widget.ready;
  });
  const card=page.locator('.fm-user-summary');
  assert.equal(await card.locator('img').getAttribute('alt'),'Avery Smith profile photo');
  assert.equal(await card.locator('.fm-user-summary-name').innerText(),'Avery Smith');
  for(const value of ['avery@example.test','555-0102','Product','Designer','Seattle','America/Los_Angeles','they/them','Designs products'])assert.ok((await card.innerText()).includes(value),value);
  assert.equal(await card.locator('.fm-user-summary-dot').getAttribute('title'),'Away');
  await page.evaluate(()=>presenceListener([{user_id:'member',status:'active',last_active_at:Date.now()}]));
  assert.equal(await card.locator('.fm-user-summary-dot').getAttribute('title'),'Active');
  await page.evaluate(()=>presenceListener([{user_id:'member',status:'away',last_active_at:Date.now()-4*60*60*1000}]));
  assert.equal(await card.locator('.fm-user-summary-dot').getAttribute('title'),'Away for 4 hours');
  await card.getByRole('button',{name:'Message in Channels'}).click();
  assert.deepEqual(await page.evaluate(()=>messages),[{org:'org',input:{type:'dm',member_user_ids:['member']}},{channel_id:'dm-1'}]);
  await page.evaluate(()=>widget.destroy());
  assert.equal(await page.evaluate(()=>presenceStopped),true);
  await page.evaluate(()=>{
   const avatar=document.createElement('span');avatar.id='avatar';avatar.textContent='Avery';avatar.style.cssText='display:block;width:60px;height:60px;margin:30px';avatar.dataset.fmSummaryType='summary.user';avatar.dataset.fmSummaryTarget=JSON.stringify({scope:'organization',organizationId:'org',id:'member'});document.body.append(avatar);
   window.PlatformAPI={publication:{resolveWidget:async()=>({status:'ready',widget:{id:'user.summary',version:'1'}}),read:async()=>({status:'ready',value:{id:'member',name:'Avery Smith',phone:'555-0102'}})}};
  });
  await page.locator('#avatar').hover();
  await page.locator('[role="tooltip"] .fm-user-summary-action').waitFor();
  await page.locator('[role="tooltip"] .fm-user-summary-action').hover();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[role="tooltip"] .fm-user-summary-action').count(),1,'interactive hover stays open across the gap');
  await page.locator('[role="tooltip"] .fm-user-summary-action').click();
  assert.equal((await page.evaluate(()=>messages)).length,4);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
