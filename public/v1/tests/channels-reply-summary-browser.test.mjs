import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries=new URL('../../libraries/',import.meta.url);

test('channel reply summary shows participant photos and the latest reply time',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:750}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://channels.test/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/avatar.svg')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#87a5b8"/></svg>'});
   if(pathname.startsWith('/libraries/')){
    const body=await readFile(new URL(pathname.slice('/libraries/'.length),libraries));
    return route.fulfill({contentType:pathname.endsWith('.json')?'application/json':'application/javascript',body});
   }
   return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;font-family:Arial"><div id="app" style="height:100vh"></div></body></html>'});
  });
  await page.goto('http://channels.test/');
  await page.evaluate(()=>{
   const viewer={id:'viewer',name:'Morgan'},member={id:'member',name:'Avery Smith'};
   const channel={id:'general',name:'general',type:'public',display_name:'General',members:[viewer,member],settings:{},permissions:{},unread:{},is_member:true,message_seq:1};
   const message={id:'message-1',channel_id:'general',seq:1,text:'Hello @Dana and @channel',author:member,mention_users:[{id:'dana',name:'Dana'}],created_at:new Date().toISOString(),reactions:[],reply_count:7,last_reply_at:new Date().toISOString(),reply_participants:['Avery','Dana','Morgan','Taylor'].map((name,index)=>({id:String(index),name,avatar:index?'/avatar.svg':''}))};
   window.__APP={userId:viewer.id,userOrgId:'org'};
   window.Portal={currentUser:viewer,ui:{showToast(){}},appFlags:{current:()=>true,has:()=>true},util:{injectCSS(id,css){if(document.getElementById(id))return;const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}}};
   window.PlatformAPI={publication:{resolveWidget:async(_org,input)=>{window.resolvedWidget=input;return {status:'ready',widget:{id:'user.summary',version:'1',type:'summary.user',target:input.target}};},read:async(_org,{target})=>({status:'ready',value:target.id==='dana'?{id:'dana',name:'Dana Ortiz',title:'Engineer'}:{id:'member',name:'Avery Smith',email:'avery@example.test',title:'Designer',department:'Product'}})}};
   window.PlatformRealtime={watchPresence:()=>()=>{}};
   window.dmActions=[];
   window.FirstMateChannelsNavigation={openMessage:async input=>dmActions.push(input)};
   window.ChannelsAPI={channels:{list:async()=>({channels:[channel]}),get:async()=>({channel}),create:async(_org,input)=>{dmActions.push(input);return {channel:{id:'dm-1'}};}},messages:{list:async()=>({channel,messages:[message]}),thread:async()=>({root:{...message,reply_count:8},replies:[]})},threads:{markRead:async()=>({})},preferences:{collaboration:async()=>({preferences:{send_mode:'enter'}})},readState:{markRead:async()=>({})},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},scheduled:{list:async()=>({scheduled_messages:[]})}};
   window.options={orgId:'org',currentUser:viewer,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,channelCreate:false,channelSettings:false,recording:false}};
  });
  await page.addScriptTag({url:'/libraries/platform-widgets/runtime.js'});
  await page.evaluate(()=>FirstMateWidgets.ready);
  await page.addScriptTag({url:'/libraries/channels-ui/channels-ui.js'});
  await page.evaluate(async()=>{window.instance=FirstMateChannels.create(document.querySelector('#app'),options);await instance.setChannel('general');});
  const summary=page.locator('.fm-ch-msg[data-message-id="message-1"] .fm-ch-thread-link');
  assert.equal(await summary.locator('.fm-ch-reply-people .fm-ch-avatar').count(),4);
  assert.equal(await summary.locator('.fm-ch-reply-people img').count(),3);
  assert.equal(await summary.locator('.fa-comment-dots').count(),0);
  assert.match(await summary.innerText(),/7 replies.*Last reply Today at/s);
  await summary.click();
  await page.waitForFunction(()=>document.querySelector('.fm-ch-msg .fm-ch-thread-link')?.textContent.includes('8 replies'));
  await page.setViewportSize({width:375,height:750});
  assert.ok(await summary.evaluate(element=>element.getBoundingClientRect().right <= innerWidth),'summary fits on mobile');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
