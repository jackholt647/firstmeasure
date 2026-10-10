import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries=new URL('../../libraries/',import.meta.url);
const sdk=`
export class GiphyFetch {
  async search(query,options){window.requests.push({query,...options});if(query==='stalled')await new Promise(()=>{});if(query==='error')throw Error('Offline');return {data:query==='empty'?[]:[{id:query||'trending'}]};}
  trending(options){return this.search('',options);}
}
export function renderGrid(options,host){
  let active=true;
  options.fetchGifs(0).then(data=>{if(!active)return;for(const item of data.data){
    const button=document.createElement('button');button.textContent=item.id;button.style.cssText='width:138px;height:115px;background:#e8edf7;border-radius:6px';
    button.onclick=event=>options.onGifClick({id:item.id,title:item.id,images:{fixed_width:{url:'https://media.giphy.com/media/'+item.id+'/giphy.gif',width:'200',height:'160'}}},event);host.append(button);
  }});
  return ()=>{active=false;window.gridDisposals++;host.replaceChildren();};
}`;

async function setup(browser,{realSdk=false}={}){
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://gif.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(!realSdk&&pathname.includes('/gif-picker/giphy-sdk.js'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:sdk});
    if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:process.env.DEV_ASSETS?Buffer.from(await (await fetch('https://dev.1m8.ai'+pathname+'?picker-check='+Date.now())).arrayBuffer()):await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body style="font-family:Arial"><button id="outside">Outside</button><div id="host" style="position:fixed;right:16px;bottom:16px"></div></body></html>'});
  });
  await page.goto('http://gif.test/');
  await page.evaluate(()=>{
    window.requests=[];window.sent=[];window.gridDisposals=0;window.sendErrors=[];
    window.ChannelsAPI={gifs:{config:async()=>({enabled:true,sdk_key:'test'})}};
  });
  await page.addScriptTag({url:'/libraries/channels-ui/channels-ui.js'});
  await page.evaluate(()=>{
    window.trigger=FirstMateChannels.createGifPickerButton({orgId:'test',onError:error=>sendErrors.push(error.message),onSend:async(item,operationId)=>{sent.push({item,operationId});if(window.delaySend)await new Promise(resolve=>window.finishSend=resolve);}});
    document.querySelector('#host').append(trigger);
  });
  return {page,errors,trigger:page.getByRole('button',{name:'Send a GIF'}),pop:page.getByRole('dialog',{name:'Choose a GIF'})};
}

