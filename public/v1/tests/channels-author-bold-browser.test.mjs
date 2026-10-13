import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries = new URL('../../libraries/', import.meta.url);

test('profile names stay bold in DMs, group DMs, large channels and thread replies', async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:750}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://channels.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/libraries/')) {
        const body = process.env.DEV_ASSETS
          ? Buffer.from(await (await fetch('https://dev.1m8.ai' + pathname + '?bold=' + Date.now())).arrayBuffer())
          : await readFile(new URL(pathname.slice('/libraries/'.length), libraries));
        return route.fulfill({contentType:'application/javascript',body});
      }
      return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0;font-family:Arial"><div id="app" style="height:100vh"></div></body></html>'});
    });
    await page.goto('http://channels.test/');
    await page.evaluate(() => {
      const viewer = {id:'viewer',name:'Morgan'}, author = {id:'author',name:'Avery Smith'};
      const members = [viewer,author,...Array.from({length:58},(_,i)=>({id:'member-'+i,name:'Member '+i}))];
      const channels = [['dm',2],['group_dm',5],['public',60]].map(([type,count])=>({id:type,type,name:type,display_name:type,members:members.slice(0,count),settings:{},permissions:{},unread:{},is_member:true,message_seq:1}));
      const message = channel => ({id:channel.id+'-root',channel_id:channel.id,seq:1,text:'Hello everyone',author,created_at:new Date().toISOString(),reactions:[],reply_count:1});
      window.__APP = {userId:viewer.id,userOrgId:'org'};
      window.Portal = {currentUser:viewer,ui:{showToast(){}},appFlags:{current:()=>true,has:()=>true}};
      window.ChannelsAPI = {
        channels:{list:async()=>({channels}),get:async(_org,id)=>({channel:channels.find(c=>c.id===id)})},
        messages:{list:async(_org,id)=>{const channel=channels.find(c=>c.id===id);return {channel,messages:[message(channel)]};},thread:async(_org,id)=>{const channel=channels.find(c=>id===c.id+'-root'),root=message(channel);return {root,replies:[{...root,id:channel.id+'-reply',parent_id:root.id,seq:2,text:'Thread reply'}]};}},
        threads:{markRead:async()=>({})},preferences:{collaboration:async()=>({preferences:{send_mode:'enter'}})},readState:{markRead:async()=>({})},
        drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},scheduled:{list:async()=>({scheduled_messages:[]})}
      };
      window.options = {orgId:'org',currentUser:viewer,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,channelCreate:false,channelSettings:false,recording:false}};
    });
    await page.addScriptTag({url:'/libraries/channels-ui/channels-ui.js'});
    await page.evaluate(()=>{window.instance=FirstMateChannels.create(document.querySelector('#app'),options);});
    for (const type of ['dm','group_dm','public']) {
      await page.evaluate(type=>instance.setChannel(type),type);
      const root = page.locator(`.fm-ch-msg[data-message-id="${type}-root"]`).first();
      assert.equal(await root.locator('.fm-ch-msg-author').innerText(),'Avery Smith');
      assert.equal(await root.locator('.fm-ch-msg-author').evaluate(el=>getComputedStyle(el).fontWeight),'850',type+' author is bold');
      assert.equal(await root.locator('.fm-ch-msg-body').evaluate(el=>getComputedStyle(el).fontWeight),'400',type+' message stays regular');
      await root.locator('.fm-ch-thread-link').click();
      const reply = page.locator(`.fm-ch-msg[data-message-id="${type}-reply"] .fm-ch-msg-author`);
      await reply.waitFor();
      assert.equal(await reply.evaluate(el=>getComputedStyle(el).fontWeight),'850',type+' reply author is bold');
    }
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
  }
});
