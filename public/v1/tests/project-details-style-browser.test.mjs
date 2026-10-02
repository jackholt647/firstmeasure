import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const read=name=>readFile(new URL('../../libraries/'+name,import.meta.url),'utf8');
test('preloaded and loaded project pills have identical geometry, typography and colors',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage();const app=await read('apps/project-request/app.js');
 const css=app.slice(app.indexOf('  const css = `')+15,app.indexOf('`;',app.indexOf('  const css = `')));
 await page.setContent('<main class="main"></main>');await page.addStyleTag({content:'*{box-sizing:border-box}'+css});
 for(const f of ['window-manager/window-manager.js','window-manager/window-shell.js','window-manager/project-windows.js'])await page.addScriptTag({content:await read(f)});
 await page.evaluate(()=>{window.Portal={};crypto.randomUUID=()=>"style-test";FirstMateProjectWindows.open({id:'p',address:'123 Main'});});
 const pills='<button class="r-project-tag status stage-editable"><i class="fas fa-circle-dot"></i><span>New Lead</span><i class="fas fa-chevron-down"></i></button><div class="r-project-tag total"><span>$0</span></div><div class="r-project-tag property-type"><button class="r-property-type-trigger"><span>Residential</span></button></div>';
 await page.evaluate(html=>{document.querySelector('.fm-project-window-loading').innerHTML='<div class="r-window-identity fm-shell-identity"><div class="r-project-tags">'+html+'</div></div>';const loaded=document.createElement('section');loaded.id='loaded';loaded.className='fm-entity-window';loaded.innerHTML='<div class="r-window-identity fm-shell-identity"><div class="r-project-tags">'+html+'</div></div>';document.body.append(loaded);},pills);
 const values=selector=>page.locator(selector+' :is(.r-project-tag,.r-property-type-trigger)').evaluateAll(els=>els.map(el=>{const c=getComputedStyle(el);return ['height','width','borderRadius','padding','fontSize','fontWeight','lineHeight','minHeight','gap','color','backgroundColor','borderColor'].map(key=>c[key]);}));
 assert.deepEqual(await values('.fm-project-window-loading'),await values('#loaded'));
 }finally{await browser.close();}
});
test('Notes keeps the original composer layout with permanent full-height history and functional visibility',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage();await page.setContent('<main style="width:360px;height:650px"></main>');
 await page.evaluate(()=>{window.Portal={};window.__APP={};});
 await page.addScriptTag({content:await read('project-notes/project-notes.js')});
 await page.evaluate(()=>Portal.ProjectNotes.mount(document.querySelector('main'),{getProject:()=>null}));
 const heading=await page.locator('.pn-composer-head').boundingBox(),input=await page.getByRole('textbox',{name:'New project note'}).boundingBox();
 assert.ok(heading.y<input.y);assert.ok((await page.locator('.pn-history').boundingBox()).height>400);
 assert.equal(await page.locator('.pn-composer textarea').evaluate(el=>getComputedStyle(el).borderRadius),'12px');
 await page.getByRole('combobox',{name:'Note visibility'}).selectOption('crew');
 assert.equal(await page.locator('[data-visibility-label]').textContent(),'Crew');
 assert.equal(await page.getByRole('button',{name:'Add pinned note'}).isVisible(),true);
 }finally{await browser.close();}
});


test('narrow Overview keeps phone shortcuts inside the column and uses equal action tiles',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage();const app=await read('apps/project-request/app.js');
 const css=app.slice(app.indexOf('  const css = `')+15,app.indexOf('`;',app.indexOf('  const css = `')));
 await page.setContent('<section class="r-overview-details" style="width:253px;padding:12px"><div class="r-scroll"><div class="r-contact-card"><div class="r-inline"><div class="r-group"><input class="r-inp" value="Contact"></div><div class="r-group r-contact-shortcut-field"><input class="r-inp" value="1234567890"><span data-identity-actions><button data-contact-shortcut="call">C</button><button data-contact-shortcut="sms">M</button></span></div></div></div><div class="r-overview-initial-actions"><button class="r-toggle-btn">Order report</button><button class="r-toggle-btn">Build proposal</button><button class="r-toggle-btn">Schedule appointment</button></div></div></section>');
 await page.addStyleTag({content:'*{box-sizing:border-box}'+css});
 assert.equal(await page.locator('.r-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
 const sizes=await page.locator('.r-overview-initial-actions button').evaluateAll(es=>es.map(e=>[e.getBoundingClientRect().width,e.getBoundingClientRect().height]));
 assert.deepEqual(sizes[0],sizes[1]);assert.deepEqual(sizes[1],sizes[2]);
 }finally{await browser.close();}
});
