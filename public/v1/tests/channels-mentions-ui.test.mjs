import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

test('mounted Channels mention menus agree and red tokens survive channel, thread and edit flows',async()=>{
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
        preferences:{collaboration:async()=>({preferences:{send_mode:'enter'}})},
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
    const main=page.locator('.fm-ch-composer').first();
    const editor=main.locator('.fm-ch-rich-editor');
    const eligible=['broadcast:channel','broadcast:here','agent_assistant','owner','member','second'].sort();
    const parity=async input=>{
      await input.fill('@');await input.press('ArrowLeft');await input.press('ArrowRight');
      await page.locator('#fmMentionMenu.visible').waitFor();
      const typed=await page.locator('#fmMentionMenu [data-mention-user]').evaluateAll(nodes=>nodes.map(node=>node.dataset.mentionUser).sort());
      assert.deepEqual(typed,eligible);
      await input.press('Escape');
      await input.locator('..').locator('[data-mention-button]').click();
      const toolbar=await page.locator('.fm-ch-popover [data-mention-user]').evaluateAll(nodes=>nodes.map(node=>node.dataset.mentionUser).sort());
      assert.deepEqual(toolbar,typed);assert.ok(!toolbar.includes('outsider'));
      await page.keyboard.press('Escape');
    };
    const toolbarSelect=async(input,id)=>{
      await input.fill('');await input.focus();
      await input.locator('..').locator('[data-mention-button]').click();
      await page.locator(`.fm-ch-popover [data-mention-user="${id}"]`).click();
    };
    const redHighlight=async(input,token)=>{
      await page.waitForFunction(token=>[...(CSS.highlights.get('fm-channel-mentions')||[])].some(range=>range.toString()===token),token);
      assert.equal(await input.evaluate(node=>getComputedStyle(node,'::highlight(fm-channel-mentions)').color),'rgb(217, 48, 37)');
      const wire=await input.evaluate(node=>node.value);
      assert.ok(wire.startsWith(token));
      assert.ok((await page.evaluate(()=>[...CSS.highlights.get('fm-channel-mentions')].map(range=>range.toString()))).every(value=>!value.includes('ordinary')));
    };
    await parity(editor);
    await editor.fill('@J');await editor.press('ArrowLeft');await editor.press('ArrowRight');
    await page.locator('#fmMentionMenu.visible [data-mention-user="member"]').click();
    await editor.press('End');await page.keyboard.type('ordinary text');
    await redHighlight(editor,'@J. Lee');
    assert.equal(await editor.evaluate(node=>node.value),'@J. Lee ordinary text');
    await main.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>sent.length===1);
    assert.deepEqual(await page.evaluate(()=>sent[0].mention_users.map(user=>user.id)),['member']);
    const rendered=page.locator('[data-message-id="sent-1"] .fm-ch-mention');
    assert.equal(await rendered.innerText(),'@J. Lee');assert.equal(await rendered.evaluate(node=>getComputedStyle(node).color),'rgb(217, 48, 37)');
    await toolbarSelect(editor,'broadcast:channel');
    await main.getByRole('button',{name:'Send',exact:true}).click();await page.waitForFunction(()=>sent.length===2);
    assert.deepEqual(await page.evaluate(()=>sent[1].mention_users.map(user=>user.id)),['broadcast:channel']);
    await page.evaluate(()=>instance.setChannel('general'));
    assert.equal(await page.locator('[data-message-id="sent-2"] .fm-ch-mention').innerText(),'@channel');
    assert.equal(await editor.locator('..').locator('[data-mention-button]').evaluate(node=>getComputedStyle(node).color),'rgb(217, 48, 37)');
    const renderedSpecial=await page.locator('.fm-ch-list [data-message-id="special"]').evaluate(node=>{
      return {tokens:[...node.querySelectorAll('.fm-ch-mention')].map(item=>item.textContent),text:node.textContent};
    });
    assert.deepEqual(renderedSpecial.tokens,['@Sam & Sons']);
    assert.ok(renderedSpecial.text.includes('@Sam & SonsPlus'));
    await page.evaluate(()=>instance.openThread('root'));
    const thread=page.locator('.fm-ch-panel .fm-ch-composer');const threadEditor=thread.locator('.fm-ch-rich-editor');
    await parity(threadEditor);await toolbarSelect(threadEditor,'agent_assistant');
    await redHighlight(threadEditor,'@FirstMate Assistant');
    await thread.getByRole('button',{name:'Reply',exact:true}).click();await page.waitForFunction(()=>sent.length===3);
    assert.deepEqual(await page.evaluate(()=>sent[2].mention_users.map(user=>user.id)),['agent_assistant']);
    const row=page.locator('.fm-ch-panel [data-message-id="sent-3"]');await row.hover();await row.getByRole('button',{name:'More message actions'}).click();
    await page.getByRole('menuitem',{name:'Edit message',exact:true}).click();
    await redHighlight(threadEditor,'@FirstMate Assistant');
    await threadEditor.press('End');await page.keyboard.type(' updated');
    await thread.getByRole('button',{name:'Reply',exact:true}).click();await page.waitForFunction(()=>edited.length===1);
    assert.deepEqual(await page.evaluate(()=>edited[0].mention_users.map(user=>user.id)),['agent_assistant']);
    const channelRow=page.locator('.fm-ch-list [data-message-id="sent-1"]');await channelRow.hover();await channelRow.getByRole('button',{name:'More message actions'}).click();
    await page.getByRole('menuitem',{name:'Edit message',exact:true}).click();await redHighlight(editor,'@J. Lee');
    await editor.press('End');await page.keyboard.type(' updated');await main.getByRole('button',{name:'Save changes',exact:true}).click();await page.waitForFunction(()=>edited.length===2);
    assert.deepEqual(await page.evaluate(()=>edited[1].mention_users.map(user=>user.id)),['member']);
    const documentContract=await page.evaluate(async()=>{
      const documentEditor=document.createElement('div');documentEditor.contentEditable='true';documentEditor.className='fm-ch-rich-editor';
      Object.defineProperty(documentEditor,'value',{get(){return this.textContent;},set(value){this.textContent=value;}});
      document.body.append(documentEditor);
      const controller=FirstMateTags.attachMentionTextarea(documentEditor,{orgId:'mention-fixture',source:'documents',memberIds:()=>['member']});
      await controller.ready;
      const ids=controller.mentionCandidates().map(user=>user.id);
      controller.setSelectedMentions([{id:'outsider',name:'Not A Member'}]);
      documentEditor.value='@Not A Member';documentEditor.dispatchEvent(new Event('input',{bubbles:true}));
      const mentions=controller.confirmedMentions().map(user=>user.id);
      const highlighted=[...(CSS.highlights.get('fm-channel-mentions')||[])].some(range=>documentEditor.contains(range.startContainer));
      controller.destroy();documentEditor.remove();return {ids,mentions,highlighted};
    });
    assert.ok(documentContract.ids.includes('outsider'));assert.ok(documentContract.ids.includes('channel:general'));
    assert.ok(!documentContract.ids.includes('broadcast:channel'));assert.deepEqual(documentContract.mentions,['outsider']);assert.equal(documentContract.highlighted,false);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,'mentions-browser.png')});
    await writeFile(path.join(output,'browser-results.json'),JSON.stringify({passed:true,checks:['typed/toolbar parity','channel members and self','outsiders excluded','broadcast wire identifiers','red mention tokens only','persisted broadcast/user styling','channel/thread/edit encoding']},null,2));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
