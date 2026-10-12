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
  if(req.url.startsWith('/images/giphy/')){res.setHeader('Content-Type','image/png');const pathname=new URL(req.url,'http://fixture').pathname;const data=process.env.DEV_ASSETS?Buffer.from(await (await fetch('https://dev.1m8.ai'+pathname+'?mark-check='+Date.now())).arrayBuffer()):await readFile(publicRoot+pathname);res.end(data);return;}
    if(req.url==='/image.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="112"><rect width="200" height="112" fill="#526a8d"/></svg>');return;}
    const assets={'/libraries/platform-ui/platform-ui.js':'/libraries/platform-ui/platform-ui.js','/libraries/platform-widgets/pickers.js':'/libraries/platform-widgets/pickers.js','/libraries/date-time-picker/date-time-picker.js':'/libraries/date-time-picker/date-time-picker.js','/gifs.js':'/libraries/platform-widgets/gifs.js','/ui.js':'/libraries/channels-ui/channels-ui.js','/tags.js':'/libraries/platform-tags/platform-tags.js'};
    const asset=assets[new URL(req.url,'http://fixture').pathname];if(asset){
      res.setHeader('Content-Type','text/javascript; charset=utf-8');
      const data=process.env.DEV_ASSETS?await (async()=>{
        const response=await fetch('https://dev.1m8.ai'+asset+'?mentions='+Date.now());
        assert.ok(response.ok);return Buffer.from(await response.arrayBuffer());
      })():await readFile(path.join(publicRoot,asset));
      res.end(data);return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><html><body style="margin:0;font-family:Arial;--primary:#174ce4;--primary-readable:#174ce4"><div id="app" style="height:100vh"></div></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1380,height:850},timezoneId:'America/Los_Angeles'});page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(origin);
    await page.evaluate(()=>{
      const me={id:'owner',name:'Morgan'},member={id:'member',name:'J. Lee'},second={id:'second',name:'Sam & Sons'};
      const outsider={id:'outsider',name:'Not A Member'};
      const channel={id:'general',name:'general',type:'public',display_name:'General',members:[me,member,second],settings:{},permissions:{},unread:{},is_member:true,message_seq:1};
      const root={id:'root',channel_id:channel.id,seq:1,text:'Root @J. Lee remains ordinary text',author:me,created_at:new Date().toISOString(),mention_users:[member],can_edit:true,reply_count:0,reactions:[]};
      const special={...root,id:'special',seq:2,text:'@Sam & Sons remains ordinary; @Sam & SonsPlus is not this mention',mention_users:[second]};
      window.messages=[root,special,{...root,id:'gif-only',seq:3,text:'',mention_users:[],metadata:{giphy:{id:'spacing',url:'https://media.giphy.com/media/spacing/giphy.gif',width:200,height:112}}}];window.sent=[];window.edited=[];
      const copy=value=>structuredClone(value);
      window.__APP={userId:me.id,userOrgId:'mention-fixture',userName:me.name};
      window.Portal={currentUser:me,ui:{showToast(){}},appFlags:{current:()=>true,has:()=>true}};
      Portal.util={injectCSS:(id,css)=>{if(document.getElementById(id))return;const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}};
      window.FirstMateAudioNotes={prepareInline:async(_org,_channel,options)=>options.mode==='dictation' ? {text:'Dictated reply'} : {attachment:{id:'thread-audio',media_id:'thread-audio',content_type:'audio/webm'},metadata:{duration_seconds:4}}};
      window.ChannelsAPI={uploads:{send:async(_org,file)=>({attachment:{id:'thread-image',media_id:'thread-image',content_type:file.type,file_name:file.name}})},mediaFileUrl:()=>'/image.svg',
        channels:{list:async()=>({channels:[channel]}),get:async()=>({channel})},
        directory:{list:async()=>({users:[me,member,second,outsider]})},
        preferences:{collaboration:async()=>({preferences:{send_mode:'modified_enter'}})},
        readState:{markRead:async()=>({})},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},
        scheduled:{list:async()=>({scheduled_messages:[]}),create:async(_org,payload)=>{if(window.failSchedule)throw Error('Schedule failed');(window.schedules ||= []).push(copy(payload));return {};}},threads:{markRead:async()=>({})},
        messages:{
          list:async()=>({channel,messages:copy(messages.filter(message=>!message.parent_id))}),
          thread:async(_org,id)=>({root:copy(messages.find(message=>message.id===id)),replies:copy(messages.filter(message=>message.parent_id===id))}),
          post:async(_org,_id,input)=>{
            if(window.failReply && input.parent_id)throw Error('Reply failed');sent.push(copy(input));
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
      window.fixtureOptions={orgId:'mention-fixture',currentUser:me,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:true,channelCreate:false,channelSettings:false,recording:false}};
    });
    await page.addScriptTag({url:origin+'/libraries/platform-ui/platform-ui.js'});await page.addScriptTag({url:origin+'/gifs.js'});await page.addScriptTag({url:origin+'/tags.js'});await page.addScriptTag({url:origin+'/ui.js'});
    await page.evaluate(async()=>{window.instance=FirstMateChannels.create(document.querySelector('#app'),fixtureOptions);await instance.setChannel('general');});

    async function verifyFormatting(editor){
      const toolbar=editor.locator('xpath=..').locator('.fm-ch-formatbar');
      for(const name of ['Bold','Italic','Strikethrough']){
        await editor.evaluate(n=>{n.value='';n.focus();const range=document.createRange();range.selectNodeContents(n);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);});
        const button=toolbar.getByRole('button',{name,exact:true});await button.click();assert.equal(await button.getAttribute('aria-pressed'),'true');assert.equal(await button.evaluate(n=>getComputedStyle(n).color),'rgb(217, 48, 37)');await button.click();assert.equal(await button.getAttribute('aria-pressed'),'false');
      }
      await editor.evaluate(n=>{n.value='';n.focus();const range=document.createRange();range.selectNodeContents(n);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);});const bold=toolbar.getByRole('button',{name:'Bold',exact:true});await editor.press('Control+b');await page.waitForFunction(n=>n.getAttribute('aria-pressed')==='true',await bold.elementHandle());await editor.press('Control+b');await page.waitForFunction(n=>n.getAttribute('aria-pressed')==='false',await bold.elementHandle());
      await editor.evaluate(n=>n.value='');
    }
    const gifMessage=page.locator('.fm-ch-msg[data-message-id="gif-only"]');await gifMessage.locator('.fm-ch-gif').waitFor();assert.equal(await gifMessage.locator('.fm-ch-msg-body').isHidden(),true);const gifSpacing=await gifMessage.evaluate(node=>{const head=node.querySelector('.fm-ch-msg-head').getBoundingClientRect(),image=node.querySelector('.fm-ch-gif img').getBoundingClientRect(),figure=node.querySelector('.fm-ch-gif');return {before:image.top-head.bottom,bottom:getComputedStyle(figure).marginBottom,caption:getComputedStyle(figure.querySelector('figcaption')).lineHeight,position:getComputedStyle(figure.querySelector('figcaption')).position};});assert.ok(gifSpacing.before<=4,JSON.stringify(gifSpacing));assert.equal(gifSpacing.bottom,'0px');assert.equal(gifSpacing.caption,'12px');assert.equal(gifSpacing.position,'absolute');
    const editor=page.locator('.fm-ch-composer .fm-ch-rich-editor').first();
    assert.ok(await editor.evaluate(n=>n.getBoundingClientRect().height>=44 && n.getBoundingClientRect().height<=50),'channel composer starts at two lines');
    assert.equal(await page.locator('.fm-ch-composer .fm-ch-formatbar').first().evaluate(n=>getComputedStyle(n).borderBottomWidth),'0px');
    assert.equal(await page.locator('.fm-ch-formatbar [data-mention-button]').count(),0);
    const schedule=page.locator('.fm-ch-composer').getByRole('button',{name:'Schedule message',exact:true});
    for(const [label,monday] of [['Tomorrow at 9:00 AM',false],['Next Monday at 9:00 AM',true]]){
      await editor.fill(label);const expected=await page.evaluate(monday=>{const date=new Date();date.setDate(date.getDate()+(monday?((1-date.getDay()+7)%7 || 7):1));date.setHours(9,0,0,0);return {iso:date.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};},monday);
      await schedule.click();await page.getByRole('menuitem',{name:label,exact:true}).click();await page.waitForFunction(()=>document.querySelector('.fm-ch-composer .fm-ch-rich-editor').value==='');
      assert.deepEqual(await page.evaluate(()=>({iso:schedules.at(-1).scheduled_at,timezone:schedules.at(-1).timezone})),expected);
    }
    await editor.fill('Keep failed schedule draft');await page.evaluate(()=>window.failSchedule=true);await schedule.click();await page.getByRole('menuitem',{name:'Tomorrow at 9:00 AM',exact:true}).click();await page.getByText('Schedule failed',{exact:true}).waitFor();assert.equal(await editor.evaluate(n=>n.value),'Keep failed schedule draft');assert.equal(await page.evaluate(()=>schedules.length),2);await page.keyboard.press('Escape');await page.evaluate(()=>window.failSchedule=false);
    await editor.fill('Use custom picker');await schedule.click();await page.getByRole('menuitem',{name:'Custom time',exact:true}).click();const calendar=page.getByRole('dialog',{name:'Schedule message',exact:true});await calendar.locator('[data-schedule-calendar]').waitFor();assert.ok(await calendar.locator('[data-schedule-calendar]').evaluate(n=>n.children.length>0));await calendar.getByRole('button',{name:'Schedule send',exact:true}).click();await page.waitForFunction(()=>schedules.length===3);await calendar.waitFor({state:'detached'});
    const mainComposer=page.locator('.fm-ch-composer').first();
    assert.equal(await mainComposer.getByRole('button',{name:'Send',exact:true}).locator('.fa-paper-plane').count(),1);assert.equal(await mainComposer.getByRole('button',{name:'Send',exact:true}).innerText(),'');assert.equal(await mainComposer.locator('.fm-ch-send-pair').evaluate(n=>getComputedStyle(n).borderLeftWidth),'0px');assert.deepEqual(await mainComposer.locator('.fm-ch-send-pair>button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Send','Schedule message']);
    assert.equal(await mainComposer.getByRole('button',{name:'Send',exact:true}).evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(23, 76, 228)');assert.equal(await mainComposer.locator('.fm-ch-send-pair').evaluate(n=>n.children[0].getBoundingClientRect().width>n.children[1].getBoundingClientRect().width),true,'filled Send is larger than Schedule');
    await mainComposer.locator('[type=file]').setInputFiles({name:'main.png',mimeType:'image/png',buffer:Buffer.from('fixture')});const mainImage=mainComposer.locator('.fm-ch-image-draft');await mainImage.locator('img').evaluate(n=>n.decode());assert.equal(await mainImage.innerText(),'');await mainImage.getByRole('button',{name:'Remove attachment'}).click();
    const emojiToggle=mainComposer.getByRole('button',{name:'Insert emoji',exact:true});await emojiToggle.click();await page.getByRole('dialog',{name:'Choose an emoji'}).waitFor();await emojiToggle.click();assert.equal(await page.getByRole('dialog',{name:'Choose an emoji'}).count(),0);
    const moreToggle=mainComposer.getByRole('button',{name:'More options',exact:true});await moreToggle.click();await page.locator('.fm-ch-recording-menu').waitFor();assert.ok(await page.locator('.fm-ch-recording-menu button').count()>=2);await moreToggle.click();assert.equal(await page.locator('.fm-ch-recording-menu').count(),0);
    await verifyFormatting(editor);
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
    await reply.waitFor();const replyComposer=page.locator('.fm-ch-panel .fm-ch-composer');assert.equal(await replyComposer.getByRole('button',{name:'Reply',exact:true}).locator('.fa-paper-plane').count(),1);assert.equal(await replyComposer.locator('.fm-ch-composer-row').evaluate(n=>n.querySelector('[data-mention-button]').getBoundingClientRect().right<n.querySelector('.fm-ch-send').getBoundingClientRect().left),true,'reply tagging stays with the left icon group');
    assert.equal(await replyComposer.locator('.fm-ch-composer-row .fm-ch-reply-broadcast').count(),0);assert.equal(await replyComposer.locator('.fm-ch-composer-box>.fm-ch-reply-broadcast').evaluate(n=>n.getBoundingClientRect().bottom<=n.nextElementSibling.getBoundingClientRect().top),true,'broadcast checkbox sits above the icon row');
    const replyMore=replyComposer.getByRole('button',{name:'See more formatting'});await replyMore.click();await page.getByRole('menuitem',{name:'Code block',exact:true}).waitFor();assert.equal(await page.locator('.fm-ch-popover').evaluate(n=>n.scrollWidth<=n.clientWidth),true,'reply menu fits without horizontal scroll');assert.equal(await page.getByRole('menuitem',{name:'Code block',exact:true}).evaluate(n=>getComputedStyle(n).color),'rgb(16, 24, 40)');await replyMore.click();assert.equal(await page.locator('.fm-ch-popover').count(),0);
    for(const label of ['Insert emoji','Attach a file','Dictate message','Mention a teammate','More options'])assert.equal(await replyComposer.getByRole('button',{name:label,exact:true}).isVisible(),true);
    await replyComposer.getByRole('button',{name:'Dictate message'}).click();await page.waitForFunction(()=>document.querySelector('.fm-ch-panel .fm-ch-rich-editor').value==='Dictated reply');await reply.fill('');await replyComposer.getByRole('button',{name:'More options'}).click();assert.deepEqual(await page.locator('.fm-ch-recording-menu [role=menuitem]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Record an audio note','Record video clip','Record screen clip']);await page.getByRole('menuitem',{name:'Record an audio note',exact:true}).click();
    await replyComposer.locator('[type=file]').setInputFiles({name:'reply.png',mimeType:'image/png',buffer:Buffer.from('fixture')});const threadImage=replyComposer.locator('.fm-ch-image-draft');await threadImage.locator('img').evaluate(n=>n.decode());assert.deepEqual(await threadImage.locator('img').evaluate(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})),{width:84,height:84});
    await verifyFormatting(reply);await reply.fill('Reply first');await reply.press('Shift+Enter');await page.keyboard.type('Reply second');
    assert.equal(await page.evaluate(()=>sent.length),3);
    await page.evaluate(()=>window.failReply=true);await reply.press('Enter');await page.getByText('Reply failed',{exact:true}).waitFor();assert.equal(await threadImage.count(),1,'failed reply retains uploaded thumbnail');assert.equal(await page.evaluate(()=>sent.length),3);await page.evaluate(()=>window.failReply=false);
    await reply.press('Enter');await page.waitForFunction(()=>sent.length===4);
    assert.equal(await page.evaluate(()=>sent[3].parent_id),'root');assert.deepEqual(await page.evaluate(()=>sent[3].attachment_ids),['thread-audio','thread-image']);assert.equal(await page.evaluate(()=>sent[3].metadata.audio_note.duration_seconds),4);
    assert.match(await page.evaluate(()=>sent[3].text),/Reply first\nReply second/);
    await page.evaluate(async()=>{instance.destroy();document.querySelector('#app').replaceChildren();const old=ChannelsAPI.channels.get;ChannelsAPI.channels.get=async()=>{const result=await old();result.channel.type='dm';return result;};window.instance=FirstMateChannels.create(document.querySelector('#app'),fixtureOptions);await instance.setChannel('general');});
    const dm=page.locator('.fm-ch-composer .fm-ch-rich-editor').first();await verifyFormatting(dm);await dm.fill('DM message');await dm.press('Enter');await page.waitForFunction(()=>sent.length===5);
    assert.equal(await page.evaluate(()=>sent[4].text),'DM message');
    await page.evaluate(async()=>{messages.push({...messages[0],id:'table-size',text:'| Name | Value |\n| --- | --- |\n'+Array.from({length:12},(_,i)=>'| Row '+i+' | '+i+' |').join('\n')});await instance.setChannel('general');});
    await page.setViewportSize({width:2400,height:1400});await page.locator('[data-message-id=table-size] .fm-ch-table-open').click();const tableModal=page.getByRole('dialog',{name:'Table',exact:true});await tableModal.evaluate(n=>Promise.all(n.getAnimations().map(a=>a.finished)));assert.deepEqual(await tableModal.evaluate(n=>{const r=n.getBoundingClientRect();return {width:r.width,height:r.height};}),{width:1720,height:1180});await page.setViewportSize({width:1100,height:800});const tableSize=await tableModal.evaluate(n=>{const r=n.getBoundingClientRect();return {width:r.width,height:r.height};});assert.ok(Math.abs(tableSize.width-1056)<1 && Math.abs(tableSize.height-736)<1,JSON.stringify(tableSize));await tableModal.getByRole('button',{name:'Close dialog',exact:true}).click();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
