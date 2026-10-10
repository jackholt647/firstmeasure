import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries=new URL('../../libraries/',import.meta.url);

test('channel avatar shows the shared user summary on hover and keeps its action usable',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:750}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://channels.test/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname.startsWith('/libraries/')){
    const body=process.env.DEV_ASSETS ? Buffer.from(await (await fetch('https://dev.1m8.ai'+pathname+'?hover='+Date.now())).arrayBuffer()) : await readFile(new URL(pathname.slice('/libraries/'.length),libraries));
    return route.fulfill({contentType:pathname.endsWith('.json')?'application/json':'application/javascript',body});
   }
   return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;font-family:Arial"><div id="app" style="height:100vh"></div></body></html>'});
  });
  await page.goto('http://channels.test/');
  await page.evaluate(()=>{
   const viewer={id:'viewer',name:'Morgan'},member={id:'member',name:'Avery Smith'};
   const channel={id:'general',name:'general',type:'public',display_name:'General',members:[viewer,member],settings:{},permissions:{},unread:{},is_member:true,message_seq:1};
   const message={id:'message-1',channel_id:'general',seq:1,text:'Hello @Dana and @channel',author:member,mention_users:[{id:'dana',name:'Dana'}],created_at:new Date().toISOString(),reactions:[]};
   window.__APP={userId:viewer.id,userOrgId:'org'};
   window.Portal={currentUser:viewer,ui:{showToast(){}},appFlags:{current:()=>true,has:()=>true},util:{injectCSS(id,css){if(document.getElementById(id))return;const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}}};
   window.PlatformAPI={publication:{resolveWidget:async(_org,input)=>{window.resolvedWidget=input;return {status:'ready',widget:{id:'user.summary',version:'1',type:'summary.user',target:input.target}};},read:async(_org,{target})=>({status:'ready',value:target.id==='dana'?{id:'dana',name:'Dana Ortiz',title:'Engineer'}:{id:'member',name:'Avery Smith',email:'avery@example.test',title:'Designer',department:'Product'}})}};
   window.PlatformRealtime={watchPresence:()=>()=>{}};
   window.dmActions=[];
   window.FirstMateChannelsNavigation={openMessage:async input=>dmActions.push(input)};
   window.ChannelsAPI={channels:{list:async()=>({channels:[channel]}),get:async()=>({channel}),create:async(_org,input)=>{dmActions.push(input);return {channel:{id:'dm-1'}};}},messages:{list:async()=>({channel,messages:[message]})},preferences:{collaboration:async()=>({preferences:{send_mode:'enter'}})},readState:{markRead:async()=>({})},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},scheduled:{list:async()=>({scheduled_messages:[]})}};
   window.options={orgId:'org',currentUser:viewer,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,channelCreate:false,channelSettings:false,recording:false}};
  });
  await page.addScriptTag({url:'/libraries/platform-widgets/runtime.js'});
  await page.evaluate(()=>FirstMateWidgets.ready);
  await page.addScriptTag({url:'/libraries/channels-ui/channels-ui.js'});
  await page.evaluate(async()=>{window.instance=FirstMateChannels.create(document.querySelector('#app'),options);await instance.setChannel('general');});
  const avatar=page.locator('.fm-ch-msg[data-message-id="message-1"] .fm-ch-msg-gutter .fm-ch-summary-trigger');
  await avatar.hover();
  const summary=page.locator('.fm-user-summary');
  await summary.waitFor();
  assert.equal(await summary.locator('.fm-user-summary-name').innerText(),'Avery Smith');
  assert.deepEqual(await page.evaluate(()=>resolvedWidget.target),{scope:'organization',organizationId:'org',id:'member'});
  assert.equal(await page.locator('.fm-ch-profile-card,.fm-ch-profile-panel').count(),0);
  await avatar.click();
  assert.equal(await page.locator('.fm-ch-profile-card,.fm-ch-profile-panel').count(),0,'click does not reopen the old profile UI');
  await summary.getByRole('button',{name:'Message in Channels'}).click();
  assert.deepEqual(await page.evaluate(()=>dmActions),[{type:'dm',member_user_ids:['member']},{channel_id:'dm-1'}]);
  await page.mouse.move(700,500);
  const mention=page.locator('.fm-ch-msg[data-message-id="message-1"] .fm-ch-mention').filter({hasText:'@Dana'});
  await mention.hover();
  await page.waitForFunction(()=>document.querySelector('.fm-user-summary-name')?.textContent==='Dana Ortiz');
  assert.deepEqual(await page.evaluate(()=>resolvedWidget.target),{scope:'organization',organizationId:'org',id:'dana'});
  assert.equal(await page.locator('.fm-ch-mention[data-fm-summary-type]').count(),1,'broadcast mention has no user preview');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.fm-user-summary').count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
