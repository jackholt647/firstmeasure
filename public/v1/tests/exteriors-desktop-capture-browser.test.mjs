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

// "Use as" is the platform dropdown: a button that opens a listbox. Pick by clicking an option.
const role=page=>page.locator('.ext-desk-file [data-desk-role]');
async function chooseRole(page,control,value){
 await control.click();
 const option=page.locator(`.ext-desk-role-pop [role=option][data-value="${value}"]`);await option.waitFor();await option.click();
 await page.waitForFunction(()=>!document.querySelector('.ext-desk-role-pop'));
}

const layout=page=>page.evaluate(()=>{
 const desk=document.querySelector('.ext-desk'),box=el=>el?.getBoundingClientRect();
 const clipped=[...desk.querySelectorAll('.ext-desk-mid > :not(.ext-desk-list),.ext-desk-mid > :not(.ext-desk-list) *,.ext-desk-side,.ext-desk-side *')].filter(el=>el.offsetParent&&el.scrollHeight>el.clientHeight+2&&getComputedStyle(el).overflowY!=='visible'&&!el.closest('.ext-orbit,.ext-model-scene,.ext-desk-house,.ext-desk-cell,.ext-camera,.ext-capture-heading')&&!el.matches('select,.ext-desk-sr')).map(el=>el.className);
 return {desk:box(desk),host:box(desk.parentElement),side:box(desk.querySelector('.ext-desk-side')),order:box(desk.querySelector('.ext-desk-order')),pageScrolls:document.scrollingElement.scrollHeight>innerHeight+1||document.scrollingElement.scrollWidth>innerWidth+1,clipped,innerHeight};
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
 assert.ok(box.order.bottom<=box.innerHeight,'the order button is on screen');
 assert.equal(await page.locator('.ext-desk [data-desk-pick]').count(),1,'upload is the main action');
 assert.equal(await page.locator('.ext-desk [data-desk-record]').count(),1,'recording is still offered');
 assert.equal(await page.locator('.ext-desk-side .r-expedite-btn').count(),3,'delivery choices sit in the ordering column');
 assert.ok(box.side.width>=300&&box.side.x>box.desk.x+box.desk.width/2,'ordering is its own right-hand column');
 assert.equal(await page.locator('.ext-desk-foot').count(),0,'there is no footer bar');
 assert.equal(await page.locator('.ext-desk-mid .ext-orbit').count(),1,'the walkaround animation and steps lead the middle column');
 assert.equal(await page.locator('.ext-desk-drop').count(),1,'one upload strip');
 assert.equal(await page.locator('.ext-desk-drop').evaluate(e=>/MB/.test(e.innerText)),false,'limits live in a tooltip');
 assert.match(await page.locator('.ext-desk-drop .ext-desk-tip').getAttribute('data-fm-tooltip'),/120 MB/);
 assert.ok((await page.locator('.ext-desk-drop').boundingBox()).height<70,'the upload strip is thin');
 // Middle column: title, one-line lead, then the animation and steps, then the upload strip, with no headings between.
 assert.equal(await page.locator('.ext-desk-title h2').innerText(),'Add a video walkaround');
 assert.equal(await page.locator('.ext-desk-title p').innerText(),'Record one full loop around the house on your phone or tablet, then upload it here.');
 const mid=await page.evaluate(()=>{const m=document.querySelector('.ext-desk-mid');return {order:[...m.children].filter(e=>e.offsetParent&&e.getBoundingClientRect().height>0).map(e=>e.className.split(' ')[0]),headings:[...m.querySelectorAll('h3,h4,h5,h6')].filter(e=>e.offsetParent).map(e=>e.innerText),text:m.innerText};});
 assert.deepEqual(mid.order.slice(0,3),['ext-desk-head','ext-desk-guide','ext-desk-drop'],JSON.stringify(mid.order));
 assert.deepEqual(mid.headings,[],'no section headings in the middle column');
 assert.doesNotMatch(mid.text,/FirstMate app|How to film|What we need|Your uploads/i);
 assert.equal(await page.locator('.ext-desk [data-add-walk], .ext-desk [data-add-closeup], .ext-desk-need').count(),0,'no separate walkaround and close-up rows');
 assert.equal(await page.locator('.ext-desk [data-desk-record]').getAttribute('aria-label'),'Record','recording keeps its name when the strip is narrow');
 // Right column, top to bottom: what is ordered, delivery, total, what is missing, the order button.
 const side=await page.evaluate(()=>['.ext-desk-what','.r-expedite-options','.ext-desk-total','.ext-desk-status','.ext-desk-order'].map(sel=>Math.round(document.querySelector('.ext-desk-side '+sel).getBoundingClientRect().top)));
 assert.deepEqual(side,side.slice().sort((a,b)=>a-b),'the ordering column reads top to bottom: '+side);
 assert.equal(await page.locator('.ext-desk-side .r-expedite-btn').evaluateAll(b=>new Set(b.map(e=>Math.round(e.getBoundingClientRect().left))).size),1,'delivery choices are stacked');
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),true);
 assert.match(await page.locator('.ext-desk-status').innerText(),/video walkaround/i,'what is missing is said next to the order button');
 assert.match(await page.locator('.ext-desk-chip').first().innerText(),/Needs a video walkaround/);
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
 assert.match(await page.locator('.ext-desk-chip').first().innerText(),/uploading/i);
 open();
 await page.waitForFunction(()=>!document.querySelector('.ext-desk-file.is-busy'));
 assert.deepEqual(uploads.slice().sort(),['IMG_0001.MOV','IMG_0002.MOV','IMG_0003.JPG']);
 const failed=page.locator('.ext-desk-file.is-failed');
 assert.equal(await failed.count(),1);assert.match(await failed.innerText(),/could not be read/);
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),true,'a failed upload blocks ordering');
 await failed.locator('[data-desk-retry]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.ext-desk-file.is-done').length===3);
 assert.deepEqual(await role(page).evaluateAll(s=>s.map(e=>e.dataset.value)),['0:walk','0:walk','0:extra'],'clips are walkarounds and photos are close-ups');
 assert.equal(await page.locator('.ext-desk-file select').count(),0,'no native select');
 assert.equal(await role(page).first().getAttribute('aria-haspopup'),'listbox');
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),false);
 // Moving both clips to close-ups leaves no walkaround: ordering stops and says why.
 for(let i=0;i<2;i++)await chooseRole(page,role(page).nth(i),'0:extra');
 assert.equal(await page.locator('.ext-desk-order').isDisabled(),true);assert.match(await page.locator('.ext-desk-status').innerText(),/video walkaround/i);
 // The keyboard works as on a select: an arrow opens the list on the current choice, arrows move, Enter picks.
 await role(page).nth(0).focus();await page.keyboard.press('ArrowDown');
 await page.locator('.ext-desk-role-pop').waitFor();
 assert.equal(await role(page).nth(0).getAttribute('aria-expanded'),'true');
 assert.deepEqual(await page.locator('.ext-desk-role-pop [role=option]').evaluateAll(o=>o.map(e=>[e.dataset.value,e.getAttribute('aria-selected')])),[['0:walk','false'],['0:extra','true']]);
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('.ext-desk-role-pop'));
 assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-desk-role]')),true,'Escape closes and keeps focus on the control');
 await page.keyboard.press('Enter');await page.locator('.ext-desk-role-pop').waitFor();
 await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>!document.querySelector('.ext-desk-role-pop'));
 assert.deepEqual(await role(page).evaluateAll(s=>s.map(e=>e.dataset.value)).then(v=>v.sort()),['0:extra','0:extra','0:walk'],'Enter picks the highlighted choice');
 await page.keyboard.press('Space');await page.locator('.ext-desk-role-pop').waitFor();
 await page.keyboard.press('Space');await page.waitForTimeout(150);
 assert.equal(await page.locator('.ext-desk-role-pop').count(),0,'Space picks and the list stays closed');
 await page.locator('.ext-desk-file').nth(1).locator('[data-desk-remove]').click();
 assert.equal(await page.locator('.ext-desk-file').count(),2);
 assert.equal(await page.evaluate(()=>Portal.ExteriorOrder.ready()),true);
 const refs=await page.evaluate(()=>JSON.parse(Portal.ExteriorOrder.payload().exterior_references).map(r=>r.view));
 assert.deepEqual(refs.sort(),['additional','orbital_video']);
 await page.locator('.ext-desk-side .r-expedite-btn').nth(2).click();
 assert.match(await page.locator('.ext-desk-total').innerText(),/\$35/);
 await page.locator('.ext-desk-order').click();
 assert.equal(await page.evaluate(()=>window.submitted),1);
});

