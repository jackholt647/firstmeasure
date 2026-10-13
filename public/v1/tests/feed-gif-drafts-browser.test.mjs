import {installPolishFixture,verifyPolishComposer} from './helpers/draft-polish-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
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
  await page.goto('http://feed.test/');if(process.env.VISUAL_QA){await page.addStyleTag({url:'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'});await page.addStyleTag({content:'body{font-family:Arial}'});await page.evaluate(()=>document.fonts.ready);}await page.addStyleTag({content:'.fas{display:inline-block;width:14px;height:14px}'});
  await page.addScriptTag({url:'/libraries/platform-widgets/gifs.js'});
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'sam'};
   const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.Portal={cfg:__APP,util:{escapeHtml,injectCSS:(id,css)=>{const s=document.createElement('style');s.textContent=css;document.head.append(s);}},ui:{showToast(){}},apps:{registerPortalApp:app=>window.feedApp=app},tabs:{renderTabs(){}},appFlags:{has:()=>true,load:async()=>{}},navigation:{read:()=>({}),replace(){}},routeState:{get:()=>({})}};
   window.rootMessage={id:'root',text:'Original post',created_at:new Date().toISOString(),metadata:{feed_post:true,giphy:{id:'fixture',url:'https://media.giphy.com/media/test/giphy.gif',width:200,height:160}},reply_count:0,reactions:[],author:{id:'sam',name:'Sam'}};
   window.comments=[];window.posts=[];window.replies=[];
   const thread=()=>({root:rootMessage,replies});
   window.PlatformAPI={users:{list:async()=>({documents:[{id:'sam',name:'Sam'}]})},projects:{list:async()=>({documents:[]})}};
   window.ChannelsAPI={gifs:{config:async()=>({enabled:true,sdk_key:'test'})},mediaFileUrl:()=>'',channels:{list:async()=>({channels:[]})},feed:{
    catalog:async()=>({projects:[],media:[],events:[],users:[{id:'sam',name:'Sam'}],views:['list','posts'],can_comment:true,can_react:true,can_post:true,manual_posts:[rootMessage],departments:[],user_departments:{sam:[]},member_department_ids:[]}),
    authorize:async()=>({sources:[]}),lookup:async()=>thread(),resolve:async()=>thread(),thread:async()=>thread(),
    comment:async(org,id,body)=>{if(window.failComment){window.failComment=false;throw Error('Failed');}comments.push(body);replies.push({...body,id:'reply'+comments.length,created_at:new Date().toISOString(),author:{id:'sam',name:'Sam'}});rootMessage.reply_count++;return {};},
    createPost:async(org,body)=>{posts.push(body);return {message:{id:'new-post'}};}
   }};
  });
  await installPolishFixture(page);
  for(const path of ['channels-ui/channels-ui.js','platform-ui/platform-ui.js','platform-tags/platform-tags.js','apps/photos/feed.js'])await page.addScriptTag({url:'/libraries/'+path});
  await page.waitForFunction(()=>window.feedApp);await page.evaluate(()=>feedApp.mount(document.querySelector('#feed')));
  await page.getByRole('button',{name:'Posts',exact:true}).click();
  const post=page.locator('[data-feed-post="manual:root"]');await post.waitFor();assert.equal(await post.locator('.pf-manual-gif .fm-widget-gif').count(),1);assert.equal(await post.locator('.pf-manual-gif figcaption img').getAttribute('alt'),'Powered by GIPHY');
  await post.locator('[data-post-comments]').last().click();
  await mkdir(new URL('../../../output/shared-polish/',import.meta.url),{recursive:true});await verifyPolishComposer(page,post.locator('[data-comment-editor]'),post.locator('[data-comment-form]'),{screenshot:fileURLToPath(new URL('../../../output/shared-polish/feed-comment-polishing.png',import.meta.url))});assert.equal(await page.evaluate(()=>comments.length),0);assert.equal(await page.evaluate(()=>polishCalls.at(-1).kind),'comment');
  const choose=async trigger=>{await trigger.click();await page.getByRole('dialog',{name:'Choose a GIF'}).getByRole('button',{name:'Choose test GIF'}).click();};
  assert.equal(await post.locator('.pf-comment-input').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(255, 255, 255)');
  assert.ok(await post.locator('[data-comment-editor]').evaluate(n=>n.getBoundingClientRect().height>=42 && n.getBoundingClientRect().height<=48));assert.equal(await post.locator('.fm-ch-formatbar').evaluate(n=>getComputedStyle(n).borderBottomWidth),'0px');
  assert.equal(await post.locator('.fm-ch-more-actions').count(),0,'one recording action has no More wrapper');assert.equal(await post.locator('.pf-comment-tools').evaluate(n=>{const audio=n.querySelector('[data-comment-audio]').getBoundingClientRect(),send=n.querySelector('[type=submit]').getBoundingClientRect(),row=n.getBoundingClientRect();return audio.right<send.left && audio.left<row.left+130;}),true,'audio stays with the left-hand tools');
  const commentButtons=await post.locator('.fm-ch-formatbar>button').evaluateAll(nodes=>nodes.filter(n=>!n.hidden).map(n=>({border:getComputedStyle(n).borderTopWidth,background:getComputedStyle(n).backgroundColor,height:n.getBoundingClientRect().height,color:getComputedStyle(n).color})));assert.ok(commentButtons.every(n=>n.border==='0px' && n.background==='rgba(0, 0, 0, 0)' && n.height>=26 && n.height<=28 && n.color==='rgb(102, 112, 133)'),JSON.stringify(commentButtons));
  for(let i=0;i<2;i++){const toggle=post.getByRole('button',{name:'Insert emoji',exact:true});await toggle.click();await page.locator('.pf-emoji-widget').waitFor();await toggle.locator('i').click();assert.equal(await page.locator('.pf-emoji-widget').count(),0,'emoji icon and its child toggle the picker closed');}
  await mkdir(new URL('../../../output/composer-refinements/',import.meta.url),{recursive:true});await post.locator('.pf-comment-input').screenshot({path:fileURLToPath(new URL('../../../output/composer-refinements/feed-comment.png',import.meta.url))});
  await post.locator('[data-mention-button]').click();await page.locator('[data-mention-user=sam]').click();assert.equal(await post.locator('[data-comment-editor]').evaluate(n=>[...CSS.highlights.get('fm-channel-mentions')].some(r=>n.contains(r.startContainer))),true);
  assert.equal(await post.locator('[data-comment-editor]').evaluate(n=>getComputedStyle(n,'::highlight(fm-channel-mentions)').color),'rgb(217, 48, 37)');
  await post.locator('[data-comment-editor]').fill('Caption');await choose(post.locator('[data-comment-gif]'));
  assert.equal(await page.evaluate(()=>comments.length),0);assert.equal(await post.locator('[data-comment-editor]').evaluate(n=>n.value),'Caption');
  await post.getByRole('button',{name:'Remove GIF'}).click();assert.equal(await post.locator('.pf-composer-gif').count(),0);
  await choose(post.locator('[data-comment-gif]'));await page.evaluate(()=>window.failComment=true);
  await post.getByRole('button',{name:'Post comment'}).click();await post.locator('.pf-composer-gif>.fm-widget-gif>a>img').waitFor();
  assert.equal(await page.evaluate(()=>comments.length),0);assert.equal(await post.locator('[data-comment-editor]').evaluate(n=>n.value),'Caption');
  await post.getByRole('button',{name:'Post comment'}).click();await page.waitForFunction(()=>comments.length===1);
  assert.equal(await page.evaluate(()=>comments[0].metadata.giphy.id),'draft-gif');assert.equal(await page.evaluate(()=>comments[0].text),'Caption');assert.equal(await post.locator('.pf-comment .fm-widget-gif figcaption img').count(),1);
  assert.equal(await post.locator('.pf-composer-gif').count(),0);
  await post.locator('.pf-comment').getByRole('button',{name:'Reply',exact:true}).first().click();await verifyPolishComposer(page,post.locator('[data-comment-editor]'),post.locator('[data-comment-form]'));assert.equal(await page.evaluate(()=>polishCalls.at(-1).reply_to),'reply1');await post.getByRole('button',{name:'Cancel reply'}).click();
  await choose(post.locator('[data-comment-gif]'));assert.equal(await page.evaluate(()=>comments.length),1);
  await post.getByRole('button',{name:'Post comment'}).click();await page.waitForFunction(()=>comments.length===2);assert.equal(await page.evaluate(()=>comments[1].text),'');
  await page.locator('[data-feed-compose-open]').click();
  const postEditor=page.locator('[data-feed-compose] [contenteditable]');
  await verifyPolishComposer(page,postEditor,page.locator('[data-feed-compose]'),{screenshot:fileURLToPath(new URL('../../../output/shared-polish/post-modal-polishing.png',import.meta.url))});assert.equal(await page.evaluate(()=>posts.length),0);assert.equal(await page.evaluate(()=>polishCalls.at(-1).kind),'post');
  assert.equal(await page.locator('.pf-post-formatbar').evaluate(n=>getComputedStyle(n).borderBottomWidth),'1px','manual-post toolbar retains its prior divider and spacing');assert.equal(await page.locator('.pf-post-compose-tools .fm-ch-more-actions').count(),0);
  assert.equal(await page.locator('.pf-post-compose-tools [data-mention-button]').evaluate(n=>getComputedStyle(n).borderTopWidth),'0px');
  await page.locator('.pf-compose-message').screenshot({path:fileURLToPath(new URL('../../../output/composer-refinements/manual-post.png',import.meta.url))});
  assert.ok(await postEditor.evaluate(n=>n.getBoundingClientRect().height>=300),'manual posts keep their large editor');
  await page.setViewportSize({width:390,height:850});await page.locator('.pf-post-formatbar').evaluate(n=>n._fitFormatting?.());const narrow=await page.locator('.pf-compose-message').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right}));assert.ok(narrow.scroll<=narrow.width && narrow.left>=0 && narrow.right<=390,JSON.stringify(narrow));await page.locator('.pf-compose-message').screenshot({path:fileURLToPath(new URL('../../../output/shared-polish/post-modal-narrow.png',import.meta.url))});await page.setViewportSize({width:1400,height:1000});
  for(const name of ['Bold','Italic','Strikethrough']){await postEditor.evaluate(n=>{n.value='';n.focus();const r=document.createRange();r.selectNodeContents(n);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);});const toggle=page.locator('.pf-post-formatbar').getByRole('button',{name,exact:true});await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');assert.equal(await toggle.evaluate(n=>getComputedStyle(n).color),'rgb(217, 48, 37)');await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');}

  await page.locator('[data-feed-compose] [data-mention-button]').click();await page.locator('[data-mention-user=sam]').click();assert.equal(await postEditor.evaluate(n=>[...CSS.highlights.get('fm-channel-mentions')].some(r=>n.contains(r.startContainer))),true);await postEditor.fill('');
  await choose(page.locator('[data-feed-compose-gif]'));assert.equal(await page.evaluate(()=>posts.length),0);
  await page.locator('[data-feed-compose-remove-gif]').click();await choose(page.locator('[data-feed-compose-gif]'));
  await page.locator('[data-feed-compose] button[type=submit]').click();await page.waitForFunction(()=>posts.length===1);
  assert.equal(await page.evaluate(()=>posts[0].giphy.id),'draft-gif');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
