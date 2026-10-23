import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// The estimate workflow's "Photos & description" step: content blocks whose
// photo comes from the shared media library and whose body is written in the
// shared rich text editor. Library records arrive as GET /media returns them:
// the media id is `id`, with no media_id or URL.
async function openWorkflow(page,{failUpload=false,modal=false}={}){
 await page.route('http://workflow.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
  if(pathname.startsWith('/media/'))return route.fulfill({contentType:'image/png',body:png});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><style>body{margin:0;font-family:Arial}#host{height:760px}</style><div id="host"></div>'});
 });
 await page.goto('http://workflow.test/');
 await page.evaluate(()=>{
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.__APP={userOrgId:'org'};
  window.Portal={cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(id,css){let el=document.getElementById('css_'+id);if(!el){el=document.createElement('style');el.id='css_'+id;document.head.append(el);}el.textContent=css;}},ui:{showToast(){}}};
  window.PlatformAPI={media:{fileUrl:(org,id,variant)=>'/media/'+id+'/'+variant,thumbnailUrl:(org,id,size)=>'/media/'+id+'/thumb_'+size}};
 });
 for(const file of ['platform-widgets/runtime.js','apps/photos/feed.js','platform-widgets/picker-widgets.js','platform-widgets/gifs.js','channels-ui/channels-ui.js','doc-markdown/firstmate-markdown.js','doc-model/firstmate-doc-model.js','doc-renderer/firstmate-doc-renderer.js','doc-workflow/firstmate-doc-workflow.js'])await page.addScriptTag({url:'/libraries/'+file});
 await page.evaluate(async({failUpload,modal})=>{
  await FirstMateWidgets.ready;window.writes=[];
  const records=[{id:'m1',content_type:'image/png',file_name:'front.png',variants:{original:{content_type:'image/png'}}},{id:'m2',content_type:'image/png',file_name:'rear.png',variants:{original:{content_type:'image/png'},thumb_320:{}}}];
  // What the documents app's media bridge hands the attach popover.
  const mount=(host,options)=>FirstMateWidgets.mount(host,{id:'media.picker',version:'1',config:{multiple:false,kind:'image_video',prompt:'Choose a photo'}},{surface:'project',target:{scope:'project',organizationId:'org',projectId:'p'},data:{'media.picker':{items:records}},
   onUpload:async files=>{if(failUpload)throw Error('Storage is full for this organization.');const added=[...files].map((file,i)=>({id:'up'+i,content_type:'image/png',file_name:file.name,variants:{original:{content_type:'image/png'}}}));records.unshift(...added);return {photos:added,selectedIds:added.map(item=>item.id)};},
   onSelect:(value,detail)=>{if(detail.confirmed&&value?.media_ids?.[0])options.onPick({media_id:value.media_ids[0]});}});
  // Where the library cannot be mounted inline, pick() opens it as its own window.
  const pick=()=>new Promise(resolve=>Portal.PhotoFeed.openProjectMediaPicker({id:'test-picker',photos:records,multiple:false,imageOnly:false,
   onConfirm:chosen=>{const item=chosen[0]||{};resolve({media_id:item.media_id||item.id});return true;},onClose:()=>resolve(null)}));
  const workflow={schema_version:1,name:'Proposal',contract:{params:{content_blocks:{type:'list'}}},steps:[{id:'details',title:'Photos & description',audience:['internal'],items:[{kind:'content_blocks',writes:'params.content_blocks',label:'Photos & description'}]}]};
  window.handle=FMDocWorkflow.mount(document.querySelector('#host'),{workflow,audience:'internal',contract:workflow.contract,
   state:{params:{content_blocks:[{id:'cb1',title:'Your roof',body:'An older plain description\nwith a second line.'}]},outputs:{}},
   onWrite:(path,value)=>writes.push({path,value:JSON.parse(JSON.stringify(value))}),
   services:{api:{signing:{organizationId:'org'}},media:modal?{url:id=>'/media/'+id+'/thumb_320',pick}:{url:id=>'/media/'+id+'/thumb_320',mount}}});
 },{failUpload,modal});
 await page.waitForSelector('[data-fmdw-cb="cb1"]');
}
const lastBlocks=page=>page.evaluate(()=>writes.filter(w=>w.path==='params.content_blocks').at(-1)?.value||null);

