import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const libraries=new URL('../../libraries/',import.meta.url),output=new URL('../../../output/picker-widgets-20261007/',import.meta.url);
const shot=name=>new URL(name,output).pathname.replace(/^\/(\w:)/,'$1');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
async function open(browser){
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://pickers.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
  if(pathname.startsWith('/libraries/'))return route.fulfill({contentType:pathname.endsWith('.json')?'application/json':'application/javascript; charset=utf-8',body:await readFile(new URL(pathname.slice('/libraries/'.length),libraries))});
  if(pathname.startsWith('/media/'))return route.fulfill({contentType:'image/png',body:png});
  return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><style>body{margin:16px;font-family:Arial;--primary:#d93025}.host{width:520px;margin-bottom:16px}</style><div id="a" class="host"></div><div id="b" class="host"></div><div id="c" class="host"></div><div id="d" class="host"></div>'});
 });
 await page.goto('http://pickers.test/');
 await page.evaluate(()=>{
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.__APP={userOrgId:'org'};
  window.Portal={cfg:window.__APP,modules:{},util:{escapeHtml,injectCSS(id,css){let el=document.getElementById('css_'+id);if(!el){el=document.createElement('style');el.id='css_'+id;document.head.append(el);}el.textContent=css;}},ui:{showToast(){}}};
  window.PlatformAPI={media:{fileUrl:(org,id,variant)=>'/media/'+id+'/'+variant,thumbnailUrl:(org,id)=>'/media/'+id+'/thumb'}};
 });
 for(const file of ['platform-widgets/runtime.js','apps/photos/feed.js','date-time-picker/date-time-picker.js','color-picker/firstmate-color-picker.js','platform-widgets/picker-widgets.js'])await page.addScriptTag({url:'/libraries/'+file});
 await page.evaluate(async()=>{
  await FirstMateWidgets.ready;window.picks=[];window.events=[];window.reads=[];
  document.addEventListener('fm:widget-selection',event=>events.push(event.detail));
  const media=[{id:'m1',content_type:'image/png',file_name:'front.png',label:'Front',created_at:'2026-10-03',project_id:'p'},{id:'m2',content_type:'image/png',file_name:'rear.png',label:'Rear',created_at:'2026-10-02',project_id:'p'},{id:'m3',content_type:'image/png',file_name:'gutter.png',label:'Gutter',created_at:'2026-10-01',project_id:'p'},{id:'v1',content_type:'video/mp4',file_name:'walk.mp4',label:'Walkthrough',created_at:'2026-09-30',project_id:'p'}];
  window.context={surface:'project',target:{scope:'project',organizationId:'org',projectId:'p'},onSelect:(value,detail)=>picks.push({value,confirmed:detail.confirmed,label:detail.label,id:detail.widget.id}),
   read:async(source,target)=>{reads.push({export:source.export,args:source.args||null,scope:target.scope});
    if(source.export==='library')return {status:'ready',value:{items:media.filter(item=>source.args?.kind==='image_video'||item.content_type.startsWith('image/')),truncated:false}};
    if(source.export==='directory')return {status:'ready',value:{results:[{id:'p1',title:'Maple Street roof',subtitle:'12 Maple St'},{id:'p2',title:'Oak Avenue siding',subtitle:'9 Oak Ave'}].filter(row=>row.title.toLowerCase().includes(String(source.args?.query||'').toLowerCase()))}};
    return {status:'missing',message:'Unknown source'};}};
 });
 return {page,errors};
}
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('media.picker shares the Photos picker, reports a bounded selection and the modal API still works',async()=>{
 const browser=await launch();try{
  const {page,errors}=await open(browser);await mkdir(output,{recursive:true});
  await page.evaluate(async()=>{window.photos=FirstMateWidgets.mount(document.querySelector('#a'),{id:'media.picker',version:'1',config:{prompt:'Which photos go in the proposal?'}},context);await photos.ready;});
  assert.equal(await page.locator('#a .pf-picker-shell.pf-picker-inline').count(),1);assert.equal(await page.locator('#a [data-picker-media-id]').count(),3,'images only by default');
  assert.equal(await page.locator('#a').getByText('Which photos go in the proposal?',{exact:true}).count(),1);assert.equal(await page.locator('#a [data-picker-close], #a [data-picker-upload]').count(),0,'inline mounts have no dialog chrome or upload without a host handler');
  assert.equal(await page.evaluate(()=>photos.selection()),null);assert.equal(await page.evaluate(()=>'selection' in FirstMateWidgets.visibleInstances()[0]),false);
  await page.locator('#a [data-picker-media-id="m2"]').click();await page.locator('#a [data-picker-media-id="m1"]').click();
  assert.deepEqual(await page.evaluate(()=>photos.selection()),{media_ids:['m2','m1']});
  assert.deepEqual(await page.evaluate(()=>picks.at(-1)),{value:{media_ids:['m2','m1']},confirmed:false,label:'2 photos',id:'media.picker'});
  let visible=await page.evaluate(()=>FirstMateWidgets.visibleInstances()[0]);assert.deepEqual(visible.selection,{media_ids:['m2','m1']});assert.equal(visible.selection_confirmed,false);assert.equal(visible.widget.id,'media.picker');
  await page.locator('#a [data-picker-confirm]').click();
  assert.equal(await page.evaluate(()=>picks.at(-1).confirmed),true);assert.equal(await page.evaluate(()=>events.at(-1).confirmed&&events.at(-1).surface==='project'&&events.at(-1).title==='Media picker'),true);
  assert.equal(await page.evaluate(()=>FirstMateWidgets.visibleInstances()[0].selection_confirmed),true);assert.equal(await page.locator('#a [data-picker-confirm]').isDisabled(),true);
  await page.locator('#a [data-picker-media-id="m3"]').click();assert.equal(await page.evaluate(()=>FirstMateWidgets.visibleInstances()[0].selection_confirmed),false,'changing the selection withdraws the confirmation');
  assert.deepEqual(await page.evaluate(()=>photos.serialize().state),{media_ids:['m2','m1','m3']});
  await page.screenshot({path:shot('media-picker.png')});
  // Single choice with videos: the renderer repeats the read with arguments and caps the selection at one.
  await page.evaluate(async()=>{window.single=FirstMateWidgets.mount(document.querySelector('#b'),{id:'media.picker',version:'1',config:{multiple:false,kind:'image_video'}},context);await single.ready;});
  assert.equal(await page.locator('#b [data-picker-media-id]').count(),4);assert.deepEqual(await page.evaluate(()=>reads.at(-1)),{export:'library',args:{kind:'image_video'},scope:'project'});
  await page.locator('#b [data-picker-media-id="m1"]').click();await page.locator('#b [data-picker-media-id="v1"]').click();assert.deepEqual(await page.evaluate(()=>single.selection()),{media_ids:['v1']});
  // Host-supplied photos need no read; destroying an instance removes it from the screen inventory.
  await page.evaluate(async()=>{single.destroy();reads.length=0;window.hosted=FirstMateWidgets.mount(document.querySelector('#b'),{id:'media.picker',version:'1'},{...context,data:{'media.picker':{items:[{id:'x1',media_id:'x1',label:'Host photo'}]}}});await hosted.ready;});
  assert.equal(await page.locator('#b [data-picker-media-id="x1"]').count(),1);assert.equal(await page.evaluate(()=>reads.length),0);assert.equal(await page.evaluate(()=>FirstMateWidgets.visibleInstances().length),2);
  // The existing modal keeps its contract on the shared implementation.
  await page.evaluate(()=>{window.modal={};modal.handle=Portal.PhotoFeed.openProjectMediaPicker({photos:[{id:'a1',media_id:'a1',label:'One'},{id:'a2',media_id:'a2',label:'Two'}],multiple:true,onConfirm:(chosen,ids)=>{modal.chosen=chosen.map(photo=>photo.id);modal.ids=ids;},onClose:()=>{modal.closed=(modal.closed||0)+1;}});});
  assert.equal(await page.locator('.pf-picker-modal .pf-picker-shell[role=dialog][aria-modal=true]').count(),1);assert.equal(await page.locator('.pf-picker-modal [data-picker-close]').count(),1);assert.equal(await page.locator('.pf-picker-modal [data-picker-upload]').count(),1);
  await page.locator('.pf-picker-modal [data-picker-media-id="a2"]').click();await page.locator('.pf-picker-modal [data-picker-confirm]').click();
  assert.deepEqual(await page.evaluate(()=>[modal.chosen,modal.ids,modal.closed]),[['a2'],['a2'],1]);assert.equal(await page.locator('.pf-picker-modal').count(),0);
  await page.evaluate(()=>{modal.closed=0;modal.handle=Portal.PhotoFeed.openProjectMediaPicker({photos:[],onClose:()=>{modal.closed++;}});modal.handle.refresh([{id:'a3',media_id:'a3',label:'Three'}]);});
  assert.equal(await page.locator('.pf-picker-modal [data-picker-media-id="a3"]').count(),1);await page.locator('.pf-picker-modal [data-picker-close]').click();assert.equal(await page.locator('.pf-picker-modal').count(),0);assert.equal(await page.evaluate(()=>modal.closed),1);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('date, color and project pickers report typed selections; the cap and the opt-in are enforced by the runtime',async()=>{
 const browser=await launch();try{
  const {page,errors}=await open(browser);await mkdir(output,{recursive:true});
  await page.evaluate(async()=>{window.day=FirstMateWidgets.mount(document.querySelector('#a'),{id:'datetime.picker',version:'1',config:{mode:'date',prompt:'When should the crew start?',value:'2026-10-07'}},{...context,surface:'assistant'});await day.ready;});
  assert.equal(await page.locator('#a fm-date-time-picker').count(),1,'the shared calendar is mounted inline');
  await page.locator('#a fm-date-time-picker button[data-date="2026-10-15"]').click();
  const zone=await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(await page.evaluate(()=>day.selection()),{mode:'date',value:'2026-10-15',timezone:zone});assert.equal(await page.evaluate(()=>picks.at(-1).confirmed),false);
  await page.locator('#a .fpw-confirm').click();assert.deepEqual(await page.evaluate(()=>({confirmed:events.at(-1).confirmed,surface:events.at(-1).surface,selection:events.at(-1).selection.value})),{confirmed:true,surface:'assistant',selection:'2026-10-15'});
  assert.equal(await page.locator('#a .fpw-confirm').innerText(),'Selected');
  await page.evaluate(async()=>{window.range=FirstMateWidgets.mount(document.querySelector('#b'),{id:'datetime.picker',version:'1',config:{mode:'date_range'}},context);await range.ready;});
  assert.equal(await page.evaluate(()=>range.selection()),null);
  await page.evaluate(()=>{for(const [name,value] of [['start','2026-10-12'],['end','2026-10-16']]){const el=document.querySelector(`#b [data-field="${name}"]`);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));}});
  assert.deepEqual(await page.evaluate(()=>range.selection()),{mode:'date_range',start:'2026-10-12',end:'2026-10-16',timezone:zone});
  await page.evaluate(()=>{const el=document.querySelector('#b [data-field="end"]');el.value='2026-10-01';el.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await page.evaluate(()=>range.selection()),null,'an end before the start is not an answer');
  await page.evaluate(async()=>{window.time=FirstMateWidgets.mount(document.querySelector('#b'),{id:'datetime.picker',version:'1',config:{mode:'datetime',value:'2026-10-07T09:30'}},context);await time.ready;});
  assert.deepEqual(await page.evaluate(()=>time.selection()),{mode:'datetime',value:'2026-10-07T09:30',timezone:zone});
  await page.evaluate(async()=>{window.color=FirstMateWidgets.mount(document.querySelector('#c'),{id:'color.picker',version:'1',config:{prompt:'Accent color?'}},context);await color.ready;});
  assert.equal(await page.evaluate(()=>color.selection()),null,'an untouched color is not an answer');
  await page.locator('#c input[type=color]').click();assert.equal(await page.locator('.fm-color-picker').count(),1,'the shared color popover opens');
  await page.evaluate(()=>{FirstMateColorPicker.close();const el=document.querySelector('#c input[type=color]');el.value='#AA33CC';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.deepEqual(await page.evaluate(()=>color.selection()),{color:'#aa33cc'});
  await page.evaluate(async()=>{window.project=FirstMateWidgets.mount(document.querySelector('#d'),{id:'project.picker',version:'1',target:{scope:'organization',organizationId:'org'},config:{prompt:'Which project?'}},context);await project.ready;});
  await page.locator('#d input[role=combobox]').fill('oak');await page.waitForFunction(()=>reads.some(read=>read.args?.query==='oak')&&document.querySelectorAll('#d [role=option]').length===2);await page.locator('#d [role=option]',{hasText:'Oak Avenue siding'}).click();
  assert.deepEqual(await page.evaluate(()=>project.selection()),{project_id:'p2'});assert.deepEqual(await page.evaluate(()=>reads.find(read=>read.args?.query==='oak')),{export:'directory',args:{query:'oak',limit:12},scope:'organization'});
  assert.equal(await page.evaluate(()=>picks.at(-1).label),'Oak Avenue siding');
  await page.screenshot({path:shot('pickers.png'),fullPage:true});
  const inventory=await page.evaluate(()=>FirstMateWidgets.visibleInstances().map(entry=>[entry.widget.id,entry.selection||null]));
  assert.deepEqual(inventory,[['datetime.picker',{mode:'date',value:'2026-10-15',timezone:zone}],['datetime.picker',{mode:'datetime',value:'2026-10-07T09:30',timezone:zone}],['color.picker',{color:'#aa33cc'}],['project.picker',{project_id:'p2'}]]);
  // Runtime contract: selection is opt-in, bounded and plain.
  const contract=await page.evaluate(async()=>{
   for(const el of document.querySelectorAll('.host'))el.replaceChildren();[day,time,color,project].forEach(handle=>handle.destroy());
   const sizing={mode:'content',minWidth:100,minHeight:0},base={version:'1',title:'Test',description:'Test',app:'test',surfaces:['project'],configSchema:{type:'object',properties:{},additionalProperties:false},sources:[]};
   let api;const render=(root,options)=>{api=options;root.textContent='ready';return {};};
   FirstMateWidgets.register({...base,id:'test.picker',sizing,selection:{description:'Test answer',schema:{type:'object',properties:{},additionalProperties:true}}},render);
   FirstMateWidgets.register({...base,id:'test.plain',sizing},render);
   let invalid='';try{FirstMateWidgets.register({...base,id:'test.bad',sizing,selection:{schema:{type:'array'}}},render);}catch(error){invalid=error.message;}
   const seen=[],picker=FirstMateWidgets.mount(document.querySelector('#a'),{id:'test.picker',version:'1'},{surface:'project',onSelect:value=>seen.push(value)});await picker.ready;const notify=api.notifySelection;
   const results={invalid,limit:FirstMateWidgets.selectionMaxBytes,ok:notify({ids:['a','b'],when:'2026-10-07',count:2,flag:true}),value:picker.selection(),
    big:notify({ids:Array.from({length:90},()=>'x'.repeat(60))}),html:notify({note:'<b>bold</b>'}),bytes:notify({file:'data:image/png;base64,AAAA'}),deep:notify({a:{b:{c:{d:1}}}}),array:notify(['a']),text:notify('a'),long:notify({id:'x'.repeat(513)}),many:notify({ids:Array.from({length:101},()=>'a')}),fn:notify({run(){}}),
    kept:picker.selection(),delivered:seen.length,cleared:notify(null),after:picker.selection()};
   const plain=FirstMateWidgets.mount(document.querySelector('#b'),{id:'test.plain',version:'1'},{surface:'project',onSelect:value=>seen.push(value)});await plain.ready;
   results.plain=api.notifySelection({ids:['a']});results.plainValue=plain.selection();results.plainDelivered=seen.length;results.inventory=FirstMateWidgets.visibleInstances().map(entry=>Object.keys(entry).filter(key=>key.startsWith('selection')));
   return results;
  });
  assert.match(contract.invalid,/selection needs a description and an object schema/);assert.equal(contract.limit,4096);assert.equal(contract.ok,true);assert.deepEqual(contract.value,{ids:['a','b'],when:'2026-10-07',count:2,flag:true});
  for(const name of ['big','html','bytes','deep','array','text','long','many','fn'])assert.equal(contract[name],false,name+' must be rejected');
  assert.deepEqual(contract.kept,contract.value,'a rejected value never replaces the last valid selection');assert.equal(contract.delivered,1);assert.equal(contract.cleared,true);assert.equal(contract.after,null);
  assert.equal(contract.plain,false);assert.equal(contract.plainValue,null);assert.equal(contract.plainDelivered,2,'only the clear was delivered after the first value');assert.deepEqual(contract.inventory,[[],[]]);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
