// Desktop Full Exterior: confirming the pins turns the map into one capture-and-order panel.
// Upload leads (footage comes from a phone), recording is secondary, and delivery, price and the
// order button share the same screen, which never scrolls at common desktop sizes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const source=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const instrumented=source.replace('  P.ExteriorOrder={','  P.test={files,getPage:()=>page};\n  P.ExteriorOrder={');
const shell=`<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;font:14px Arial}.r-win{display:flex;height:100vh}.r-overview-details{width:390px;flex:none;overflow:auto;border-right:1px solid #ddd;padding:12px}.r-preview-panel{flex:1;min-width:0;display:flex}.r-tab-main{position:relative;flex:1;min-width:0;overflow:hidden}.map{position:absolute;inset:0;background:linear-gradient(135deg,#7a9a6b,#5b7a8c)}.tray{width:380px;flex:none;border-left:1px solid #ddd;overflow:hidden}.tray[hidden]{display:none}</style></head><body>
<div id="rOverlay" class="r-overlay"><div class="r-win"><div class="r-overview-details"><form id="rForm"><div class="r-scroll"><section id="rStepCustomer"><div id="rStepType"><div id="rTypePill"></div></div></section><div class="r-group"><textarea id="rTechNotes"></textarea></div></div></form></div>
<div class="r-preview-panel" data-panel="map"><div class="r-tab-main"><div class="map"></div></div></div>
<aside class="tray"><div class="fm-project-tray-tabs"><button type="button" data-tray="notes" aria-selected="true">Notes</button></div><button type="button" class="fm-project-tray-close">Close</button></aside></div></div></body></html>`;

async function setup(t,{width=1600,height=1000,count=1,mobileOrder=false,fail=()=>false}={}){
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height}});
 const uploads=[];let release=null;
 await page.route('https://capture.test/**',async route=>{
  const request=route.request();
  if(request.method()==='GET')return route.fulfill({contentType:'text/html',body:shell});
  const body=request.postDataBuffer()||Buffer.alloc(0);const name=/filename="([^"]+)"/.exec(body.toString('latin1'))?.[1]||'';
  uploads.push(name);if(release)await release;
  if(fail(name,uploads.filter(n=>n===name).length))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:false,message:'That video could not be read.'})});
  return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,media_id:'media-'+uploads.length})});
 });
 await page.goto('https://capture.test/');
 await page.evaluate(({count,mobileOrder})=>{
  // The tray behaves like the platform's: closing it gives its width back to the map.
  const tray=document.querySelector('.tray'),tab=tray.querySelector('[data-tray]');
  tray.querySelector('.fm-project-tray-close').onclick=()=>{tab.setAttribute('aria-selected','false');tray.querySelector('.fm-project-tray-close').hidden=true;tray.style.width='0px';tray.style.borderLeft='0';};
  tab.onclick=()=>{tab.setAttribute('aria-selected','true');tray.querySelector('.fm-project-tray-close').hidden=false;tray.style.width='';tray.style.borderLeft='';};
  window.Portal={cfg:{serverEndpoint:'https://capture.test/upload'},capabilities:{value:key=>key==='firstmeasure.exteriors'},util:{escapeHtml:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]),injectCSS:(_,css)=>{const s=document.createElement('style');s.textContent=css;document.head.append(s);},
   postAction:async()=>({res:{status:200},data:{success:true,pricing_revision:4,estimated_wait_minutes:1080,busy_label:"We aren't very busy",base_price:25,options:[{key:'exteriors_standard',amount:25*count,unit_price:25,fee:0},{key:'exteriors_same_day',amount:30*count,fee:5},{key:'exteriors_priority',amount:35*count,fee:10}]}})}};
  window.PlatformCommerce={credit:n=>'$'+n};
  window.submitted=0;
  window.ctx={type:'residential',count,pins:Array.from({length:count},(_,i)=>({lat:39+i/1000,lng:-105})),ordered:false,orderWorkflow:true,mobileOrder,addressSelected:true,locationConfirmed:false,
   getAddress:()=>'3245 S Lowell Blvd',refresh:()=>window.Portal.ExteriorOrder.sync(window.ctx),setPinConfirmed:value=>{window.ctx.locationConfirmed=!!value;},submit:async()=>{window.submitted++;}};
 },{count,mobileOrder});
 await page.addScriptTag({content:instrumented});
 await page.evaluate(()=>{const order=Portal.ExteriorOrder;order.sync(ctx);order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_standard'});});
 await page.waitForFunction(()=>!!document.querySelector('#rExteriorOrder'));
 const confirm=async(value=true)=>page.evaluate(value=>{ctx.locationConfirmed=value;Portal.ExteriorOrder.sync(ctx);},value);
 // Wait for the panel's own motion; the walkaround illustration loops forever.
 const settle=()=>page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming?.().endTime)).map(a=>a.finished.catch(()=>{}))));
 return {page,uploads,confirm,settle,hold:()=>{let open;release=new Promise(r=>open=r);return ()=>{release=null;open();};}};
}