test('GIF picker is anchored, searchable, non-modal, and selects only once',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
  try{
    const {page,errors,trigger,pop}=await setup(browser);
    await trigger.click();await pop.getByRole('button',{name:'trending',exact:true}).waitFor();
    assert.equal(await page.locator('.fm-ch-modal-backdrop').count(),0);
    assert.equal(await pop.getAttribute('aria-modal'),null);
    assert.equal(await trigger.getAttribute('aria-expanded'),'true');
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Search GIPHY');
    const box=await pop.boundingBox(),anchor=await trigger.boundingBox();
    assert.equal(box.width,304);assert.ok(box.y+box.height<anchor.y);assert.ok(box.x+box.width<=992);
    await pop.getByRole('searchbox').fill('cats');await pop.getByRole('button',{name:'cats',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>requests.map(request=>request.query)),['','cats']);
    assert.ok(await page.evaluate(()=>requests.every(request=>request.rating==='pg')));
    await page.evaluate(()=>window.delaySend=true);
    await pop.getByRole('button',{name:'cats',exact:true}).click();
    await page.evaluate(()=>document.querySelector('.fm-picker-gif-grid button').click());
    assert.equal(await page.evaluate(()=>sent.length),1);
    await page.evaluate(()=>finishSend());await pop.waitFor({state:'detached'});
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    assert.equal(await page.evaluate(()=>document.activeElement===trigger),true);
    assert.equal(await page.evaluate(()=>sent[0].item.url),'https://media.giphy.com/media/cats/giphy.gif');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('GIF picker dismisses and cleans up, handles empty/error results and fits small screens',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
  try{
    const {page,errors,trigger,pop}=await setup(browser);
    await trigger.click();await pop.getByRole('button',{name:'trending',exact:true}).waitFor();
    await trigger.click();await pop.waitFor({state:'detached'});
    await trigger.click();await pop.getByRole('searchbox').fill('cancelled');await page.keyboard.press('Escape');await pop.waitFor({state:'detached'});
    await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>requests.some(request=>request.query==='cancelled')),false);
    await trigger.click();await page.getByRole('button',{name:'Outside',exact:true}).click();await pop.waitFor({state:'detached'});
    await page.setViewportSize({width:280,height:420});await trigger.click();
    await pop.getByRole('searchbox').fill('empty');await pop.getByText('No GIFs found. Try another search.').waitFor();
    await pop.getByRole('searchbox').fill('error');await pop.getByText('GIF search is unavailable or its request limit was reached. Try again later.').waitFor();
    await pop.getByRole('searchbox').fill('');await pop.getByRole('button',{name:'trending',exact:true}).waitFor();
    const box=await pop.boundingBox();assert.ok(box.x>=8&&box.x+box.width<=272);assert.ok(box.y>=8&&box.y+box.height<=412);
    if(process.env.GIF_PICKER_SCREENSHOT){await mkdir(new URL('../../../output/gif-picker/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../../../output/gif-picker/compact.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});}
    await page.evaluate(()=>trigger.remove());await pop.waitFor({state:'detached'});
    assert.ok(await page.evaluate(()=>gridDisposals>=4));assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Feed compatibility adapters delegate to shared widgets, including temporary GIF buttons',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
  try{
    const {page,errors}=await setup(browser);
    await page.evaluate(()=>{
      document.querySelector('#outside').onclick=()=>FirstMateChannels.createGifPickerButton({orgId:'test',dialogTitle:'Choose a GIF',actionLabel:'Add GIF',onSend:item=>sent.push(item)}).click();
    });
    await page.getByRole('button',{name:'Outside',exact:true}).click();
    const pop=page.getByRole('dialog',{name:'Choose a GIF'});await pop.getByRole('button',{name:'trending',exact:true}).click();
    assert.equal(await page.evaluate(()=>sent[0].id),'trending');
    await page.evaluate(()=>{window.emoji=FirstMateChannels.mountEmojiPicker(document.querySelector('#host'),value=>sent.push(value));emoji.focus();});
    await page.getByRole('button',{name:'🎉',exact:true}).click();assert.equal(await page.evaluate(()=>sent[1]),'🎉');
    assert.equal(await page.evaluate(()=>typeof FirstMateChannels.composerWidgets.createEditor),'function');
    await page.evaluate(()=>emoji.destroy());assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('widget library uses the bundled GIPHY grid and disposes its open picker',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
  try{
    const {page,errors,pop}=await setup(browser,{realSdk:true});
    await page.addStyleTag({content:'.fm-picker-gif-grid::-webkit-scrollbar{width:16px}'});
    await page.route('https://**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname==='api.giphy.com'){
        const image={url:'https://media.giphy.com/media/test/giphy.gif',width:'200',height:'160',size:'100'};
        const gifs=Array.from({length:12},(_,i)=>({id:'test'+i,type:'gif',title:'Test GIF '+i,url:'https://giphy.com/gifs/test'+i,slug:'test'+i,username:'',rating:'pg',source:'',images:Object.fromEntries(['original','original_still','fixed_width','fixed_width_still','fixed_width_small','fixed_width_small_still','fixed_height','fixed_height_still','fixed_height_small','fixed_height_small_still','downsized'].map(key=>[key,image])),analytics:{}}));
        return route.fulfill({json:{data:gifs,pagination:{total_count:12,count:12,offset:0},meta:{status:200,msg:'OK',response_id:'test'}}});
      }
      if(url.hostname==='media.giphy.com')return route.fulfill({contentType:'image/gif',body:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')});
      return route.abort();
    });
    await page.evaluate(()=>{delete window.FirstMateChannels;document.getElementById('fm-channels-ui-styles')?.remove();window.renderers={};window.FirstMateWidgets={attachRenderer:(id,version,renderer)=>renderers[id]=renderer};});
    await page.addScriptTag({url:'/libraries/platform-widgets/grouped-widgets.js'});
    await page.evaluate(async()=>{
      window.selections=[];
      window.widget=await renderers['gif.picker'](document.querySelector('#host'),{config:{},reference:{},context:{target:{organizationId:'test'}},notifySelection:(value,options)=>selections.push({value,options})});
    });
    await page.getByRole('button',{name:'Send a GIF'}).click();
    const tile=pop.locator('.fm-picker-gif-grid img').first();await tile.waitFor();
    // A populated, scrolling grid must remain mounted after ResizeObserver runs.
    const originalTile=await tile.elementHandle();
    await page.waitForTimeout(500);
    assert.equal(await originalTile.evaluate(node=>node.isConnected),true);
    assert.equal(await pop.locator('.fm-picker-status').innerText(),'');
    assert.ok(await pop.locator('.fm-picker-gif-grid').evaluate(grid=>grid.scrollHeight>grid.clientHeight&&grid.offsetWidth>grid.clientWidth));
    await page.setViewportSize({width:280,height:420});
    await page.waitForFunction(()=>{const grid=document.querySelector('.fm-picker-gif-grid');return grid.scrollWidth<=grid.clientWidth;});
    await tile.click();await pop.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>selections[0].value.value),'https://media.giphy.com/media/test/giphy.gif');
    assert.equal(await page.evaluate(()=>selections[0].options.confirmed),true);
    await page.getByRole('button',{name:'Send a GIF'}).click();await tile.waitFor();
    await page.evaluate(()=>widget.destroy());await pop.waitFor({state:'detached'});
    assert.equal(await page.locator('#host').innerText(),'');assert.equal(await page.evaluate(()=>typeof FirstMateChannels),'undefined');assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('emoji widget works without Channels and shares its picker with the channel composer and reactions',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
  try{
    const {page,errors}=await setup(browser);
    await page.evaluate(()=>{delete window.FirstMateChannels;window.renderers={};window.FirstMateWidgets={attachRenderer:(id,version,renderer)=>renderers[id]=renderer};});
    await page.addScriptTag({url:'/libraries/platform-widgets/grouped-widgets.js'});
    await page.evaluate(async()=>{window.selections=[];window.widget=await renderers['emoji.picker'](document.querySelector('#host'),{config:{},notifySelection:(value,options)=>selections.push({value,options})});});
    await page.getByRole('searchbox',{name:'Search emoji',exact:true}).fill('Work');
    await page.getByRole('button',{name:'🧰',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>selections),[{value:{value:'🧰'},options:{confirmed:true,label:'🧰'}}]);
    assert.equal(await page.evaluate(()=>typeof FirstMateChannels),'undefined');
    await page.evaluate(()=>{widget.destroy();document.querySelector('#host').removeAttribute('style');document.querySelector('#host').style.height='650px';});
    await page.addScriptTag({url:'/libraries/channels-ui/channels-ui.js'});
    await page.evaluate(async()=>{
      const viewer={id:'viewer',name:'Morgan'},member={id:'member',name:'Avery'};
      const channel={id:'general',name:'general',type:'public',display_name:'General',members:[viewer,member],settings:{},permissions:{},unread:{},is_member:true,message_seq:1};
      const message={id:'message-1',channel_id:'general',seq:1,text:'Hello',author:member,created_at:new Date().toISOString(),reactions:[]};
      window.__APP={userId:viewer.id,userOrgId:'org'};window.Portal={currentUser:viewer,ui:{showToast(){}},appFlags:{current:()=>true,has:()=>true}};
      window.posts=[];window.reactions=[];
      Object.assign(ChannelsAPI,{channels:{list:async()=>({channels:[channel]}),get:async()=>({channel})},messages:{list:async()=>({channel,messages:[message]}),get:async()=>({message}),thread:async()=>({root:message,replies:[]}),react:async(org,id,emoji)=>{reactions.push({id,emoji});return {message};},post:async(org,id,input)=>{posts.push(input);return {message:{...message,id:'sent-'+posts.length,seq:posts.length+1,...input}};}},preferences:{collaboration:async()=>({preferences:{send_mode:'enter'}})},readState:{markRead:async()=>({})},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},scheduled:{list:async()=>({scheduled_messages:[]})}});
      window.instance=FirstMateChannels.create(document.querySelector('#host'),{orgId:'org',currentUser:viewer,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,channelCreate:false,channelSettings:false,recording:false}});await instance.setChannel('general');
    });
    await page.getByRole('button',{name:'Insert emoji',exact:true}).click();
    const emojiPop=page.getByRole('dialog',{name:'Choose an emoji'});await emojiPop.getByRole('button',{name:'🎉',exact:true}).click();
    assert.ok((await page.locator('[contenteditable=true]').first().innerText()).includes('🎉'));
    const message=page.locator('.fm-ch-msg[data-message-id="message-1"]');await message.hover();await message.locator('[data-act=react]').click();
    await emojiPop.getByRole('button',{name:'🔥',exact:true}).click();assert.deepEqual(await page.evaluate(()=>reactions),[{id:'message-1',emoji:'🔥'}]);
    await page.getByRole('button',{name:'Send a GIF',exact:true}).click();await page.getByRole('dialog',{name:'Choose a GIF'}).getByRole('button',{name:'trending',exact:true}).click();
    assert.equal(await page.evaluate(()=>posts[0].metadata.giphy.id),'trending');
    await page.evaluate(()=>instance.destroy());assert.equal(await page.locator('.fm-picker-popover').count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});


test('stalled GIF requests stop loading and a new search can recover',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:["--hide-scrollbars"]});
  try{
    const {page,errors,trigger,pop}=await setup(browser);
    await page.clock.install();
    await trigger.click();await pop.getByRole('button',{name:'trending',exact:true}).waitFor();
    await pop.getByRole('searchbox').fill('stalled');await page.clock.runFor(350);
    assert.equal(await pop.locator('.fm-picker-status').innerText(),'Loading GIFs…');
    await page.clock.runFor(15000);
    await pop.getByText('GIF search is unavailable or its request limit was reached. Try again later.').waitFor();
    await pop.getByRole('searchbox').fill('cats');await page.clock.runFor(350);
    await pop.getByRole('button',{name:'cats',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(()=>ChannelsAPI.gifs.config=()=>new Promise(()=>{}));
    await trigger.click();await page.clock.runFor(15000);
    await pop.getByText('GIF loading timed out. Close and reopen the picker to retry.').waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(()=>ChannelsAPI.gifs.config=async()=>({enabled:true,sdk_key:'test'}));
    await trigger.click();await pop.getByRole('button',{name:'trending',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
