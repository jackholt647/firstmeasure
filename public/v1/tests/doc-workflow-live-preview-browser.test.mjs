import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

// GP-168: the workflow's live preview follows typing. A host that can draw typed answers in the browser
// (preview.local) has them on the page at once, before the server's resolve; the server's resolve still follows and is
// what stays. A redraw puts the pictures it already loaded back instead of fetching them again, and a media popup chip
// asks for a picture that exists (thumb_320; "thumb" is no stored rendition).
async function open(page,{local=true}={}){
 await page.route('http://preview.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
  if(pathname.startsWith("/media/"))return route.fulfill({contentType:"image/png",body:png});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><style>body{margin:0;font-family:Arial}#host{height:760px;width:1300px}</style><div id="host"></div>'});
 });
 const fetched=[];page.on('request',r=>{if(r.url().includes('/media/'))fetched.push(new URL(r.url()).pathname);});
 await page.goto('http://preview.test/');
 for(const file of ['doc-model/firstmate-doc-model.js','doc-widgets/firstmate-doc-widgets.js','doc-renderer/firstmate-doc-renderer.js','doc-workflow/firstmate-doc-workflow.js'])await page.addScriptTag({url:'/libraries/'+file});
 await page.evaluate(({local})=>{
  window.resolves=0;window.locals=0;window.answer='';
  // The document: a heading bound to the answer, and a picture.
  const page=(words)=>{const doc=FMDocModel.createDocument({kind:'document'});
   const text={...FMDocModel.createNode('text'),id:'nd_answer',frame:{x:40,y:40,w:400,h:40},props:{blocks:[{id:'b',type:'paragraph',runs:[{text:words||'(empty)'}]}]}};
   const image={...FMDocModel.createNode('image'),id:'nd_photo',frame:{x:40,y:120,w:200,h:150},props:{media:{media_id:'m1',url:'/media/m1/original'},fit:'cover'}};
   doc.pages[0].children=[text,image];doc.computed_values={total:100};return doc;};
  const workflow={schema_version:1,steps:[{id:'one',title:'About',audience:['internal'],items:[{kind:'text',writes:'params.about',label:'About this project'}]}]};
  window.handle=FMDocWorkflow.mount(document.querySelector('#host'),{workflow,audience:'internal',contract:{},
   state:{params:{about:''},outputs:{}},
   onWrite:(path,value)=>{if(path==='params.about')window.answer=value;},
   preview:{
    // The server: answers after a while with what it was sent.
    resolve:async()=>{const words=window.answer;resolves+=1;await new Promise(r=>setTimeout(r,600));return {resolved_definition:page(words),widget_data:{},theme:null,theme_vars:{}};},
    ...(local?{local:()=>{locals+=1;return {resolved_definition:page(window.answer),widget_data:{},theme:null,theme_vars:{}};}}:{})
   },
   services:{}});
 },{local});
 await page.waitForFunction(()=>document.querySelector('[data-fmdw-preview-stage] img')?.complete);
 return fetched;
}
const shown=page=>page.evaluate(()=>document.querySelector('[data-fmdw-preview-stage] [data-node-id="nd_answer"]')?.textContent.trim());

test('typed words are on the preview at once and the server resolve follows; the loaded picture stays',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1400,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await open(page);
  await page.waitForFunction(()=>resolves>0);
  await page.waitForFunction(()=>document.querySelector('[data-fmdw-preview-stage] [data-node-id="nd_answer"]'));
  await page.evaluate(()=>{const img=document.querySelector('[data-fmdw-preview-stage] img');img.__first=true;
   // Every frame: is the picture on the page loaded?
   const look=()=>{const shown=document.querySelector('[data-fmdw-preview-stage] img');if(shown&&!(shown.complete&&shown.naturalWidth)){window.__blank=(window.__blank||0)+1;(window.__blanks=window.__blanks||[]).push([Math.round(performance.now()),locals,resolves,shown.__first===true,shown.complete,shown.naturalWidth]);}requestAnimationFrame(look);};requestAnimationFrame(look);});
  const field=page.locator('[data-fmdw-control]').first();
  await field.click();await field.type('New roof');
  const resolvesBefore=await page.evaluate(()=>resolves);
  // Written as it is typed, and drawn from the local preview well before a server resolve could answer (600 ms).
  await page.waitForFunction(()=>document.querySelector('[data-fmdw-preview-stage] [data-node-id="nd_answer"]')?.textContent.includes('New roof'),null,{timeout:450});
  assert.ok(await page.evaluate(()=>locals)>0);
  // The server's resolve still runs, and its page stays.
  await page.waitForFunction(n=>resolves>n,resolvesBefore,{timeout:3000});
  await page.waitForTimeout(900);
  assert.match(await shown(page),/New roof/);
  // The picture on the page is the one loaded first, not fetched again.
  assert.equal(await page.evaluate(()=>document.querySelector('[data-fmdw-preview-stage] img').__first===true),true,'the loaded picture is put back');
  // And it never showed an empty picture between draws.
  assert.equal(await page.evaluate(()=>window.__blank||0),0,'a picture not yet loaded was on the page: '+JSON.stringify(await page.evaluate(()=>window.__blanks)));
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('without a local preview the page waits for the server, as before',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  await open(page,{local:false});
  const field=page.locator('[data-fmdw-control]').first();
  await field.click();await field.type('Gutters');
  await page.waitForTimeout(350);
  assert.doesNotMatch(await shown(page)||'',/Gutters/);
  await page.waitForFunction(()=>document.querySelector('[data-fmdw-preview-stage] [data-node-id="nd_answer"]')?.textContent.includes('Gutters'),null,{timeout:4000});
 }finally{await browser.close();}
});

test('a media popup chip asks for the 320 px thumbnail, a picture that exists',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage();
  await page.goto('about:blank');
  for(const file of ['doc-model/firstmate-doc-model.js','doc-widgets/firstmate-doc-widgets.js','doc-renderer/firstmate-doc-renderer.js'])await page.addScriptTag({content:await readFile(new URL(file,libraries),'utf8')});
  const asked=await page.evaluate(async()=>{
   const asked=[];const doc=FMDocModel.createDocument({kind:'document'});
   doc.pages[0].children=[{...FMDocModel.createNode('widget'),id:'nd_popup',frame:{x:20,y:20,w:96,h:84},props:{widget:'doc.media_popup@1',config:{media:{media_id:'m1'},caption:'Ridge'}}}];
   const host=document.createElement('div');document.body.append(host);
   const handle=FMDocRenderer.render(host,{document:doc,mode:'static',mediaUrl:(media,variant)=>{asked.push(variant);return '/media/'+media.media_id+'/'+variant;}});
   await handle.ready?.();
   return {asked,src:host.querySelector('.fmdoc-media-popup img')?.getAttribute('src')||''};
  });
  assert.ok(asked.src.endsWith('/thumb_320'),'chip picture: '+asked.src+' asked '+asked.asked.join(','));
  assert.ok(!asked.asked.includes('thumb'));
 }finally{await browser.close();}
});