const layout=page=>page.evaluate(()=>{
 const desk=document.querySelector('.ext-desk'),box=el=>el?.getBoundingClientRect();
 const clipped=[...desk.querySelectorAll('.ext-desk-main,.ext-desk-main *,.ext-desk-foot,.ext-desk-foot *,.ext-desk-head *')].filter(el=>el.offsetParent&&el.scrollHeight>el.clientHeight+2&&getComputedStyle(el).overflowY!=='visible'&&!el.closest('.ext-orbit,.ext-model-scene,.ext-desk-house,.ext-desk-cell,.ext-camera,.ext-capture-heading')&&!el.matches('select,.ext-desk-sr')).map(el=>el.className);
 return {desk:box(desk),host:box(desk.parentElement),foot:box(desk.querySelector('.ext-desk-foot')),order:box(desk.querySelector('.ext-desk-order')),pageScrolls:document.scrollingElement.scrollHeight>innerHeight+1||document.scrollingElement.scrollWidth>innerWidth+1,clipped,innerHeight};
});

for(const [width,height] of [[1600,1000],[1280,800]])test(`confirming the pins turns the map into the capture panel without scrolling at ${width}x${height}`,async t=>{
 const {page,confirm,settle}=await setup(t,{width,height});
 assert.equal(await page.locator('.ext-desk').count(),0,'the map stays until the pins are confirmed');
 assert.equal(await page.locator('#rExteriorOrder .ext-delivery-heading, #rExteriorOrder .ext-nav, #rExteriorOrder .ext-progress').count(),0,'delivery, price and paging leave the left column');
 await confirm();
 await page.waitForSelector('.ext-desk');
 assert.ok(await page.evaluate(()=>document.getAnimations().some(a=>a.effect?.target?.classList?.contains('ext-desk'))),'the panel sweeps in rather than appearing');
 assert.equal(await page.locator('.fm-project-tray-tabs [data-tray]').getAttribute('aria-selected'),'false','an open side tray makes room for the panel');
 await settle();
 const box=await layout(page);
 assert.ok(box.desk.width>=box.host.width-1&&box.desk.width>800,JSON.stringify(box));
 assert.equal(box.pageScrolls,false);assert.deepEqual(box.clipped,[],'no section of the panel is cut off or scrolls');
 assert.ok(box.foot.bottom<=box.innerHeight+1&&box.order.bottom<=box.innerHeight,'the order button is on screen');
 assert.equal(await page.locator('.ext-desk [data-desk-pick]').count(),1,'upload is the main action');
 assert.equal(await page.locator('.ext-desk [data-desk-record]').count(),1,'recording is still offered');
 assert.equal(await page.locator('.ext-desk-opt').count(),3,'delivery choices are in the panel');
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),true);
 assert.match(await page.locator('.ext-desk-status').innerText(),/video walkaround/i,'what is missing is said next to the order button');
 assert.match(await page.locator('.ext-desk-need').first().innerText(),/Needed/);
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.ready()),false);
});