test('a content block picks a library photo, shows its thumbnail and assigns it',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openWorkflow(page);
  await page.click('[data-fmdw-cb-media]');
  await page.click('.fmdw-attach-thumb');
  await page.waitForSelector('.fmdw-attach-pop.library .fm-widget img');
  const sources=await page.$$eval('.fmdw-attach-pop.library .fm-widget img',imgs=>imgs.map(img=>img.getAttribute('src')));
  assert.ok(sources.some(src=>src.includes('/media/m1/'))&&sources.some(src=>src.includes('/media/m2/')),'library tiles load from their media ids: '+sources.join(', '));
  await page.locator('.fmdw-attach-pop.library .fm-widget img').first().click();
  await page.locator('.fmdw-attach-pop.library .fm-widget button:not([disabled])',{hasText:/select/i}).last().click();
  await page.waitForFunction(()=>!document.querySelector('.fmdw-attach-pop'));
  const blocks=await lastBlocks(page);
  assert.equal(blocks?.[0]?.media?.media_id,'m1','the block is assigned the picked photo');
  assert.match(await page.getAttribute('[data-fmdw-cb="cb1"] .fmdw-cb-thumb img','src'),/\/media\/m1\/thumb_320/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('the library opened as its own window shows thumbnails for library records and assigns the pick',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openWorkflow(page,{modal:true});
  await page.click('[data-fmdw-cb-media]');
  await page.click('.fmdw-attach-thumb');
  await page.waitForSelector('.pf-picker-modal [data-picker-media-id] img');
  const sources=await page.$$eval('.pf-picker-modal [data-picker-media-id] img',imgs=>imgs.map(img=>img.getAttribute('src')||''));
  assert.ok(sources.length===2&&sources.every(src=>/\/media\/m[12]\//.test(src)),'tiles load from their media ids: '+JSON.stringify(sources));
  await page.click('.pf-picker-modal [data-picker-media-id="m2"]');
  await page.click('.pf-picker-modal [data-picker-confirm]');
  await page.waitForFunction(()=>!document.querySelector('.fmdw-attach-pop')&&!document.querySelector('.pf-picker-modal'));
  assert.equal((await lastBlocks(page))?.[0]?.media?.media_id,'m2');
  assert.match(await page.getAttribute('[data-fmdw-cb="cb1"] .fmdw-cb-thumb img','src'),/\/media\/m2\/thumb_320/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('an upload in the workflow shows its thumbnail and assigns it; a failed upload says why',async()=>{
 const browser=await launch();try{
  let page=await browser.newPage({viewport:{width:1200,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openWorkflow(page);
  await page.click('[data-fmdw-cb-media]');
  await page.click('.fmdw-attach-thumb');
  await page.waitForSelector('.fmdw-attach-pop.library [data-picker-file]',{state:'attached'});
  await page.setInputFiles('.fmdw-attach-pop.library [data-picker-file]',{name:'porch.png',mimeType:'image/png',buffer:png});
  await page.waitForSelector('.fmdw-attach-pop.library [data-picker-media-id="up0"] img');
  assert.match(await page.getAttribute('.fmdw-attach-pop.library [data-picker-media-id="up0"] img','src'),/\/media\/up0\//);
  assert.equal(await page.getAttribute('.fmdw-attach-pop.library [data-picker-media-id="up0"]','aria-pressed'),'true','the upload is selected');
  await page.locator('.fmdw-attach-pop.library .fm-widget button:not([disabled])',{hasText:/select/i}).last().click();
  await page.waitForFunction(()=>!document.querySelector('.fmdw-attach-pop'));
  assert.equal((await lastBlocks(page))?.[0]?.media?.media_id,'up0');
  assert.deepEqual(errors,[]);
  await page.close();

  page=await browser.newPage({viewport:{width:1200,height:800}});page.on('pageerror',e=>errors.push(e.message));
  await openWorkflow(page,{failUpload:true});
  await page.click('[data-fmdw-cb-media]');
  await page.click('.fmdw-attach-thumb');
  await page.waitForSelector('.fmdw-attach-pop.library [data-picker-file]',{state:'attached'});
  await page.setInputFiles('.fmdw-attach-pop.library [data-picker-file]',{name:'porch.png',mimeType:'image/png',buffer:png});
  await page.waitForSelector('.fmdw-attach-pop.library .pf-picker-error');
  assert.match(await page.textContent('.fmdw-attach-pop.library .pf-picker-error'),/Storage is full/);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('the block body uses the shared rich text editor and renders as formatted text',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openWorkflow(page);
  const body='[data-fmdw-cb="cb1"] .fmdw-cb-rich';
  assert.match(await page.textContent(body+' .fm-ch-rich-editor'),/An older plain description/,'a plain description loads into the editor');
  const titles=await page.$$eval(body+' .fm-ch-formatbar button',buttons=>buttons.map(button=>button.title));
  for(const title of ['Bold','Italic','Bulleted list','Numbered list','Link','Table','Attach a GIF'])assert.ok(titles.includes(title),title+' in the toolbar: '+titles.join(', '));
  await page.click(body+' .fm-ch-rich-editor');
  await page.keyboard.press('Control+A');
  await page.click(body+' .fm-ch-formatbar button[title="Bold"]');
  await page.click('[data-fmdw-cb="cb1"] .fmdw-cb-title');
  await page.waitForFunction(()=>/\*\*/.test(writes.filter(w=>w.path==='params.content_blocks').at(-1)?.value?.[0]?.body||''));
  const written=(await lastBlocks(page))[0].body;
  assert.match(written,/^\*\*An older plain description/,'the body is saved as Markdown: '+written);
  // The document renders the Markdown as formatted text, tables included.
  const rendered=await page.evaluate(async()=>{
   const doc=FMDocModel.createDocument({kind:'document'});
   doc.pages[0].children=[{id:'col',type:'frame',anchor:'flow',frame:{x:40,y:40,w:500,h:'auto',layout:'flow'},props:{flow:{direction:'column',gap:4,padding:[0,0,0,0],align:'stretch',wrap:false}},children:[{id:'t',type:'text',anchor:'flow',frame:{x:0,y:0,w:0,h:'auto',layout:'flow'},props:{blocks:[{id:'b',type:'paragraph',runs:[{bind:"coalesce(params.body, '')",format:'markdown'}]}]}}]}];
   const resolved=FMDocModel.resolveBindings(doc,{params:{body:'**Strong** start\n- one\n- two\n\n| Item | Note |\n| --- | --- |\n| Gutters | _new_ |\n<!--fm-table-widths:120,160-->'}});
   const host=document.createElement('div');document.body.append(host);
   FMDocRenderer.render(host,{document:resolved,mode:'static'});
   await new Promise(r=>setTimeout(r,50));
   return {text:host.textContent,markers:[...host.querySelectorAll('[data-marker]')].map(el=>el.dataset.marker),bold:[...host.querySelectorAll('.fmdoc-run')].some(el=>el.textContent==='Strong'&&Number(el.style.fontWeight)>=700),cells:host.querySelectorAll('td,th,.fmdoc-table-cell,[data-cell]').length};
  });
  assert.ok(rendered.bold,'bold text renders bold');
  assert.deepEqual(rendered.markers,['•','•'],'bullets render as list items');
  assert.match(rendered.text,/Gutters/);
  assert.ok(!/fm-table-widths|\*\*|\| ---/.test(rendered.text),'no Markdown syntax reaches the page: '+rendered.text);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