test('two structures: a drop on a row goes to that structure, and the photo fallback keeps its angle grid in the panel',async t=>{
 const {page,confirm,settle}=await setup(t,{count:2,width:1280,height:800});
 await confirm();await settle();
 assert.equal(await page.locator('.ext-desk-chip[data-desk-drop-structure]').count(),2);
 assert.match(await page.locator('.ext-desk-chip.is-target').innerText(),/Structure 1 needs a walkaround/);
 assert.match(await page.locator('.ext-desk-drop-label').innerText(),/Structure 1/);
 await page.evaluate(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(5000)],'garage.mp4',{type:'video/mp4'}));const row=document.querySelector('[data-desk-drop-structure="1"]');for(const type of ['dragenter','dragover','drop'])row.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data}));});
 await page.waitForFunction(()=>document.querySelector('.ext-desk-file.is-done'));
 assert.equal(await role(page).getAttribute('data-value'),'1:walk');
 assert.equal(await role(page).innerText(),'Structure 2 · Walkaround','with several structures the closed menu names the structure');
 await role(page).click();
 assert.deepEqual(await page.locator('.ext-desk-role-pop .ext-desk-role-group').allInnerTexts().then(t=>t.map(x=>x.toLowerCase())),['structure 1','structure 2'],'the open list groups the choices by structure');
 await page.keyboard.press('Escape');
 assert.match(await page.locator('.ext-desk-total').innerText(),/2 structures/);
 await page.locator('[data-desk-mode=photos]').click();
 assert.equal(await page.locator('.ext-desk-cell').count(),8);
 assert.ok((await page.locator('.ext-desk-grid').boundingBox()).width>300,'the angle grid uses the column width');
 assert.equal(await page.locator('.ext-desk-pills .ext-structure-pill').count(),2);
 const box=await layout(page);assert.equal(box.pageScrolls,false);assert.deepEqual(box.clipped,[]);
 const chooser=page.waitForEvent('filechooser');await page.locator('[data-desk-pick]').click();
 await (await chooser).setFiles([{name:'IMG_2001.JPG',mimeType:'image/jpeg',buffer:Buffer.alloc(9000,4)}]);
 await page.waitForFunction(()=>document.querySelector('.ext-desk-file [data-desk-role].needs-choice'));
 assert.match(await page.locator('.ext-desk-status').innerText(),/unassigned/,'a loose photo needs an angle before ordering');
 await chooseRole(page,page.locator('.ext-desk-file [data-desk-role].needs-choice'),'0:front');
 assert.equal(await page.locator('[data-desk-angle="0:front"].has-file').count(),1);
});

