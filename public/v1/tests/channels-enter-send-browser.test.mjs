import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Enter sends channels, DMs and replies while Shift+Enter inserts a line',async()=>{
  const publicRoot=fileURLToPath(new URL('../../',import.meta.url));
  const output=path.resolve(publicRoot,'../output/channels-linear-20260929/pla28');
  await mkdir(output,{recursive:true});
  const server=createServer(async(req,res)=>{
    const assets={'/ui.js':'/libraries/channels-ui/channels-ui.js','/tags.js':'/libraries/platform-tags/platform-tags.js'};
    if(assets[req.url]){
      res.setHeader('Content-Type','text/javascript; charset=utf-8');
      const data=process.env.DEV_ASSETS?await (async()=>{
        const response=await fetch('https://dev.1m8.ai'+assets[req.url]+'?mentions='+Date.now());
        assert.ok(response.ok);return Buffer.from(await response.arrayBuffer());
      })():await readFile(path.join(publicRoot,assets[req.url]));
      res.end(data);return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><html><body style="margin:0;font-family:Arial;--primary:#174ce4;--primary-readable:#174ce4"><div id="app" style="height:100vh"></div></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1380,height:850}});page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(origin);
    await page.evaluate(()=>{
      const me={id:'owner',name:'Morgan'},member={id:'member',name:'J. Lee'},second={id:'second',name:'Sam & Sons'};
      const outsider={id:'outsider',name:'Not A Member'};
      const channel={id:'general',name:'general',type:'public',display_name:'General',members:[me,member,second],settings:{},permissions:{},unread:{},is_member:true,message_seq:1};
      const root={id:'root',channel_id:channel.id,seq:1,text:'Root @J. Lee remains ordinary text',author:me,created_at:new Date().toISOString(),mention_users:[member],can_edit:true,reply_count:0,reactions:[]};
      const special={...root,id:'special',seq:2,text:'@Sam & Sons remains ordinary; @Sam & SonsPlus is not this mention',mention_users:[second]};
      window.messages=[root,special];window.sent=[];window.edited=[];
      const copy=value=>structuredClone(value);
      window.__APP={userId:me.id,userOrgId:'mention-fixture',userName:me.name};
      window.Portal={currentUser:me,ui:{showToast(){}},appFlags:{current:()=>true,has:()=>true}};
      Portal.util={injectCSS:(id,css)=>{if(document.getElementById(id))return;const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}};
      window.ChannelsAPI={
        channels:{list:async()=>({channels:[channel]}),get:async()=>({channel})},
        directory:{list:async()=>({users:[me,member,second,outsider]})},
        preferences:{collaboration:async()=>({preferences:{send_mode:'modified_enter'}})},
        readState:{markRead:async()=>({})},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},
        scheduled:{list:async()=>({scheduled_messages:[]})},threads:{markRead:async()=>({})},
        messages:{
          list:async()=>({channel,messages:copy(messages.filter(message=>!message.parent_id))}),
          thread:async(_org,id)=>({root:copy(messages.find(message=>message.id===id)),replies:copy(messages.filter(message=>message.parent_id===id))}),
          post:async(_org,_id,input)=>{
            sent.push(copy(input));
            const mentions=(input.mention_users||[]).flatMap(user=>user.id.startsWith('broadcast:')?channel.members:[user]);
            const message={...root,...copy(input),id:'sent-'+sent.length,seq:messages.length+1,mention_users:mentions};
            messages.push(message);if(message.parent_id)root.reply_count++;
            return {message:copy(message)};
          },
          edit:async(_org,id,input)=>{
            edited.push(copy(input));const message=messages.find(item=>item.id===id);Object.assign(message,copy(input));return {message:copy(message)};
          }
        }
      };
      window.fixtureOptions={orgId:'mention-fixture',currentUser:me,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,channelCreate:false,channelSettings:false,recording:false}};
    });
    await page.addScriptTag({url:origin+'/tags.js'});await page.addScriptTag({url:origin+'/ui.js'});
    await page.evaluate(async()=>{window.instance=FirstMateChannels.create(document.querySelector('#app'),fixtureOptions);await instance.setChannel('general');});

    const editor=page.locator('.fm-ch-composer .fm-ch-rich-editor').first();
    assert.equal(await page.locator('.fm-ch-composer-hint').first().innerText(),'Shift+Enter for a new line');
    await editor.fill('First');await editor.press('Shift+Enter');await page.keyboard.type('Second');
    assert.equal(await page.evaluate(()=>sent.length),0);
    assert.match(await editor.evaluate(node=>node.value),/First\nSecond/);
    await editor.press('Enter');await page.waitForFunction(()=>sent.length===1);
    assert.match(await page.evaluate(()=>sent[0].text),/First\nSecond/);
    for(const html of ['<ul><li>List item</li></ul>','<blockquote>Quote</blockquote>']){
      await editor.evaluate((node,html)=>{node.innerHTML=html;node.focus();const r=document.createRange();r.selectNodeContents(node);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);node.dispatchEvent(new Event('input',{bubbles:true}));},html);
      const count=await page.evaluate(()=>sent.length);
      await editor.press('Enter');await page.waitForFunction(count=>sent.length===count+1,count);
    }
    await editor.fill('Composition draft');
    await editor.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));
    assert.equal(await page.evaluate(()=>sent.length),3);
    await editor.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true})));
    assert.equal(await page.evaluate(()=>sent.length),3);
    await editor.fill('@');await editor.press('ArrowLeft');await editor.press('ArrowRight');
    await page.locator('#fmMentionMenu.visible').waitFor();await editor.press('Enter');
    assert.equal(await page.evaluate(()=>sent.length),3,'mention selection does not send');
    await editor.press('Escape');
    await page.evaluate(()=>instance.openThread('root'));
    const reply=page.locator('.fm-ch-panel .fm-ch-composer .fm-ch-rich-editor');
    await reply.waitFor();await reply.fill('Reply first');await reply.press('Shift+Enter');await page.keyboard.type('Reply second');
    assert.equal(await page.evaluate(()=>sent.length),3);
    await reply.press('Enter');await page.waitForFunction(()=>sent.length===4);
    assert.equal(await page.evaluate(()=>sent[3].parent_id),'root');
    assert.match(await page.evaluate(()=>sent[3].text),/Reply first\nReply second/);
    await page.evaluate(async()=>{instance.destroy();document.querySelector('#app').replaceChildren();const old=ChannelsAPI.channels.get;ChannelsAPI.channels.get=async()=>{const result=await old();result.channel.type='dm';return result;};window.instance=FirstMateChannels.create(document.querySelector('#app'),fixtureOptions);await instance.setChannel('general');});
    const dm=page.locator('.fm-ch-composer .fm-ch-rich-editor').first();await dm.fill('DM message');await dm.press('Enter');await page.waitForFunction(()=>sent.length===5);
    assert.equal(await page.evaluate(()=>sent[4].text),'DM message');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});

