import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const {chromium}=createRequire(import.meta.url)('playwright-core');
const publicRoot=fileURLToPath(new URL('../../',import.meta.url));
test('photo viewer mounts Notes controls, keeps per-photo drafts, scopes posts and closes cleanly',async()=>{
 const server=createServer(async(req,res)=>{
  if(req.url.startsWith('/libraries/gif-picker/giphy-sdk.js')){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(`export class GiphyFetch{async trending(){return {data:[{id:'layer-gif'}]};}search(){return this.trending();}}export function renderGrid(options,host){const b=document.createElement('button');b.textContent='Choose layer GIF';b.onclick=e=>options.onGifClick({id:'layer-gif',title:'Layer GIF',images:{fixed_width:{url:'https://media.giphy.com/media/test/giphy.gif',width:'200',height:'160'}}},e);host.append(b);return()=>host.replaceChildren();}`);return;}
  if(req.url.startsWith('/libraries/')){try{res.setHeader('Content-Type','text/javascript; charset=utf-8');const name=new URL(req.url,'http://fixture').pathname;const data=process.env.DEV_ASSETS?await (async()=>{const response=await fetch('https://dev.1m8.ai'+name+'?photo-check='+Date.now());assert.ok(response.ok);return Buffer.from(await response.arrayBuffer());})():await readFile(publicRoot+name);res.end(data);}catch{res.writeHead(404);res.end();}return;}
  if(req.url.startsWith('/v1/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial;--primary:#175cd3"></body></html>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1200,height:850}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'me'};window.posted=[];window.rows=new Map();window.failPost=false;
   window.Portal={util:{injectCSS:(id,css)=>{const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}}};
   const list=channel=>rows.get(channel)||[];
   window.PlatformAPI={media:{getMarkup:async()=>({layer:{data:{items:[]}}})}};
   window.FirstMatePickerWidgets={openGifPicker:(button,options)=>{window.pickGif=options.onSelect;},closeFor(){}};
   window.ChannelsAPI={directory:{list:async()=>({users:[],departments:[],selectable_department_ids:[],note_department_visibility:true})},channels:{ensureProject:()=>{throw Error('Photo comments must not open a project channel');},ensurePhoto:async(o,id)=>({channel:{id:'photo-'+id}})},messages:{list:async(o,c)=>({messages:list(c).filter(row=>!row.parent_id),channel:{separate_notes:false}}),noteAuthors:async()=>({authors:[]}),post:async(o,c,p)=>{if(failPost)throw Error('Save failed');posted.push({channel:c,...p});const row={...p,id:'comment-'+posted.length,seq:posted.length,author:{id:'me',name:'Photographer'},created_at:new Date().toISOString(),metadata:{...p.metadata,project_note:true},can_edit:true,can_delete:true};rows.set(c,[...list(c),row]);return {message:row};},thread:async(o,id)=>({replies:[...rows.values()].flat().filter(row=>row.parent_id===id)})},uploads:{send:async(o,file,c)=>({attachment:{id:'file1',media_id:'media-file',file_name:file.name,content_type:file.type}})},mediaFileUrl:()=>'/fixture.pdf'};
  });
  for(const url of ['/libraries/channels-ui/channels-ui.js','/libraries/project-notes/project-notes.js','/libraries/markup/firstmate-markup.js'])await page.addScriptTag({url});
  await page.evaluate(()=>{window.viewer=FirstMateMarkup.openPhotoViewer({photos:[{media_id:'a',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6b0AAAAASUVORK5CYII=',label:'A'},{media_id:'b',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6b0AAAAASUVORK5CYII=',label:'B'}],project:{id:'project',title:'Project'}});});
  await page.evaluate(()=>viewer.commentWorkspaces.get('a').handle.ready);
  const editor=page.getByRole('textbox',{name:'New photo comment',exact:true});
  assert.equal(await page.locator('[data-photo-comment-input]').count(),0);
  assert.deepEqual(await page.locator('.pn-composer .fm-ch-formatbar > button').evaluateAll(nodes=>nodes.map(node=>node.title)),['Bold','Italic','Strikethrough','Bulleted list','Numbered list','Quote']);
  assert.deepEqual(await page.locator('.pn-compose-actions > button').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),['Insert emoji','Attach a GIF','Attach a file','Dictate message','Record an audio comment']);
  await editor.fill('Draft A');await page.evaluate(()=>viewer.show(1));await page.evaluate(()=>viewer.commentWorkspaces.get('b').handle.ready);assert.equal(await editor.evaluate(node=>node.value),'');await editor.fill('Draft B');await page.evaluate(()=>viewer.show(0));assert.equal(await editor.evaluate(node=>node.value),'Draft A');
  await editor.fill('First comment');await editor.press('Shift+Enter');await editor.press('A');assert.equal(await page.evaluate(()=>posted.length),0);await editor.press('Enter');await page.waitForFunction(()=>posted.length===1);assert.equal(await page.evaluate(()=>posted[0].channel),'photo-a');assert.equal(await editor.evaluate(node=>node.value),'');assert.equal(await page.locator('.pn-card').count(),1);
  await page.evaluate(()=>window.failPost=true);await editor.fill('Keep on failure');await editor.press('Enter');await page.getByRole('alert').filter({hasText:'Save failed'}).waitFor();assert.equal(await editor.evaluate(node=>node.value),'Keep on failure');await page.evaluate(()=>window.failPost=false);
  await page.evaluate(()=>viewer.show(1));assert.equal(await editor.evaluate(node=>node.value),'Draft B');assert.equal(await page.locator('.pn-card').count(),0);await editor.press('Enter');await page.waitForFunction(()=>posted.length===2);assert.equal(await page.evaluate(()=>posted[1].channel),'photo-b');
  await page.evaluate(()=>viewer.show(0));assert.equal(await editor.evaluate(node=>node.value),'Keep on failure');
  await page.evaluate(()=>{delete window.FirstMatePickerWidgets;ChannelsAPI.gifs={config:async()=>({enabled:true,sdk_key:'fixture'})};});
  await page.addScriptTag({url:'/libraries/platform-widgets/pickers.js'});
  async function chooseGif(trigger){
   await trigger.click();const pop=page.getByRole('dialog',{name:'Choose a GIF',exact:true}),choose=pop.getByRole('button',{name:'Choose layer GIF'});await choose.waitFor();
   assert.equal(await choose.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),true,'GIF picker must be clickable above the photo modal');
   await choose.click();await pop.waitFor({state:'detached'});
  }
  const mainGif=page.locator('.pn-composer').getByRole('button',{name:'Attach a GIF',exact:true});
  await chooseGif(mainGif);await page.locator('.pn-composer').getByRole('button',{name:'Remove GIF',exact:true}).click();
  // A browser top-layer photo modal cannot be overtaken by CSS z-index alone.
  await page.evaluate(()=>{viewer.el.popover='manual';viewer.el.style.margin='0';viewer.el.showPopover();});
  await chooseGif(mainGif);assert.equal(await page.locator('.pn-composer .fm-ch-gif-draft').count(),1);await page.locator('.pn-composer').getByRole('button',{name:'Remove GIF',exact:true}).click();
  await page.locator('.pn-card [data-act=replies]').click();const reply=page.locator('.pn-reply-compose');await chooseGif(reply.getByRole('button',{name:'Attach a GIF',exact:true}));assert.equal(await reply.locator('.fm-ch-gif-draft').count(),1);await reply.getByRole('button',{name:'Close reply composer',exact:true}).click();
  await mainGif.click();await page.getByRole('dialog',{name:'Choose a GIF',exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Choose a GIF',exact:true}).waitFor({state:'detached'});assert.equal(await page.locator('.fm-photo-modal').count(),1);
  await page.evaluate(()=>{viewer.el.hidePopover();window.pickerDialog=document.createElement('dialog');document.body.append(pickerDialog);pickerDialog.append(viewer.el);pickerDialog.showModal();});
  await chooseGif(mainGif);await page.locator('.pn-composer').getByRole('button',{name:'Remove GIF',exact:true}).click();
  await page.evaluate(()=>{pickerDialog.close();document.body.append(viewer.el);pickerDialog.remove();});
  await page.route('https://media.giphy.com/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="112"><rect width="200" height="112" fill="#5c6983"/><text x="80" y="62" fill="white">GIF</text></svg>'}));
  await page.evaluate(async()=>{const gif={id:'spacing',url:'https://media.giphy.com/media/spacing/giphy.gif',title:'Spacing fixture',width:200,height:112};rows.get('photo-a').push({id:'gif-only',text:'',seq:999,created_at:new Date().toISOString(),author:{id:'me',name:'Photographer'},metadata:{project_note:true,giphy:gif},can_edit:true,can_delete:true});await viewer.commentWorkspaces.get('a').handle.refresh();});
  const gifCard=page.locator('.pn-card[data-project-note-id="gif-only"]');await gifCard.locator('img[alt="Spacing fixture"]').waitFor();
  const gaps=await gifCard.evaluate(card=>{const header=card.querySelector('header').getBoundingClientRect(),image=card.querySelector('.fm-ch-gif img').getBoundingClientRect(),caption=card.querySelector('figcaption').getBoundingClientRect(),footer=card.querySelector('footer').getBoundingClientRect();return {before:image.top-header.bottom,caption:caption.top-image.bottom,after:footer.top-caption.bottom,elements:[...card.querySelector('.pn-card-content').children].map(node=>node.tagName)};});
  assert.deepEqual(gaps.elements,['FIGURE']);assert.ok(gaps.before<=8,JSON.stringify(gaps));assert.ok(gaps.caption<=2,JSON.stringify(gaps));assert.ok(gaps.after<=8,JSON.stringify(gaps));
  await page.setViewportSize({width:650,height:750});assert.equal(await page.locator('[data-photo-comments]').evaluate(host=>host.scrollWidth<=host.clientWidth+2),true);
  await mkdir(publicRoot+'../output/photo-comments',{recursive:true});await page.screenshot({path:publicRoot+'../output/photo-comments/viewer.png'});
  await page.evaluate(()=>viewer.close());assert.equal(await page.locator('.fm-photo-modal').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