test('several clips upload at once with per-file status, retry, remove and reassignment, then the order can be placed',async t=>{
 const {page,uploads,confirm,settle,hold}=await setup(t,{fail:(name,attempt)=>name==='IMG_0002.MOV'&&attempt===1});
 await confirm();await settle();
 const open=hold();
 const chooser=page.waitForEvent('filechooser');await page.locator('[data-desk-pick]').click();
 await (await chooser).setFiles([{name:'IMG_0001.MOV',mimeType:'video/quicktime',buffer:Buffer.alloc(40000,1)},{name:'IMG_0002.MOV',mimeType:'video/quicktime',buffer:Buffer.alloc(30000,2)},{name:'IMG_0003.JPG',mimeType:'image/jpeg',buffer:Buffer.alloc(9000,3)}]);
 await page.waitForFunction(()=>document.querySelectorAll('.ext-desk-file').length===3);
 assert.equal(await page.locator('.ext-desk-file.is-busy').count(),3,'each file shows its own progress');
 assert.match(await page.locator('.ext-desk-status').innerText(),/Waiting for/);
 assert.match(await page.locator('[data-desk-count]').innerText(),/3 files · 3 uploading/);
 open();
 await page.waitForFunction(()=>!document.querySelector('.ext-desk-file.is-busy'));
 assert.deepEqual(uploads.slice().sort(),['IMG_0001.MOV','IMG_0002.MOV','IMG_0003.JPG']);
 const failed=page.locator('.ext-desk-file.is-failed');
 assert.equal(await failed.count(),1);assert.match(await failed.innerText(),/could not be read/);
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),true,'a failed upload blocks ordering');
 await failed.locator('[data-desk-retry]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.ext-desk-file.is-done').length===3);
 assert.deepEqual(await page.locator('.ext-desk-file select').evaluateAll(s=>s.map(e=>e.value)),['0:walk','0:walk','0:extra'],'clips are walkarounds and photos are close-ups');
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),false);
 // Moving both clips to close-ups leaves no walkaround: ordering stops and says why.
 for(let i=0;i<2;i++)await page.locator('.ext-desk-file select').nth(i).selectOption('0:extra');
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),true);assert.match(await page.locator('.ext-desk-status').innerText(),/video walkaround/i);
 await page.locator('.ext-desk-file select').nth(0).selectOption('0:walk');
 await page.locator('.ext-desk-file').nth(1).locator('[data-desk-remove]').click();
 assert.equal(await page.locator('.ext-desk-file').count(),2);
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.ready()),true);
 const refs=await page.evaluate(()=>JSON.parse(Portal.ExteriorOrder.payload().exterior_references).map(r=>r.view));
 assert.deepEqual(refs.sort(),['additional','orbital_video']);
 await page.locator('.ext-desk-opt').nth(2).click();
 assert.match(await page.locator('.ext-desk-total').innerText(),/\$35/);
 await page.locator('.ext-desk-order').click();
 assert.equal(await page.evaluate(()=>window.submitted),1);
});

test('two structures: a drop on a row goes to that structure, and the photo fallback keeps its angle grid in the panel',async t=>{
 const {page,confirm,settle}=await setup(t,{count:2,width:1280,height:800});
 await confirm();await settle();
 assert.equal(await page.locator('.ext-desk-need[data-desk-drop-structure]').count(),2);
 assert.match(await page.locator('.ext-desk-target').innerText(),/Structure 1/);
 await page.evaluate(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(5000)],'garage.mp4',{type:'video/mp4'}));const row=document.querySelector('[data-desk-drop-structure="1"]');for(const type of ['dragenter','dragover','drop'])row.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data}));});
 await page.waitForFunction(()=>document.querySelector('.ext-desk-file.is-done'));
 assert.equal(await page.locator('.ext-desk-file select').inputValue(),'1:walk');
 assert.match(await page.locator('.ext-desk-total').innerText(),/2 structures/);
 await page.locator('[data-desk-mode=photos]').click();
 assert.equal(await page.locator('.ext-desk-cell').count(),8);
 assert.equal(await page.locator('.ext-desk-pills .ext-structure-pill').count(),2);
 const box=await layout(page);assert.equal(box.pageScrolls,false);assert.deepEqual(box.clipped,[]);
 const chooser=page.waitForEvent('filechooser');await page.locator('[data-desk-pick]').click();
 await (await chooser).setFiles([{name:'IMG_2001.JPG',mimeType:'image/jpeg',buffer:Buffer.alloc(9000,4)}]);
 await page.waitForFunction(()=>document.querySelector('.ext-desk-file select.needs-choice'));
 assert.match(await page.locator('.ext-desk-status').innerText(),/unassigned/,'a loose photo needs an angle before ordering');
 await page.locator('.ext-desk-file select.needs-choice').selectOption('0:front');
 assert.equal(await page.locator('[data-desk-angle="0:front"].has-file').count(),1);
});

test('unconfirming folds the panel away and gives the tray back; mobile never sees the panel',async t=>{
 const {page,confirm,settle}=await setup(t);
 await confirm();await settle();
 await page.locator('[data-desk-pins]').click();
 await page.evaluate(()=>Portal.ExteriorOrder.sync(ctx));
 await page.waitForFunction(()=>!document.querySelector('.ext-desk')?.isConnected);
 assert.equal(await page.evaluate(()=>ctx.locationConfirmed),false);
 assert.equal(await page.locator('.fm-project-tray-tabs [data-tray]').getAttribute('aria-selected'),'true');
 const mobile=await setup(t,{width:390,height:844,mobileOrder:true});
 await mobile.confirm();
 assert.equal(await mobile.page.locator('.ext-desk').count(),0);
});