test('a long upload list scrolls on its own and keeps the newest file in view at 1280x800',async t=>{
 const {page,confirm,settle}=await setup(t,{width:1280,height:800});
 await confirm();await settle();
 const chooser=page.waitForEvent('filechooser');await page.locator('[data-desk-pick]').click();
 await (await chooser).setFiles(Array.from({length:8},(_,i)=>({name:`IMG_10${i}.JPG`,mimeType:'image/jpeg',buffer:Buffer.alloc(4000,i)})));
 await page.waitForFunction(()=>document.querySelectorAll('.ext-desk-file.is-done').length===8);
 const view=await page.evaluate(()=>{const list=document.querySelector('.ext-desk-list'),last=[...list.children].at(-1),order=document.querySelector('.ext-desk-order');return {scrolls:list.scrollHeight>list.clientHeight,lastBottom:last.getBoundingClientRect().bottom,listBottom:list.getBoundingClientRect().bottom,orderBottom:order.getBoundingClientRect().bottom,page:document.scrollingElement.scrollHeight>innerHeight+1};});
 assert.equal(view.scrolls,true);assert.equal(view.page,false,'only the list scrolls');
 assert.ok(view.lastBottom<=view.listBottom+1,'the newest file is in view');
 assert.ok(view.orderBottom<=800,'the order button stays on screen');
});

