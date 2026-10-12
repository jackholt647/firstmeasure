import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const sdk=`export class GiphyFetch{async trending(){return {data:[{id:'draft-gif'}]};}search(){return this.trending();}}
export function renderGrid(options,host){let active=true;options.fetchGifs(0).then(()=>{if(!active)return;const b=document.createElement('button');b.textContent='Choose test GIF';b.onclick=e=>options.onGifClick({id:'draft-gif',title:'Test GIF',images:{fixed_width:{url:'https://media.giphy.com/media/test/giphy.gif',width:'200',height:'160'}}},e);host.append(b);});return()=>{active=false;host.replaceChildren();};}`;
test('Feed comments and posts attach GIFs until explicit submit and retain failed drafts',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://feed.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith('/gif-picker/giphy-sdk.js'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:sdk});
   if(path.startsWith('/libraries/')&&path.endsWith('.js'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:process.env.DEV_ASSETS?Buffer.from(await(await fetch('https://dev.1m8.ai'+path+'?draft-check='+Date.now())).arrayBuffer()):await readFile(new URL(path.slice('/libraries/'.length),libraries))});
   return route.fulfill({contentType:'text/html',body:'<html><body><main id="feed" style="height:900px"></main></body></html>'});
  });
  await page.route('https://media.giphy.com/**',r=>r.fulfill({contentType:'image/gif',body:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')}));
  await page.goto('http://feed.test/');
  await page.addScriptTag({url:'/libraries/platform-widgets/gifs.js'});
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'sam'};
   const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.Portal={cfg:__APP,util:{escapeHtml,injectCSS:(id,css)=>{const s=document.createElement('style');s.textContent=css;document.head.append(s);}},ui:{showToast(){}},apps:{registerPortalApp:app=>window.feedApp=app},tabs:{renderTabs(){}},appFlags:{has:()=>true,load:async()=>{}},navigation:{read:()=>({}),replace(){}},routeState:{get:()=>({})}};
   window.rootMessage={id:'root',text:'Original post',created_at:new Date().toISOString(),metadata:{feed_post:true,giphy:{id:'fixture',url:'https://media.giphy.com/media/test/giphy.gif',width:200,height:160}},reply_count:0,reactions:[],author:{id:'sam',name:'Sam'}};
   window.comments=[];window.posts=[];window.replies=[];
   const thread=()=>({root:rootMessage,replies});
   window.PlatformAPI={users:{list:async()=>({documents:[]})},projects:{list:async()=>({documents:[]})}};
   window.ChannelsAPI={gifs:{config:async()=>({enabled:true,sdk_key:'test'})},mediaFileUrl:()=>'',channels:{list:async()=>({channels:[]})},feed:{
    catalog:async()=>({projects:[],media:[],events:[],users:[{id:'sam',name:'Sam'}],views:['list','posts'],can_comment:true,can_react:true,can_post:true,manual_posts:[rootMessage],departments:[],user_departments:{sam:[]},member_department_ids:[]}),
    authorize:async()=>({sources:[]}),lookup:async()=>thread(),resolve:async()=>thread(),thread:async()=>thread(),
    comment:async(org,id,body)=>{if(window.failComment){window.failComment=false;throw Error('Failed');}comments.push(body);replies.push({...body,id:'reply'+comments.length,created_at:new Date().toISOString(),author:{id:'sam',name:'Sam'}});rootMessage.reply_count++;return {};},
    createPost:async(org,body)=>{posts.push(body);return {message:{id:'new-post'}};}
   }};
  });
  for(const path of ['channels-ui/channels-ui.js','apps/photos/feed.js'])await page.addScriptTag({url:'/libraries/'+path});
  await page.waitForFunction(()=>window.feedApp);await page.evaluate(()=>feedApp.mount(document.querySelector('#feed')));
  await page.getByRole('button',{name:'Posts',exact:true}).click();
  const post=page.locator('[data-feed-post="manual:root"]');await post.waitFor();assert.equal(await post.locator('.pf-manual-gif .fm-widget-gif').count(),1);assert.equal(await post.locator('.pf-manual-gif figcaption img').getAttribute('alt'),'Powered by GIPHY');
  await post.getByRole('button',{name:'Comments',exact:true}).click();
  const choose=async trigger=>{await trigger.click();await page.getByRole('dialog',{name:'Choose a GIF'}).getByRole('button',{name:'Choose test GIF'}).click();};
  await post.locator('textarea').fill('Caption');await choose(post.locator('[data-comment-gif]'));
  assert.equal(await page.evaluate(()=>comments.length),0);assert.equal(await post.locator('textarea').inputValue(),'Caption');
  await post.getByRole('button',{name:'Remove GIF'}).click();assert.equal(await post.locator('.pf-composer-gif').count(),0);
  await choose(post.locator('[data-comment-gif]'));await page.evaluate(()=>window.failComment=true);
  await post.getByRole('button',{name:'Post comment'}).click();await post.locator('.pf-composer-gif>.fm-widget-gif>a>img').waitFor();
  assert.equal(await page.evaluate(()=>comments.length),0);assert.equal(await post.locator('textarea').inputValue(),'Caption');
  await post.getByRole('button',{name:'Post comment'}).click();await page.waitForFunction(()=>comments.length===1);
  assert.equal(await page.evaluate(()=>comments[0].metadata.giphy.id),'draft-gif');assert.equal(await page.evaluate(()=>comments[0].text),'Caption');assert.equal(await post.locator('.pf-comment .fm-widget-gif figcaption img').count(),1);
  assert.equal(await post.locator('.pf-composer-gif').count(),0);
  await choose(post.locator('[data-comment-gif]'));assert.equal(await page.evaluate(()=>comments.length),1);
  await post.getByRole('button',{name:'Post comment'}).click();await page.waitForFunction(()=>comments.length===2);assert.equal(await page.evaluate(()=>comments[1].text),'');
  await page.locator('[data-feed-compose-open]').click();
  const postEditor=page.locator('[data-feed-compose] [contenteditable]');
  for(const name of ['Bold','Italic','Strikethrough']){await postEditor.evaluate(n=>{n.value='';n.focus();const r=document.createRange();r.selectNodeContents(n);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);});const toggle=page.locator('.pf-post-formatbar').getByRole('button',{name,exact:true});await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');assert.equal(await toggle.evaluate(n=>getComputedStyle(n).color),'rgb(217, 48, 37)');await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');}

  await choose(page.locator('[data-feed-compose-gif]'));assert.equal(await page.evaluate(()=>posts.length),0);
  await page.locator('[data-feed-compose-remove-gif]').click();await choose(page.locator('[data-feed-compose-gif]'));
  await page.locator('[data-feed-compose] button[type=submit]').click();await page.waitForFunction(()=>posts.length===1);
  assert.equal(await page.evaluate(()=>posts[0].giphy.id),'draft-gif');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
