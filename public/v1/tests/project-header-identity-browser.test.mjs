import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const source=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');

test('project restore animates visible geometry; title does not open placement, Dock still does',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1200,height:800}});
 await page.setContent('<main style="position:relative;width:1100px;height:750px"><section id="win"><header><button id="identity">Project details</button><span id="title">Address</span></header></section></main>');
 await page.addScriptTag({content:await readFile(new URL('../../libraries/window-manager/window-manager.js',import.meta.url),'utf8')});
 await page.evaluate(()=>{window.w=FirstMateWindows.attach({element:document.querySelector('#win'),header:document.querySelector('header'),title:document.querySelector('#title'),host:document.querySelector('main'),mode:'modal',viewportCoordinates:true,presentationModes:true,titleMenu:false,animateGeometry:true});});
 await page.locator('#title').click();assert.equal(await page.locator('.fm-window-menu').count(),0);
 await page.locator('header').click({button:'right'});assert.equal(await page.locator('.fm-window-menu').count(),0);
 await page.locator('[data-window-action=place]').click({button:'right'});assert.equal(await page.locator('.fm-window-menu').count(),1);
 await page.keyboard.press('Escape');
 await page.evaluate(()=>w.setMode('minimized'));
 await page.waitForFunction(()=>document.querySelector('#win').getAnimations().length===0);
 const min=await page.locator('#win').boundingBox();
 await page.evaluate(()=>w.restore());
 assert.equal(await page.locator('#win').evaluate(el=>el.getAnimations().some(a=>a.effect.getKeyframes()[0].transform.includes('scale'))),true);
 await page.waitForTimeout(70);
 const mid=await page.locator('#win').boundingBox();assert.ok(mid.width>min.width+10 && mid.width<1152-1,JSON.stringify({min,mid}));
 await page.waitForFunction(()=>document.querySelector('#win').getAnimations().length===0);
 assert.ok((await page.locator('#win').boundingBox()).width>1100);
 await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{w.setMode('minimized');w.restore();});assert.equal(await page.locator('#win').evaluate(el=>el.getAnimations().length),0);
 }finally{await browser.close();}
});

test('identity popover retains controls and edits, returns them on Escape, stage is anchored below header',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1000,height:700}});
 await page.setContent('<div id="rOverlay"><header style="height:36px;display:flex;align-items:center"><button id="rProjectIdentityTrigger">Jane Doe · 123 Main</button><button id="stage">New lead</button></header><form id="rForm"><div class="r-group"><div id="rContactList"><div class="r-contact-card primary"><div class="r-inline"><div class="r-group"><input data-field="name" value="Jane Doe"></div><div class="r-group"><label>Phone</label><input data-field="phone" value="5551234567"></div></div><div class="r-contact-email-row"><div class="r-group"><label>Email</label><input data-field="email" value="jane@example.test"></div></div></div></div><button id="rAddContact" type="button">Add contact</button></div><section id="rStepAddress"><input id="rAddress" value="123 Main"></section></form></div>');
 const css=source.slice(source.indexOf('    .r-window-identity.fm-shell-identity'),source.indexOf('    .r-window-identity>i{'));
 await page.addStyleTag({content:'.r-group{display:flex;flex-direction:column}.r-inline{display:grid}.r-contact-email-row{display:grid}.r-contact-card label{display:none}'+css});
 await page.evaluate(()=>{window.branchProjectConfig={title_mode:'manual'};window.activeBaseProject={title:'Renovation'};window.projectTitleAlias=p=>p.title;window.closeHeaderPropertyTypeMenu=()=>{};window.escapeHtml=s=>String(s);window.cleanStageText=s=>s;window.projectManualStageContexts=()=>[{planId:'one',board:{id:'one',title:'Sales'},column:{id:'lead'},columns:[{id:'lead',title:'New lead'},{id:'won',title:'Won'}]}];window.original=document.querySelector('#rAddress');window.edits=0;original.addEventListener('input',()=>edits++);});
 const functions=source.slice(source.indexOf('  let projectIdentityPopover=null;'),source.indexOf('  function projectHeaderPillHtml('));
 await page.addScriptTag({content:functions+'\nbindProjectIdentityHeader();document.querySelector("#stage").onclick=e=>openManualStagePicker(e.currentTarget);'});
 await page.locator('#rProjectIdentityTrigger').click();
 assert.equal(await page.locator('#rAddress').evaluate(el=>el===original),true);
 assert.equal(await page.locator('.r-project-identity-popover>header').count(),0);
 for(const name of ['Call contact','Message contact','Email contact'])assert.equal(await page.getByRole('button',{name,exact:true}).isVisible(),true);
 assert.equal(await page.locator('.r-project-identity-popover .r-contact-card').evaluate(el=>getComputedStyle(el).borderWidth),'0px');
 const phone=await page.locator('[data-field=phone]').boundingBox(),call=await page.getByRole('button',{name:'Call contact',exact:true}).boundingBox();assert.ok(call.x>phone.x && Math.abs(call.y-phone.y)<8,'actions align beside the input');
 const name=await page.locator('[data-field=name]').boundingBox();assert.ok(phone.x>name.x && Math.abs(phone.y-name.y)<2,'name and phone share a row: '+JSON.stringify({name,phone}));
 assert.equal(await page.locator('.r-contact-card').evaluate(el=>getComputedStyle(el).paddingBottom),'0px','no duplicate gap above the address divider');
 assert.ok((await page.locator('.r-project-identity-popover').boundingBox()).y>=36);
 await page.locator('#rAddress').fill('456 Oak');assert.equal(await page.evaluate(()=>edits),1);
 await page.keyboard.press('Escape');assert.equal(await page.locator('.r-project-identity-popover').count(),0);
 assert.equal(await page.locator('#rForm #rAddress').inputValue(),'456 Oak');
 await page.locator('#stage').click();assert.equal(await page.locator('.r-header-stage-popover').count(),1);
 assert.equal(await page.locator('.r-manual-stage-dialog').getAttribute('aria-modal'),'false');
 assert.equal(await page.locator('.r-header-stage-popover .r-manual-stage-head').count(),0);
 assert.ok((await page.locator('.r-header-stage-popover').boundingBox()).y>=36);
 assert.equal(await page.locator('.r-header-stage-popover').evaluate(e=>getComputedStyle(e).position),'fixed');
 await page.keyboard.press('Escape');assert.equal(await page.locator('.r-header-stage-popover').count(),0);
 }finally{await browser.close();}
});

test('header identity deduplicates address and contact, retaining a distinct manual title',()=>{
 const body=source.slice(source.indexOf('  function projectHeaderIdentityHtml('),source.indexOf('  let projectIdentityPopover=null;'));
 const render=new Function('escapeHtml',body+';return projectHeaderIdentityHtml;')(s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;'));
 assert.equal(render('123 Main','','123 Main'),'<strong>123 Main</strong>');
 assert.equal(render('Jane','Jane','123 Main'),'<strong>Jane</strong><span class="r-project-identity-secondary">123 Main</span>');
 assert.equal(render('Renovation','Jane','123 Main'),'<strong>Renovation</strong><span class="r-project-identity-secondary">Jane</span><span class="r-project-identity-secondary">123 Main</span>');
 assert.ok(render('<test>','','').includes('&lt;test>'));
});