// Real, distinct images so the photo viewer shows something (drawn in the page, returned as PNG files).
async function photoFiles(page,count){
 const urls=await page.evaluate(count=>Array.from({length:count},(_,i)=>{const c=document.createElement('canvas');c.width=640;c.height=480;const g=c.getContext('2d');g.fillStyle=`hsl(${i*41},55%,48%)`;g.fillRect(0,0,640,480);g.fillStyle='#fff';g.fillRect(170,190,300,200);g.fillStyle='#333';g.beginPath();g.moveTo(150,200);g.lineTo(320,90);g.lineTo(490,200);g.fill();g.font='bold 54px Arial';g.fillText('IMG '+(i+1),220,320);return c.toDataURL('image/png');}),count);
 return urls.map((url,i)=>({name:`IMG_20${String(i+1).padStart(2,'0')}.PNG`,mimeType:'image/png',buffer:Buffer.from(url.split(',')[1],'base64')}));
}
async function photosPanel(t,options){
 const env=await setup(t,options);const {page,confirm,settle}=env;
 // The order window stacks like the platform's, so anything opened from the panel has to rise above it.
 await page.evaluate(()=>{document.getElementById('rOverlay').style.cssText='position:fixed;inset:0;z-index:2147483100;overflow:hidden';});
 await confirm();await settle();
 await page.locator('[data-desk-mode=photos]').click();await settle();
 return env;
}
async function uploadPhotos(page,count){
 const chooser=page.waitForEvent('filechooser');await page.locator('[data-desk-pick]').click();
 await (await chooser).setFiles(await photoFiles(page,count));
 await page.waitForFunction(count=>document.querySelectorAll('.ext-desk-file.is-done').length===count,count);
}
// Every option of the open list sits on screen and is the element a click there would hit.
const reachable=page=>page.evaluate(()=>{
 const pop=document.querySelector('.ext-desk-role-pop');
 return [...pop.querySelectorAll('[role=option]')].map(o=>{
  o.scrollIntoView({block:'nearest'});const r=o.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
  const hit=document.elementFromPoint(x,y);
  return {value:o.dataset.value,ok:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth&&!!hit&&o.contains(hit)};
 });
});

for(const [width,height] of [[1280,800],[1440,640]])test(`photo orders: the angle dropdown on every row, the last one included, opens where each option can be picked at ${width}x${height}`,async t=>{
 const {page,settle}=await photosPanel(t,{width,height});
 assert.equal(await page.locator('.ext-desk-risk').count(),0,'no "photos alone may not be enough" line under the angle grid');
 assert.doesNotMatch(await page.locator('.ext-desk-guide').innerText(),/may not be enough/i);
 assert.equal(await page.locator('.ext-desk-angles-foot [data-desk-mode=video]').count(),1,'the switch to video walkaround stays');
 await uploadPhotos(page,9);await settle();
 assert.equal(await page.evaluate(()=>{const l=document.querySelector('.ext-desk-list');return l.scrollHeight>l.clientHeight;}),true,'the upload list scrolls');
 const rows=await page.locator('.ext-desk-file').count();
 for(let i=rows-1;i>=0;i--){
  const control=role(page).nth(i);
  await control.click();await page.locator('.ext-desk-role-pop').waitFor();
  const options=await reachable(page);
  assert.equal(options.length,9,'eight angles and a close-up');
  assert.deepEqual(options.filter(o=>!o.ok).map(o=>o.value),[],`row ${i+1}: every option can be reached`);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.ext-desk-role-pop'));
 }
 // The last row: the mouse picks the bottom option, and the keyboard reaches the end of the list and picks it.
 await page.locator('.ext-desk-list').evaluate(l=>{l.scrollTop=l.scrollHeight;});
 const last=role(page).nth(rows-1);
 await chooseRole(page,last,'0:front-right');
 assert.equal(await page.locator('[data-desk-angle="0:front-right"].has-file').count(),1,'the bottom angle was picked from the last row');
 const control=page.locator('.ext-desk-file [data-desk-role].needs-choice').last();
 const name=await page.locator('.ext-desk-file:has([data-desk-role].needs-choice)').last().locator('[data-desk-name]').innerText();
 await control.focus();await page.keyboard.press('ArrowDown');await page.locator('.ext-desk-role-pop').waitFor();
 await page.keyboard.press('End');
 const end=await page.evaluate(()=>{const o=document.querySelector('.ext-desk-role-pop .is-active'),r=o.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {value:o.dataset.value,visible:r.top>=0&&r.bottom<=innerHeight&&o.contains(hit)};});
 assert.deepEqual(end,{value:'0:extra',visible:true},'End highlights the bottom option where it can be seen');
 await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>!document.querySelector('.ext-desk-role-pop'));
 assert.equal(await page.evaluate(()=>Portal.test.files.get('0:front-right')?.name),name,'the keyboard picked the option above the end');
});

test('photo orders: a photo opens large over the order window, shows its name and angle, steps through the photos and changes the angle',async t=>{
 const {page,settle}=await photosPanel(t,{width:1280,height:800});
 await uploadPhotos(page,9);await settle();
 await chooseRole(page,role(page).nth(0),'0:front');
 const tile=page.locator('.ext-desk-grid [data-desk-preview="0:front"]');
 assert.equal(await tile.getAttribute('aria-label'),'View Front photo');
 await tile.click();
 const viewer=page.locator('dialog.ext-photo-viewer[open]');await viewer.waitFor();
 const top=await page.evaluate(()=>{const img=document.querySelector('.ext-photo-viewer [data-viewer-img]'),r=img.getBoundingClientRect();return {modal:document.querySelector('.ext-photo-viewer').matches(':modal'),onTop:!!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.ext-photo-viewer'),large:r.width>500,loaded:img.complete&&img.naturalWidth===640};});
 assert.deepEqual(top,{modal:true,onTop:true,large:true,loaded:true},'the viewer is a modal dialog above the order window showing the full photo');
 assert.equal(await viewer.getAttribute('aria-labelledby'),'extViewerName');
 assert.equal(await viewer.locator('#extViewerName').innerText(),'IMG_2001.PNG');
 assert.equal(await viewer.locator('[data-viewer-count]').innerText(),'Photo 1 of 9');
 assert.equal(await viewer.locator('[data-viewer-role]').innerText(),'Front');
 assert.equal(await page.evaluate(()=>document.activeElement?.matches('.ext-photo-viewer [data-viewer-close]')),true,'focus moves into the viewer');
 await page.keyboard.press('ArrowRight');
 assert.equal(await viewer.locator('#extViewerName').innerText(),'IMG_2002.PNG');
 assert.equal(await viewer.locator('[data-viewer-count]').innerText(),'Photo 2 of 9');
 assert.equal(await viewer.locator('[data-viewer-role]').innerText(),'Choose an angle…');
 await viewer.locator('[data-viewer-step="-1"]').click();
 assert.equal(await viewer.locator('#extViewerName').innerText(),'IMG_2001.PNG','the previous button steps back');
 await viewer.locator('[data-viewer-step="-1"]').click();
 assert.equal(await viewer.locator('#extViewerName').innerText(),'IMG_2009.PNG','stepping wraps around');
 // The angle is set right there, with the same dropdown, and the viewer stays on that photo.
 const control=viewer.locator('[data-desk-role]');
 await control.click();
 const option=page.locator('.ext-photo-viewer .ext-desk-role-pop [role=option][data-value="0:back"]');await option.waitFor();
 assert.equal(await option.evaluate(o=>{const r=o.getBoundingClientRect();return o.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),true,'the dropdown opens above the viewer');
 await option.click();
 await page.waitForFunction(()=>!document.querySelector('.ext-desk-role-pop'));
 assert.equal(await viewer.locator('[data-viewer-role]').innerText(),'Back');
 assert.equal(await page.locator('[data-desk-angle="0:back"].has-file').count(),1,'the angle grid shows the new assignment');
 assert.equal(await viewer.locator('#extViewerName').innerText(),'IMG_2009.PNG');
 // Escape closes the open dropdown first, then the viewer, and focus returns to the panel.
 await control.focus();await page.keyboard.press('ArrowDown');await page.locator('.ext-desk-role-pop').waitFor();
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.ext-desk-role-pop'));
 assert.equal(await page.locator('dialog.ext-photo-viewer[open]').count(),1,'Escape only closed the dropdown');
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('.ext-photo-viewer'));
 assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.ext-desk')),true,'focus returns to the panel');
 // A thumbnail in the upload list opens the viewer on that file; the close button dismisses it.
 await page.locator('.ext-desk-file').nth(4).locator('[data-desk-preview]').click();
 await viewer.waitFor();
 assert.equal(await viewer.locator('#extViewerName').innerText(),await page.locator('.ext-desk-file').nth(4).locator('[data-desk-name]').innerText());
 await viewer.locator('[data-viewer-close]').click();
 await page.waitForFunction(()=>!document.querySelector('.ext-photo-viewer'));
 assert.equal(await page.evaluate(()=>document.activeElement?.matches('.ext-desk-file [data-desk-preview]')),true,'focus returns to the thumbnail');
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
